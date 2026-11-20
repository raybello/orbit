import { Suspense, lazy, useMemo, useState } from 'react';
import { lineDiff, withContext, type CodeEdit, type CodeFile, type DiffLine } from '../domain/code-edits';

const CodeView = lazy(() => import('./files/CodeView'));

/** Lines one diff draws. A created 5,000-line file drawn in full cost ~280 ms; the File view has the rest. */
const DIFF_LINE_CAP = 400;

const TITLE: Record<CodeEdit['kind'], (e: CodeEdit) => string> = {
  write: (e) => (e.kind === 'write' && e.previous !== null ? 'Rewrote the file' : 'Created the file'),
  replace: (e) => (e.kind === 'replace' && e.all ? 'Replaced every match' : 'Edited'),
  patch: () => 'Applied a patch',
};

function diffOf(e: CodeEdit): DiffLine[] {
  if (e.kind === 'write') return lineDiff(e.previous ?? '', e.content);
  if (e.kind === 'replace') return lineDiff(e.before, e.after);
  return e.patch.split('\n').filter((l) => !l.startsWith('***')).map((l) => ({ op: l[0] === '+' || l[0] === '-' ? l[0] : ' ', text: l.slice(l[0] === '+' || l[0] === '-' || l[0] === ' ' ? 1 : 0) }));
}

function EditDiff({ edit, n }: { edit: CodeEdit; n: number }) {
  const all = useMemo(() => withContext(diffOf(edit)), [edit]);
  const items = all.length > DIFF_LINE_CAP ? all.slice(0, DIFF_LINE_CAP) : all;
  return (
    <section className="code-edit" aria-label={`Edit ${n}`}>
      <div className="code-edit__head">{n}. {TITLE[edit.kind](edit)}</div>
      <pre className="code-diff">
        {items.map((it, i) => (it.op === 'gap'
          ? <div key={i} className="code-diff__gap">⋯ {it.count} unchanged {it.count === 1 ? 'line' : 'lines'}</div>
          : <div key={i} className={`code-diff__line is-${it.op === '+' ? 'add' : it.op === '-' ? 'del' : 'same'}`}><span aria-hidden>{it.op}</span>{it.text || ' '}</div>))}
      </pre>
      {items !== all && <div className="code-edit__more">{(all.length - DIFF_LINE_CAP).toLocaleString()} more lines in this change. Open File to see the whole file.</div>}
    </section>
  );
}

/** The Code tab: every file the Bot wrote or edited in this chat, its changes, and the file as it now stands. */
export function CodePanel({ files }: { files: CodeFile[] }) {
  const [path, setPath] = useState<string | null>(null);
  const [view, setView] = useState<'changes' | 'file'>('changes');
  const file = files.find((f) => f.path === path) ?? files[files.length - 1];
  if (!file) return <div className="panel-empty code-empty">No code in this chat yet.</div>;
  const shown = view === 'file' && file.content !== null ? 'file' : 'changes';
  const name = file.path.split('/').pop() ?? file.path;

  return (
    <div className="code-panel">
      <ul className="code-files" aria-label="Files the Bot changed">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className={`code-files__row${f === file ? ' is-active' : ''}`} aria-current={f === file ? 'true' : undefined} onClick={() => setPath(f.path)} title={f.path}>
              <span className="code-files__path">{f.path}</span>
              <span className="code-files__count">{f.edits.length} {f.edits.length === 1 ? 'edit' : 'edits'}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="code-panel__bar">
        <span className="code-panel__name" title={file.path}>{name}</span>
        <div className="segmented" role="group" aria-label="Code view">
          <button type="button" className={shown === 'changes' ? 'is-active' : ''} aria-pressed={shown === 'changes'} onClick={() => setView('changes')}>Changes</button>
          <button
            type="button"
            className={shown === 'file' ? 'is-active' : ''}
            aria-pressed={shown === 'file'}
            disabled={file.content === null}
            title={file.content === null ? 'An edit could not be replayed exactly, so the whole file is not known here' : undefined}
            onClick={() => setView('file')}
          >File</button>
        </div>
      </div>
      <div className="code-panel__body">
        {shown === 'file'
          ? <Suspense fallback={<div className="panel-empty">Loading…</div>}><CodeView key={file.path} text={file.content!} filename={file.path} /></Suspense>
          : <div className="code-edits">{file.edits.map((e, i) => <EditDiff key={`${e.seq}-${i}`} edit={e} n={i + 1} />)}</div>}
      </div>
    </div>
  );
}
