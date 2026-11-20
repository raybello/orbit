import type { ArtifactArgs } from '@orbit/contracts';
import { useStore } from '../../store';
import { Icon } from '../Icon';

/** An artifact the Bot wrote, in the chat: its title and version, and a button to open it beside the chat. */
export function ArtifactCard({ botId, seq, artifact, version }: {
  botId: string;
  seq: number;
  artifact: ArtifactArgs;
  version: { n: number; of: number } | null;
}) {
  const openArtifact = useStore((s) => s.openArtifact);
  const latest = !version || version.n === version.of;
  const showing = useStore((s) => {
    const o = s.openArtifacts[botId];
    return s.detailsOpen && s.detailsTab === 'artifact' && o?.artifactId === artifact.artifactId && (o.seq === seq || (o.seq === null && latest));
  });
  const sub = version && version.of > 1 ? `Version ${version.n} of ${version.of}${latest ? '' : ' · older'}` : 'Interactive page';
  return (
    <div className={`artifact-card${showing ? ' is-showing' : ''}`}>
      <span className="artifact-card__icon" aria-hidden><Icon name="file" size={18} opacity={0.7} /></span>
      <span className="artifact-card__text">
        <span className="artifact-card__title">{artifact.title}</span>
        <span className="artifact-card__sub">{sub}</span>
      </span>
      <button
        type="button"
        className="btn btn--sm btn--secondary"
        onClick={() => openArtifact(botId, { artifactId: artifact.artifactId, seq: latest ? null : seq })}
        aria-label={`Open ${artifact.title}`}
      >
        {showing ? 'Showing' : 'Open'}
      </button>
    </div>
  );
}
