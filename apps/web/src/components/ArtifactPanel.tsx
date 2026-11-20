import { useEffect, useState } from 'react';
import { hasNativeWindowControls } from '../lib/desktop-shell';
import { artifactFilename, latestArtifact, type Artifacts } from '../domain/artifacts';
import { useStore } from '../store';
import { ArtifactFrame } from './ArtifactFrame';
import { Icon } from './Icon';

function download(html: string, title: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = artifactFilename(title);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A separate window that frames the artifact with the same sandbox. The HTML goes over postMessage to
 * a static page, never through a blob: URL, which would run the artifact with Orbit's origin.
 */
function openWindow(html: string, title: string) {
  const w = window.open('/artifact-window.html', '_blank', 'popup,width=1100,height=800');
  if (!w) return;
  const onReady = (e: MessageEvent) => {
    if (e.source !== w || e.origin !== location.origin || e.data?.type !== 'artifact-window-ready') return;
    window.removeEventListener('message', onReady);
    w.postMessage({ type: 'artifact', html, title }, location.origin);
  };
  window.addEventListener('message', onReady);
  setTimeout(() => window.removeEventListener('message', onReady), 10_000);
}

/** The desktop shell refuses every new window from the app, so the button would do nothing there. */
const canOpenWindow = !hasNativeWindowControls();

/** The Artifact tab: one artifact at a time, any of its versions, as a live page or its source. */
export function ArtifactPanel({ botId, artifacts }: { botId: string; artifacts: Artifacts }) {
  const open = useStore((s) => s.openArtifacts[botId]);
  const openArtifact = useStore((s) => s.openArtifact);
  const expanded = useStore((s) => s.artifactExpanded);
  const set = useStore((s) => s.set);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) set({ artifactExpanded: false }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, set]);
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);

  const id = open && artifacts.has(open.artifactId) ? open.artifactId : latestArtifact(artifacts);
  const versions = id ? artifacts.get(id)! : [];
  if (!id || !versions.length) return <div className="panel-empty artifact-empty">No artifacts in this chat yet.</div>;
  const pinned = open?.artifactId === id ? open.seq : null;
  const at = Math.max(0, pinned === null ? versions.length - 1 : versions.findIndex((v) => v.seq === pinned));
  const version = versions[at];
  const pick = (i: number) => openArtifact(botId, { artifactId: id, seq: i === versions.length - 1 ? null : versions[i].seq });

  const copy = async () => {
    try { await navigator.clipboard.writeText(version.html); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard refused */ }
  };

  return (
    <div className="artifact-panel">
      <div className="artifact-panel__head">
        {expanded && (
          <button type="button" className="btn btn--sm btn--secondary artifact-panel__back" onClick={() => set({ artifactExpanded: false })}>
            <Icon name="chev_left" size={12} opacity={0.8} /> Conversation
          </button>
        )}
        <div className="artifact-panel__title" title={version.title}>{version.title}</div>
        {versions.length > 1 && (
          <label className="artifact-panel__version">
            <span className="sr-only">Version</span>
            <select value={at} onChange={(e) => pick(Number(e.target.value))} aria-label="Artifact version">
              {versions.map((v, i) => <option key={v.seq} value={i}>v{i + 1} of {versions.length}{i === versions.length - 1 ? ' (latest)' : ''}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="artifact-panel__bar">
        <div className="segmented" role="group" aria-label="Artifact view">
          <button type="button" className={view === 'preview' ? 'is-active' : ''} aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
          <button type="button" className={view === 'source' ? 'is-active' : ''} aria-pressed={view === 'source'} onClick={() => setView('source')}>Source</button>
        </div>
        <span className="artifact-panel__spacer" />
        <button type="button" className="icon-btn" onClick={copy} aria-label="Copy source" title={copied ? 'Copied' : 'Copy source'}>
          <Icon name={copied ? 'check' : 'copy'} size={16} opacity={0.7} />
        </button>
        <button type="button" className="icon-btn" onClick={() => download(version.html, version.title)} aria-label="Download HTML" title="Download HTML">
          <Icon name="save" size={16} opacity={0.7} />
        </button>
        {canOpenWindow && (
          <button type="button" className="icon-btn" onClick={() => openWindow(version.html, version.title)} aria-label="Open in new window" title="Open in new window">
            <Icon name="share" size={16} opacity={0.7} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={() => set({ artifactExpanded: !expanded })}
          aria-label={expanded ? 'Collapse artifact' : 'Expand artifact'}
          aria-pressed={expanded}
          title={expanded ? 'Collapse (Esc)' : 'Expand'}
        >
          <Icon name={expanded ? 'shrink' : 'expand'} size={16} opacity={0.7} />
        </button>
      </div>
      <div className="artifact-panel__body">
        {view === 'preview'
          ? <ArtifactFrame key={version.seq} html={version.html} title={`Preview of ${version.title}`} />
          : <pre className="artifact-source" aria-label="Artifact HTML source">{version.html}</pre>}
      </div>
    </div>
  );
}
