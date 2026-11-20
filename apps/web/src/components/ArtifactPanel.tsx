import { useState } from 'react';
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

/** The Artifact tab: one artifact at a time, any of its versions, as a live page or its source. */
export function ArtifactPanel({ botId, artifacts }: { botId: string; artifacts: Artifacts }) {
  const open = useStore((s) => s.openArtifacts[botId]);
  const openArtifact = useStore((s) => s.openArtifact);
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
      </div>
      <div className="artifact-panel__body">
        {view === 'preview'
          ? <ArtifactFrame key={version.seq} html={version.html} title={`Preview of ${version.title}`} />
          : <pre className="artifact-source" aria-label="Artifact HTML source">{version.html}</pre>}
      </div>
    </div>
  );
}
