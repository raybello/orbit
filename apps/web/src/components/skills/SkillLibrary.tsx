import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { GithubSkillInspect, LibrarySkill } from '@orbit/contracts';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { CodeEditor } from '../config/CodeEditor';
import { ConfirmButton, Switch } from '../config/ui';
import '../../styles/code-editor.css';

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

const TEMPLATE = `---
description: When to use this skill, in a sentence
---

# Steps

1.
2.
`;

/** Where a skill came from, as a short badge. */
function sourceBadge(s: LibrarySkill): { label: string; className: string } {
  if (s.source.type === 'github') return { label: 'GitHub', className: 'is-github' };
  if (s.createdBy.kind === 'bot') return { label: 'By a Bot', className: 'is-bot' };
  return { label: 'Written here', className: 'is-manual' };
}

const allowedCount = (s: LibrarySkill) => s.bots.filter((b) => b.allowed).length;

/**
 * The skill library: every skill on the left, the selected one on the right with where it came
 * from, which Bots have it, and its SKILL.md. "Add skill" swaps the right side for the add form.
 */
export function SkillLibraryPane({ adding, onAddingChange }: { adding: boolean; onAddingChange: (v: boolean) => void }) {
  const version = useStore((s) => s.skillsVersion);
  const [skills, setSkills] = useState<LibrarySkill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    configApi.skillLibrary()
      .then((r) => {
        if (!alive) return;
        setSkills(r.skills);
        setLoadError(null);
        setSelectedId((cur) => (cur && r.skills.some((s) => s.id === cur) ? cur : r.skills[0]?.id ?? null));
      })
      .catch((e) => { if (alive) setLoadError(errText(e)); });
    return () => { alive = false; };
  }, [version, reloadKey]);

  const replace = useCallback((next: LibrarySkill) => {
    setSkills((list) => (list ? (list.some((s) => s.id === next.id) ? list.map((s) => (s.id === next.id ? next : s)) : [...list, next].sort((a, b) => a.name.localeCompare(b.name))) : [next]));
  }, []);

  const selected = useMemo(() => skills?.find((s) => s.id === selectedId) ?? null, [skills, selectedId]);

  if (loadError) {
    return (
      <div className="skills-view__body">
        <div className="skills-state" role="alert">
          <div className="skills-state__title">Couldn’t load the skill library</div>
          <div className="skills-state__sub">{loadError}</div>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </div>
      </div>
    );
  }
  if (skills === null) return <div className="skills-view__body"><div className="skills-state"><div className="cfg-empty">Loading skills…</div></div></div>;

  return (
    <div className="skills-view__body">
      <div className="skills-view__panes">
        <div className="skills-list" role="group" aria-label="Skill library">
          {skills.length === 0 && !adding && (
            <div className="skills-state">
              <div className="skills-state__title">No skills yet</div>
              <div className="skills-state__sub">Write one, or install one from a GitHub repository. Bots can add skills too.</div>
            </div>
          )}
          {skills.map((s) => {
            const badge = sourceBadge(s);
            const active = !adding && s.id === selectedId;
            return (
              <button key={s.id} type="button" className={`skills-row${active ? ' is-active' : ''}`} aria-current={active ? 'true' : undefined}
                onClick={() => { onAddingChange(false); setSelectedId(s.id); }}>
                <span className="skills-row__top">
                  <span className="skills-row__name">/{s.name}</span>
                  <span className={`skills-badge ${badge.className}`}>{badge.label}</span>
                </span>
                <span className="skills-row__desc">{s.description}</span>
                <span className="skills-row__count">{allowedCount(s) === s.bots.length ? 'Every Bot' : `${allowedCount(s)} of ${s.bots.length} Bots`}</span>
              </button>
            );
          })}
        </div>
        <section className="skills-detail" aria-label={adding ? 'Add a skill' : 'Skill details'}>
          {adding ? (
            <AddSkill onDone={(s) => { onAddingChange(false); if (s) { replace(s); setSelectedId(s.id); } }} />
          ) : selected ? (
            <SkillDetail key={selected.id} skill={selected} onChange={replace} onDeleted={() => setSkills((l) => l?.filter((x) => x.id !== selected.id) ?? l)} />
          ) : skills.length > 0 ? (
            <div className="skills-state"><div className="skills-state__sub">Select a skill to see which Bots have it.</div></div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function Availability({ value, onChange, disabled }: { value: 'all' | 'selected'; onChange: (v: 'all' | 'selected') => void; disabled?: boolean }) {
  return (
    <div className="skills-seg" role="radiogroup" aria-label="Who has this skill">
      <button type="button" role="radio" aria-checked={value === 'all'} className={value === 'all' ? 'is-on' : ''} disabled={disabled} onClick={() => onChange('all')}>Every Bot</button>
      <button type="button" role="radio" aria-checked={value === 'selected'} className={value === 'selected' ? 'is-on' : ''} disabled={disabled} onClick={() => onChange('selected')}>Only the Bots I pick</button>
    </div>
  );
}

function Provenance({ skill }: { skill: LibrarySkill }) {
  const src = skill.source;
  return (
    <dl className="skills-meta">
      <dt>Source</dt>
      <dd>
        {src.type === 'github' ? (
          <a href={src.url} target="_blank" rel="noreferrer">{src.repo}{src.path ? `/${src.path}` : ''}</a>
        ) : skill.createdBy.kind === 'bot' ? 'Written by a Bot in chat' : 'Written in Orbit'}
      </dd>
      {src.type === 'github' && (
        <>
          <dt>Version</dt>
          <dd><code>{src.ref}</code> at <code>{src.commit.slice(0, 7)}</code></dd>
        </>
      )}
      <dt>Added by</dt>
      <dd>{skill.createdBy.kind === 'bot' ? `${skill.createdBy.name} (Bot)` : skill.createdBy.name}</dd>
      <dt>Updated</dt>
      <dd>{relativeShort(skill.updatedAt)}</dd>
    </dl>
  );
}

function SkillDetail({ skill, onChange, onDeleted }: { skill: LibrarySkill; onChange: (s: LibrarySkill) => void; onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(skill.content);

  const run = async (key: string, fn: () => Promise<{ skill: LibrarySkill }>) => {
    setPending(key); setError(null);
    try { onChange((await fn()).skill); return true; } catch (e) { setError(errText(e)); return false; } finally { setPending(null); }
  };

  return (
    <div className="skills-detail__inner">
      <div className="skills-detail__head">
        <div className="skills-detail__name">/{skill.name}</div>
        <div className="skills-detail__desc">{skill.description}</div>
      </div>
      <Provenance skill={skill} />

      <div className="skills-group">
        <div className="skills-group__label">Who has it</div>
        <Availability value={skill.availability} disabled={!!pending}
          onChange={(v) => void run('availability', () => configApi.updateSkill(skill.id, { availability: v }))} />
        <div className="cfg-field__hint">{skill.availability === 'all' ? 'New Bots get it too. Turn it off for any Bot that should not have it.' : 'Only the Bots turned on below have it. New Bots do not.'}</div>
        <div className="panel-card skills-bots">
          {skill.bots.map((b) => (
            <div key={b.botId} className="panel-row skills-bot">
              <span className="panel-row__text">
                <span className="panel-row__title">{b.botName}</span>
                <span className="panel-row__meta">{b.allowed ? `Can use /${skill.name}` : 'Turned off'}</span>
              </span>
              <Switch on={b.allowed} disabled={pending === b.botId} label={`${skill.name} for ${b.botName}`}
                onChange={(v) => void run(b.botId, () => configApi.setSkillAccess(skill.id, b.botId, v))} />
            </div>
          ))}
        </div>
      </div>

      <div className="skills-group">
        <div className="skills-group__head">
          <div className="skills-group__label">SKILL.md</div>
          {!editing && <button type="button" className="link-btn link-btn--small" onClick={() => { setDraft(skill.content); setEditing(true); }}>Edit</button>}
        </div>
        {editing ? (
          <>
            <CodeEditor label="SKILL.md" value={draft} onChange={setDraft}
              onSave={() => void run('content', () => configApi.updateSkill(skill.id, { content: draft })).then((ok) => ok && setEditing(false))} />
            <div className="skills-actions">
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={pending === 'content' || draft === skill.content}
                onClick={() => void run('content', () => configApi.updateSkill(skill.id, { content: draft })).then((ok) => ok && setEditing(false))}>
                {pending === 'content' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <pre className="skill-md" aria-label="SKILL.md">{skill.content}</pre>
        )}
      </div>

      {skill.files.length > 0 && (
        <div className="skills-group">
          <div className="skills-group__label">Files that came with it</div>
          <ul className="skill-files">{skill.files.map((f) => <li key={f.path}><code>{f.path}</code><span>{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</span></li>)}</ul>
        </div>
      )}

      {error && <div className="skills-inline-error" role="alert">{error}</div>}
      <div className="skills-actions">
        <ConfirmButton confirmLabel={`Delete /${skill.name}`} onConfirm={async () => {
          try { await configApi.deleteSkill(skill.id); onDeleted(); } catch (e) { setError(errText(e)); }
        }}>Delete skill</ConfirmButton>
      </div>
    </div>
  );
}

/** The add form: write a SKILL.md, or install one from GitHub (checked first, then installed). */
function AddSkill({ onDone }: { onDone: (s: LibrarySkill | null) => void }) {
  const bots = useStore((s) => s.bots).filter((b) => b.kind !== 'room');
  const [mode, setMode] = useState<'write' | 'github'>('write');
  const [name, setName] = useState('');
  const [content, setContent] = useState(TEMPLATE);
  const [availability, setAvailability] = useState<'all' | 'selected'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [inspect, setInspect] = useState<GithubSkillInspect | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { skill } = await configApi.createSkill({ name: name.trim(), content, availability, ...(availability === 'selected' ? { botIds: picked } : {}) });
      onDone(skill);
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  const check = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setInspect(null); setPick(null);
    try {
      const r = await configApi.inspectGithubSkill(source.trim());
      setInspect(r);
      setPick(r.candidates[0]?.path ?? null);
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  const install = async () => {
    if (!inspect || pick === null) return;
    setBusy(true); setError(null);
    try { onDone((await configApi.installGithubSkill(source.trim(), pick)).skill); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  return (
    <div className="skills-detail__inner">
      <div className="skills-detail__head">
        <div className="skills-detail__name">Add a skill</div>
        <div className="skills-detail__desc">Every Bot can use it as /name, unless you choose otherwise.</div>
      </div>
      <div className="skills-seg" role="tablist" aria-label="How to add it">
        <button type="button" role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'is-on' : ''} onClick={() => { setMode('write'); setError(null); }}>Write SKILL.md</button>
        <button type="button" role="tab" aria-selected={mode === 'github'} className={mode === 'github' ? 'is-on' : ''} onClick={() => { setMode('github'); setError(null); }}>From GitHub</button>
      </div>

      {mode === 'write' ? (
        <form className="skills-form" onSubmit={save}>
          <label className="skills-field">
            <span>Name</span>
            <input className="text-input" aria-label="Skill name" placeholder="weekly-report" value={name} maxLength={64} autoFocus spellCheck={false}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} />
            <span className="cfg-field__hint">Lowercase letters, digits and hyphens. Used as /{name || 'name'}.</span>
          </label>
          <div className="skills-field">
            <span>SKILL.md</span>
            <CodeEditor label="SKILL.md content" value={content} onChange={setContent} />
            <span className="cfg-field__hint">Frontmatter needs a description. The instructions follow it, in Markdown.</span>
          </div>
          <div className="skills-field">
            <span>Who has it</span>
            <Availability value={availability} onChange={setAvailability} />
            {availability === 'selected' && (
              <div className="app-access">
                {bots.map((b) => {
                  const on = picked.includes(b.id);
                  return (
                    <button key={b.id} type="button" className={`app-access__bot${on ? ' is-on' : ''}`} aria-pressed={on}
                      onClick={() => setPicked((p) => (on ? p.filter((x) => x !== b.id) : [...p, b.id]))}>{b.name}</button>
                  );
                })}
              </div>
            )}
          </div>
          {error && <div className="skills-inline-error" role="alert">{error}</div>}
          <div className="skills-actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => onDone(null)}>Cancel</button>
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add skill'}</button>
          </div>
        </form>
      ) : (
        <form className="skills-form" onSubmit={check}>
          <label className="skills-field">
            <span>Repository</span>
            <input className="text-input" aria-label="GitHub repository" placeholder="owner/repo, owner/repo/path/to/skill, or a github.com link" value={source} spellCheck={false}
              onChange={(e) => { setSource(e.target.value); setInspect(null); }} autoFocus />
            <span className="cfg-field__hint">A public repository with a SKILL.md (the Agent Skills format). It is checked before anything is installed, and the skill records the exact commit.</span>
          </label>
          {inspect && (
            <div className="skills-field">
              <span>{inspect.candidates.length === 1 ? 'Skill found' : `${inspect.candidates.length} skills found`} in {inspect.repo} at <code>{inspect.ref}</code> ({inspect.commit.slice(0, 7)})</span>
              <div className="panel-card skills-candidates" role="radiogroup" aria-label="Skill to install">
                {inspect.candidates.map((c) => (
                  <label key={c.path} className="panel-row skills-candidate">
                    <input type="radio" name="skill-pick" checked={pick === c.path} onChange={() => setPick(c.path)} />
                    <span className="panel-row__text">
                      <span className="panel-row__title">/{c.name}</span>
                      <span className="panel-row__meta">{c.description}</span>
                      <span className="panel-row__meta"><code>{c.path || '(repository root)'}</code>{c.files ? ` · ${c.files} file${c.files === 1 ? '' : 's'}` : ''}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {error && <div className="skills-inline-error" role="alert">{error}</div>}
          <div className="skills-actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => onDone(null)}>Cancel</button>
            {inspect ? (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy || pick === null} onClick={() => void install()}>{busy ? 'Installing…' : 'Install'}</button>
            ) : (
              <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !source.trim()}>{busy ? 'Checking…' : 'Check repository'}</button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
