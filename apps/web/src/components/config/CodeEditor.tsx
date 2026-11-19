import { useRef, type KeyboardEvent } from 'react';

/**
 * A small plain-text code editor: a textarea with a line-number gutter that scrolls with it. Tab
 * indents two spaces, and an `errorLine` is marked in the gutter. Mod+S calls `onSave`.
 */
export function CodeEditor({ value, onChange, onSave, errorLine, label }: {
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
  errorLine?: number | null;
  label: string;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const t = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = t;
    onChange(`${value.slice(0, s)}  ${value.slice(end)}`);
    requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
  };

  return (
    <div className="code-editor">
      <div className="code-editor__gutter" ref={gutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={`code-editor__ln${errorLine === i + 1 ? ' is-error' : ''}`}>{i + 1}</div>
        ))}
      </div>
      <textarea
        className="code-editor__text"
        aria-label={label}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
      />
    </div>
  );
}
