import { useCallback, useEffect, useState } from 'react';
import { RULE_PRESETS, type Bot, type BotRule, type ComposioHint, type RuleAction, type RuleLogEntry, type RulePattern, type RulePreset } from '@orbit/contracts';
import { rulesApi } from '../lib/rulesApi';
import { relativeShort } from '../lib/time';
import { Icon } from './Icon';
import { Glyph } from './config/glyphs';
import { ConfirmButton, Segmented, Switch } from './config/ui';
import '../styles/rules.css';

const ACTIONS: { value: RuleAction; label: string }[] = [
  { value: 'ask', label: 'Ask me' },
  { value: 'block', label: 'Block' },
  { value: 'log', label: 'Log' },
];

const HINTS: { value: ComposioHint; label: string; verb: string }[] = [
  { value: 'createHint', label: 'Creates or sends', verb: 'create or send' },
  { value: 'updateHint', label: 'Changes', verb: 'change' },
  { value: 'destructiveHint', label: 'Deletes', verb: 'delete' },
];

type Kind = RulePattern['kind'];

/** What the editor holds while a rule is being written: every kind's fields as the person typed them. */
interface Draft {
  description: string;
  kind: Kind;
  action: RuleAction;
  tools: string;
  hints: ComposioHint[];
  toolkits: string;
  matchRegex: string;
}

const list = (text: string) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

const compiles = (source: string) => {
  try { new RegExp(source); return true; } catch { return false; }
};

/**
 * One entry per pattern kind: how it is offered, how a stored rule reads in plain words, and how the
 * editor's fields become a pattern. `build` answers with the problem to fix when the fields do not
 * make one yet.
 */
const KINDS: { [K in Kind]: { label: string; summary(p: Extract<RulePattern, { kind: K }>): string; build(d: Draft): RulePattern | string } } = {
  'composio-tool': {
    label: 'Connected-app tools',
    summary: (p) => `Connected-app tools: ${p.tools.join(', ')}`,
    build: (d) => {
      const tools = list(d.tools);
      if (!tools.length) return 'Name at least one tool.';
      if (tools.some((t) => !/^[A-Za-z0-9_*]+$/.test(t))) return 'Tool names use letters, digits, _ and * only.';
      return { kind: 'composio-tool', tools };
    },
  },
  'composio-hint': {
    label: 'Connected-app actions',
    summary: (p) => {
      const verbs = HINTS.filter((h) => p.hints.includes(h.value)).map((h) => h.verb).join(' or ');
      return `Connected-app tools that ${verbs}${p.toolkits?.length ? ` in ${p.toolkits.join(', ')}` : ''}`;
    },
    build: (d) => {
      if (!d.hints.length) return 'Pick at least one kind of action.';
      const toolkits = list(d.toolkits);
      return { kind: 'composio-hint', hints: d.hints, ...(toolkits.length ? { toolkits } : {}) };
    },
  },
  'computer-shell': {
    label: 'Shell commands',
    summary: (p) => (p.matchRegex === '.*' ? 'Every shell command on its computer' : `Shell commands matching ${p.matchRegex}`),
    build: (d) => {
      const matchRegex = d.matchRegex.trim();
      if (!matchRegex) return 'Write what the command should match.';
      if (!compiles(matchRegex)) return 'That is not a valid regular expression.';
      return { kind: 'computer-shell', matchRegex };
    },
  },
  always: {
    label: 'Everything',
    summary: () => 'Every tool call',
    build: () => ({ kind: 'always' }),
  },
};

const KIND_ORDER: Kind[] = ['composio-tool', 'composio-hint', 'computer-shell', 'always'];

export const describePattern = (p: RulePattern): string => (KINDS[p.kind].summary as (p: RulePattern) => string)(p);

const BLANK: Draft = { description: '', kind: 'composio-tool', action: 'ask', tools: '', hints: [], toolkits: '', matchRegex: '' };

const draftOf = (r: BotRule): Draft => ({
  ...BLANK,
  description: r.description,
  kind: r.pattern.kind,
  action: r.action,
  ...(r.pattern.kind === 'composio-tool' ? { tools: r.pattern.tools.join(', ') } : {}),
  ...(r.pattern.kind === 'composio-hint' ? { hints: r.pattern.hints, toolkits: (r.pattern.toolkits ?? []).join(', ') } : {}),
  ...(r.pattern.kind === 'computer-shell' ? { matchRegex: r.pattern.matchRegex } : {}),
});

/** How a log entry reads: what the rule does, crossed with what became of the call. */
const OUTCOME_LABEL: Record<RuleAction, Partial<Record<RuleLogEntry['outcome'], string>>> = {
  log: { ran: 'Logged' },
  ask: { ran: 'Allowed', denied: 'Not allowed', expired: 'Not answered' },
  block: { blocked: 'Blocked' },
};
const OUTCOME_FALLBACK: Record<RuleLogEntry['outcome'], string> = { ran: 'Ran', blocked: 'Blocked', denied: 'Not allowed', expired: 'Not answered' };
const outcomeLabel = (e: RuleLogEntry) => OUTCOME_LABEL[e.action][e.outcome] ?? OUTCOME_FALLBACK[e.outcome];

export function RulesPanel({ bot }: { bot: Bot }) {
  const [rules, setRules] = useState<BotRule[] | null>(null);
  const [log, setLog] = useState<RuleLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const load = useCallback(() => {
    rulesApi.list(bot.id)
      .then((r) => { setRules(r.rules); setLog(r.log); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [bot.id]);
  useEffect(() => { setRules(null); setEditing(null); load(); }, [load]);

  /** Run one change, then read the list back: the server's copy is the one shown. */
  const change = async (fn: () => Promise<unknown>) => {
    try { await fn(); setError(null); } catch (e) { setError((e as Error).message); }
    load();
  };

  const custom = rules?.filter((r) => r.preset === null) ?? [];

  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Rules</div>
          <div className="cfg-page__sub">What {bot.name} checks with you before it acts. A rule that asks or blocks wins over “Always allow”.</div>
        </div>
      </div>
      {error && <div className="cfg-error" role="alert">{error}</div>}

      <section className="cfg-section">
        <div className="cfg-section__label">Common rules</div>
        <div className="cfg-card">
          {RULE_PRESETS.map((p) => (
            <PresetRow
              key={p.id}
              preset={p}
              rule={rules?.find((r) => r.preset === p.id)}
              disabled={rules === null}
              onToggle={(rule) => change(() => (rule ? rulesApi.remove(bot.id, rule.id) : rulesApi.create(bot.id, { preset: p.id })))}
              onAction={(rule, action) => change(() => rulesApi.update(bot.id, rule.id, { action }))}
            />
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-page__head">
          <div className="cfg-section__label">Your rules</div>
          {editing !== 'new' && (
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> New rule</button>
          )}
        </div>
        {editing === 'new' && (
          <RuleEditor
            onCancel={() => setEditing(null)}
            onSave={async (d, pattern) => { await rulesApi.create(bot.id, { description: d.description.trim(), pattern, action: d.action }); setEditing(null); load(); }}
          />
        )}
        {rules === null ? <div className="cfg-empty">Loading…</div> : custom.length === 0 && editing !== 'new' ? (
          <div className="cfg-empty">No rules of your own yet. Write one for anything the common rules miss, like “Never force-push”.</div>
        ) : (
          <div className="cfg-list">
            {custom.map((r) => editing === r.id ? (
              <RuleEditor
                key={r.id}
                rule={r}
                onCancel={() => setEditing(null)}
                onSave={async (d, pattern) => { await rulesApi.update(bot.id, r.id, { description: d.description.trim(), pattern, action: d.action }); setEditing(null); load(); }}
              />
            ) : (
              <div key={r.id} className="cfg-item">
                <div className="cfg-item__text">
                  <div className="cfg-item__title">{r.description}</div>
                  <div className="cfg-item__sub" title={describePattern(r.pattern)}>{describePattern(r.pattern)}</div>
                </div>
                <div className="cfg-item__actions">
                  <Segmented label={`What “${r.description}” does`} value={r.action} options={ACTIONS} onChange={(action) => change(() => rulesApi.update(bot.id, r.id, { action }))} />
                  <button type="button" className="cfg-icon-btn" onClick={() => setEditing(r.id)} aria-label={`Edit ${r.description}`} title="Edit"><Icon name="edit" size={14} /></button>
                  <ConfirmButton className="cfg-icon-btn" title="Delete" onConfirm={() => change(() => rulesApi.remove(bot.id, r.id))}><Glyph name="trash" size={14} /></ConfirmButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Recent matches</div>
        {log.length === 0 ? (
          <div className="cfg-empty">Nothing yet. When a rule matches something {bot.name} tries to do, it shows up here.</div>
        ) : (
          <div className="cfg-card">
            {log.map((e) => (
              <div key={e.id} className="cfg-row rule-log">
                <span className={`cfg-chip rule-log__outcome is-${e.outcome}`}>{outcomeLabel(e)}</span>
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{e.ruleDescription}</div>
                  <div className="cfg-row__sub rule-log__detail" title={e.detail || e.tool}><code className="cfg-code">{e.tool}</code>{e.detail && e.detail !== e.tool ? ` · ${e.detail}` : ''}</div>
                </div>
                <span className="rule-log__when">{relativeShort(e.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PresetRow({ preset, rule, disabled, onToggle, onAction }: {
  preset: RulePreset;
  rule: BotRule | undefined;
  disabled: boolean;
  onToggle: (rule: BotRule | undefined) => void;
  onAction: (rule: BotRule, action: RuleAction) => void;
}) {
  return (
    <div className="cfg-row">
      <div className="cfg-row__text">
        <div className="cfg-row__title">{preset.description}</div>
        <div className="cfg-row__sub">{describePattern(preset.pattern)}</div>
      </div>
      {rule && <Segmented label={`What “${preset.description}” does`} value={rule.action} options={ACTIONS} onChange={(action) => onAction(rule, action)} />}
      <Switch on={!!rule} disabled={disabled} onChange={() => onToggle(rule)} label={preset.description} />
    </div>
  );
}

function RuleEditor({ rule, onSave, onCancel }: { rule?: BotRule; onSave: (draft: Draft, pattern: RulePattern) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => (rule ? draftOf(rule) : BLANK));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (!draft.description.trim()) { setError('Say what the rule is for.'); return; }
    const pattern = KINDS[draft.kind].build(draft);
    if (typeof pattern === 'string') { setError(pattern); return; }
    setBusy(true); setError(null);
    try { await onSave(draft, pattern); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <form className="cfg-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input className="text-input" placeholder="What the rule is for, e.g. Never force-push" value={draft.description} maxLength={200} onChange={(e) => put('description', e.target.value)} autoFocus aria-label="Rule description" />
      <Segmented label="What the rule looks at" value={draft.kind} options={KIND_ORDER.map((k) => ({ value: k, label: KINDS[k].label }))} onChange={(k) => put('kind', k)} />
      {draft.kind === 'composio-tool' && (
        <input className="text-input" placeholder="Tool names, e.g. GMAIL_SEND_EMAIL, SLACK_*" value={draft.tools} onChange={(e) => put('tools', e.target.value)} aria-label="Tool names" />
      )}
      {draft.kind === 'composio-hint' && (
        <>
          <div className="rule-checks" role="group" aria-label="Kinds of action">
            {HINTS.map((h) => (
              <label key={h.value} className="rule-check">
                <input type="checkbox" checked={draft.hints.includes(h.value)} onChange={(e) => put('hints', e.target.checked ? [...draft.hints, h.value] : draft.hints.filter((x) => x !== h.value))} />
                <span>{h.label}</span>
              </label>
            ))}
          </div>
          <input className="text-input" placeholder="Only in these apps, e.g. twitter, linkedin (optional)" value={draft.toolkits} onChange={(e) => put('toolkits', e.target.value)} aria-label="Apps" />
        </>
      )}
      {draft.kind === 'computer-shell' && (
        <input className="text-input rule-regex" placeholder="A regular expression, e.g. rm\s+-rf" value={draft.matchRegex} maxLength={300} onChange={(e) => put('matchRegex', e.target.value)} aria-label="Command pattern" spellCheck={false} />
      )}
      <Segmented label="What the rule does" value={draft.action} options={ACTIONS} onChange={(a) => put('action', a)} />
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <div className="cfg-editor__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy}>{busy ? 'Saving…' : rule ? 'Save rule' : 'Add rule'}</button>
      </div>
    </form>
  );
}
