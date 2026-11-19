import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import type { LibrarySkill } from '@orbit/contracts';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';

/** The `/<partial>` token the caret is in, or null. It must start the text or follow whitespace. */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)\/([a-z0-9-]*)$/.exec(before);
  if (!m) return null;
  const after = text.slice(caret);
  if (/^[a-z0-9-]/.test(after)) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

/**
 * `/` suggestions in the composer: the skills this Bot has, filtered by what follows the slash.
 * Arrow keys move, Enter or Tab inserts `/<name> `, Escape closes. The library is loaded the first
 * time a slash is typed and again whenever it changes.
 */
export function useSkillSuggest(botId: string, text: string, setText: (t: string) => void, ref: RefObject<HTMLTextAreaElement | null>) {
  const version = useStore((s) => s.skillsVersion);
  const [skills, setSkills] = useState<LibrarySkill[] | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);

  const q = slashQuery(text, caret);
  const wanted = q !== null;
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    configApi.skillLibrary().then((r) => { if (alive) setSkills(r.skills); }).catch(() => { if (alive) setSkills([]); });
    return () => { alive = false; };
  }, [wanted, version]);

  const matches = useMemo(() => {
    if (!q || !skills || closedAt === q.start) return [];
    return skills.filter((s) => s.bots.some((b) => b.botId === botId && b.allowed) && s.name.startsWith(q.query)).slice(0, 8);
  }, [q, skills, botId, closedAt]);
  useEffect(() => { setActive(0); }, [q?.query]);

  const insert = (s: LibrarySkill) => {
    if (!q) return;
    const next = `${text.slice(0, q.start)}/${s.name} ${text.slice(caret)}`;
    setText(next);
    const at = q.start + s.name.length + 2;
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = at; setCaret(at); } });
  };

  const track = (el: HTMLTextAreaElement) => { setCaret(el.selectionStart ?? el.value.length); if (closedAt !== null && !slashQuery(el.value, el.selectionStart ?? 0)) setClosedAt(null); };

  /** Handles the key when the suggestions are open; true when it did. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!matches.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      insert(matches[active]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setClosedAt(q?.start ?? null);
      return true;
    }
    return false;
  };

  const popover = matches.length ? (
    <div className="skill-suggest" role="listbox" aria-label="Skills">
      {matches.map((s, i) => (
        <button key={s.id} type="button" role="option" aria-selected={i === active} className={`skill-suggest__item${i === active ? ' is-active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); insert(s); }}>
          <span className="skill-suggest__name">/{s.name}</span>
          <span className="skill-suggest__desc">{s.description}</span>
        </button>
      ))}
    </div>
  ) : null;

  return { popover, onKeyDown, track };
}
