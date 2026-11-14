import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SkillEntry } from '@orbit/contracts';
import { api } from '../lib/api';
import { useStore } from '../store';
import { Switch } from './config/ui';
import '../styles/skills.css';

/** A skill's transport, as a badge. Unknown types keep a neutral chip rather than guessing. */
function badgeFor(type: string): { label: string; className: string } {
  if (type === 'http') return { label: 'HTTP', className: 'is-http' };
  if (type === 'stdio') return { label: 'stdio', className: 'is-stdio' };
  return { label: 'other', className: 'is-other' };
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

const enabledLabel = (n: number) => `${n} ${n === 1 ? 'Bot' : 'Bots'}`;

function withBotEnabled(skill: SkillEntry, botId: string, enabled: boolean): SkillEntry {
  return { ...skill, bots: skill.bots.map((b) => (b.botId === botId ? { ...b, enabled } : b)) };
}

/**
 * Skills (Hermes `mcp_servers`): the primary agent's list on the left, the selected skill's
 * per-Bot switches on the right. The primary agent reads its own config, so its row is locked on.
 * Toggles are optimistic: the switch flips now, the config is written in the background, and a
 * failed write flips it back with a short inline note.
 */
export function SkillsView() {
  const bots = useStore((s) => s.bots);
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSkills(null);
    setLoadError(null);
    api.skills()
      .then((r) => {
        if (!alive) return;
        setSkills(r.skills);
        // Keep the selection across a refetch unless that skill is gone.
        setSelectedName((cur) => (cur && r.skills.some((s) => s.name === cur) ? cur : r.skills[0]?.name ?? null));
      })
      .catch((e) => { if (alive) setLoadError(errText(e)); });
    return () => { alive = false; };
  }, [reloadKey]);

  /** The primary agent: its skills come from its own config, so it has no switch. */
  const primaryId = useMemo(() => bots.find((b) => b.isPrimary)?.id ?? null, [bots]);

  const selected = useMemo(
    () => skills?.find((s) => s.name === selectedName) ?? null,
    [skills, selectedName],
  );

  const toggle = useCallback(async (skill: SkillEntry, botId: string, enabled: boolean) => {
    const previous = skill.bots.find((b) => b.botId === botId)?.enabled ?? false;
    const key = `${skill.name}:${botId}`;
    setToggleError(null);
    setPending(key);
    setSkills((list) => list?.map((s) => (s.name === skill.name ? withBotEnabled(s, botId, enabled) : s)) ?? null);
    try {
      const r = await api.setSkillEnabled(botId, skill.name, enabled);
      // The server answers with the skill as it now stands; adopt it.
      setSkills((list) => list?.map((s) => (s.name === skill.name ? r.skill : s)) ?? null);
    } catch (e) {
      setSkills((list) => list?.map((s) => (s.name === skill.name ? withBotEnabled(s, botId, previous) : s)) ?? null);
      setToggleError(`Couldn't update ${skill.name} for ${skill.bots.find((b) => b.botId === botId)?.botName ?? 'this Bot'}. ${errText(e)}`);
    } finally {
      setPending(null);
    }
  }, []);

  // Primary first; the server already orders it that way, so entry 0 is the fallback when the
  // Bot list has not loaded yet.
  const rows = useMemo(() => {
    if (!selected) return [];
    const primary = primaryId ?? selected.bots[0]?.botId ?? null;
    return [...selected.bots].sort((a, b) => Number(b.botId === primary) - Number(a.botId === primary));
  }, [selected, primaryId]);

  const retry = () => setReloadKey((k) => k + 1);

  let body;
  if (loadError) {
    body = (
      <div className="skills-state" role="alert">
        <div className="skills-state__title">Couldn’t load skills</div>
        <div className="skills-state__sub">{loadError}</div>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={retry}>Retry</button>
      </div>
    );
  } else if (skills === null) {
    body = <div className="skills-state"><div className="cfg-empty">Loading skills…</div></div>;
  } else if (skills.length === 0) {
    body = (
      <div className="skills-state">
        <div className="skills-state__title">No skills yet</div>
        <div className="skills-state__sub">No skills configured in the primary agent&apos;s config</div>
      </div>
    );
  } else {
    body = (
      <div className="skills-view__panes">
        <div className="skills-list" role="group" aria-label="Skills">
          {skills.map((s) => {
            const active = s.name === selectedName;
            const badge = badgeFor(s.type);
            return (
              <button
                key={s.name}
                type="button"
                className={`skills-row${active ? ' is-active' : ''}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => { setSelectedName(s.name); setToggleError(null); }}
              >
                <span className="skills-row__top">
                  <span className="skills-row__name">{s.name}</span>
                  <span className={`skills-badge ${badge.className}`}>{badge.label}</span>
                </span>
                {s.description && <span className="skills-row__desc">{s.description}</span>}
                <span className="skills-row__count">{enabledLabel(s.bots.filter((b) => b.enabled).length)}</span>
              </button>
            );
          })}
        </div>

        <section className="skills-detail" aria-label="Skill details">
          {!selected ? (
            <div className="skills-state"><div className="skills-state__sub">Select a skill to see which Bots have it.</div></div>
          ) : (
            <div className="skills-detail__inner">
              <div className="skills-detail__head">
                <div className="skills-detail__name">
                  {selected.name}
                  <span className={`skills-badge ${badgeFor(selected.type).className}`}>{badgeFor(selected.type).label}</span>
                </div>
              </div>

              <dl className="skills-meta">
                <dt>Type</dt>
                <dd>{selected.type}</dd>
                <dt>URL</dt>
                <dd>{selected.url ? <code>{selected.url}</code> : '—'}</dd>
                <dt>Description</dt>
                <dd>{selected.description || '—'}</dd>
              </dl>

              <div className="skills-group">
                <div className="skills-group__label">Bots with this skill</div>
                <div className="panel-card skills-bots">
                  {rows.map((b) => {
                    const isPrimary = b.botId === primaryId;
                    const on = isPrimary ? true : b.enabled;
                    const busy = pending === `${selected.name}:${b.botId}`;
                    return (
                      <div key={b.botId} className={`panel-row skills-bot${isPrimary ? ' is-primary' : ''}`}>
                        <span className="panel-row__text">
                          <span className="panel-row__title">{b.botName}</span>
                          <span className="panel-row__meta">{isPrimary ? 'Always on, from its own config' : on ? 'Enabled' : 'Off'}</span>
                        </span>
                        {isPrimary && <span className="cfg-chip skills-tag">Primary</span>}
                        <Switch
                          on={on}
                          disabled={isPrimary || busy}
                          label={`${selected.name} for ${b.botName}`}
                          onChange={(v) => { void toggle(selected, b.botId, v); }}
                        />
                      </div>
                    );
                  })}
                </div>
                {toggleError && <div className="skills-inline-error" role="alert">{toggleError}</div>}
              </div>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <main className="skills-view">
      <header className="skills-view__header">
        <div>
          <h1 className="skills-view__title">Skills</h1>
          <p className="skills-view__sub">MCP servers from the primary agent’s config. Turn one on or off per Bot.</p>
        </div>
        {skills && skills.length > 0 && <span className="cfg-chip cfg-chip--muted">{skills.length} total</span>}
      </header>
      <div className="skills-view__body">{body}</div>
    </main>
  );
}
