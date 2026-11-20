import { Suspense, lazy, useEffect, useState } from 'react';
import { viewerFor, type ViewerKind } from '@orbit/domain';
import { parseCsv } from '../../domain/csv';
import { ArtifactFrame } from '../ArtifactFrame';
import { ImageViewer } from '../ImageViewer';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { Modal } from '../modals/Modal';
import { formatBytes } from '../config/ui';
import '../../styles/file-viewer.css';

/** The code view, with CodeMirror and its language data, loads only when a file is opened. */
const CodeView = lazy(() => import('./CodeView'));

/** Bigger files are not loaded into a view: they download instead. */
export const TEXT_CAP = 2_000_000;

/** Rendering Markdown blocks the page and grows faster than the file: 100 KB takes ~0.4 s, 1 MB ~17 s. Past this it opens as source. */
export const MARKDOWN_RENDER_CAP = 100_000;

export interface ViewedFile {
  name: string;
  /** Where the bytes are served from. */
  url: string;
  /** The file's path as the person knows it (shown under the name), e.g. engines/primary/workspace/report.md. */
  path?: string;
  size?: number;
  mediaType?: string;
  /** For Markdown: where a relative link or image in the file points (an image beside the report). */
  resolve?: (href: string) => string;
}

/**
 * Open a file the way its kind wants: an image in the image viewer; Markdown, HTML and CSV rendered
 * (Markdown as text, HTML as a page in the artifact sandbox, CSV as a table), each with its source a
 * click away; anything else as text in the code view with syntax highlighting.
 */
export function FileViewer({ file, onClose }: { file: ViewedFile; onClose: () => void }) {
  const kind = viewerFor(file.name, file.mediaType);
  if (kind === 'image') return <ImageViewer url={file.url} name={file.name} onClose={onClose} />;
  return <TextViewer file={file} kind={kind} onClose={onClose} />;
}

/** Kinds with a rendered view as well as their source. */
type Rendered = Extract<ViewerKind, 'markdown' | 'html' | 'csv'>;
const isRendered = (k: ViewerKind): k is Rendered => k === 'markdown' || k === 'html' || k === 'csv';

function CsvView({ text, name }: { text: string; name: string }) {
  const { rows, truncated } = parseCsv(text, name);
  const [head, ...body] = rows;
  if (!head) return <div className="file-viewer__note">This file is empty.</div>;
  return (
    <div className="file-viewer__csv">
      <table>
        <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>{body.map((r, i) => <tr key={i}>{head.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
      </table>
      {truncated && <div className="file-viewer__cut">Showing the first {rows.length.toLocaleString()} rows. Download the file for the rest.</div>}
    </div>
  );
}

function RenderedView({ kind, text, file }: { kind: Rendered; text: string; file: ViewedFile }) {
  if (kind === 'html') return <div className="file-viewer__page"><ArtifactFrame html={text} title={`Preview of ${file.name}`} /></div>;
  if (kind === 'csv') return <CsvView text={text} name={file.name} />;
  return <div className="file-viewer__md"><Markdown text={text} urlTransform={file.resolve} /></div>;
}

type Loaded = { state: 'loading' } | { state: 'text'; text: string; capped: boolean } | { state: 'binary' } | { state: 'too-big' } | { state: 'error'; message: string };

/** A NUL byte in the first 8 KB is how a binary file shows itself. */
const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0);

function TextViewer({ file, kind, onClose }: { file: ViewedFile; kind: ViewerKind; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [source, setSource] = useState(false);
  const tooLong = kind === 'markdown' && loaded.state === 'text' && loaded.text.length > MARKDOWN_RENDER_CAP;
  const rendered = isRendered(kind) && !tooLong ? kind : null;

  useEffect(() => {
    if (file.size !== undefined && file.size > TEXT_CAP) { setLoaded({ state: 'too-big' }); return; }
    let alive = true;
    setLoaded({ state: 'loading' });
    fetch(file.url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          let message = `${res.status} ${res.statusText}`.trim();
          try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* not json */ }
          throw new Error(message);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!alive) return;
        if (looksBinary(bytes)) { setLoaded({ state: 'binary' }); return; }
        const capped = bytes.length > TEXT_CAP;
        setLoaded({ state: 'text', text: new TextDecoder().decode(capped ? bytes.subarray(0, TEXT_CAP) : bytes), capped });
      })
      .catch((e: Error) => { if (alive) setLoaded({ state: 'error', message: e.message || 'Could not load the file' }); });
    return () => { alive = false; };
  }, [file.url, file.size]);

  // A file at the top of its library has a path that is just its name; saying it twice adds nothing.
  const where = file.path && file.path !== file.name ? file.path : '';
  const meta = [where, file.size !== undefined ? formatBytes(file.size) : ''].filter(Boolean).join(' · ');

  return (
    <Modal onClose={onClose} label={`Preview of ${file.name}`} className="file-viewer">
      <div className="file-viewer__head">
        <div className="file-viewer__title">
          <span className="file-viewer__name" title={file.name}>{file.name}</span>
          {meta && <span className="file-viewer__meta" title={file.path}>{meta}</span>}
        </div>
        <div className="file-viewer__tools">
          {rendered && loaded.state === 'text' && (
            <div className="file-viewer__seg" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={!source} className={!source ? 'is-on' : ''} onClick={() => setSource(false)}>Preview</button>
              <button type="button" role="tab" aria-selected={source} className={source ? 'is-on' : ''} onClick={() => setSource(true)}>Source</button>
            </div>
          )}
          <a className="btn btn--sm btn--secondary" href={file.url} download={file.name} title={`Download ${file.name}`}>
            <Icon name="arrow_down" size={12} /> Download
          </a>
          <button type="button" className="icon-btn icon-btn--plain" onClick={onClose} aria-label="Close preview" title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="file-viewer__body">
        {loaded.state === 'loading' && <div className="file-viewer__note" role="status">Loading…</div>}
        {loaded.state === 'error' && <div className="file-viewer__note is-error" role="alert">Couldn’t open this file. {loaded.message}</div>}
        {loaded.state === 'binary' && <div className="file-viewer__note">This is a binary file, so there is nothing to show as text. Download it to open it.</div>}
        {loaded.state === 'too-big' && <div className="file-viewer__note">This file is larger than {formatBytes(TEXT_CAP)}, too big to preview. Download it to open it.</div>}
        {loaded.state === 'text' && (rendered && !source
          ? <RenderedView kind={rendered} text={loaded.text} file={file} />
          : (
            <Suspense fallback={<div className="file-viewer__note" role="status">Loading…</div>}>
              <CodeView text={loaded.text} filename={file.name} />
            </Suspense>
          ))}
      </div>
      {loaded.state === 'text' && loaded.capped && <div className="file-viewer__cut">Showing the first {formatBytes(TEXT_CAP)}.</div>}
      {tooLong && <div className="file-viewer__cut">Too long to render as Markdown, so this is its source.</div>}
    </Modal>
  );
}
