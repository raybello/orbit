import { artifactArgsOf, type ArtifactId, type Row } from '@orbit/contracts';

/** One saved version of an artifact: the row it came from and what it held. */
export interface ArtifactVersion {
  seq: number;
  title: string;
  html: string;
  createdAt: number;
}

/** Every artifact in a transcript, oldest first, with its versions oldest first. */
export type Artifacts = Map<ArtifactId, ArtifactVersion[]>;

export function artifactsOf(rows: readonly Row[]): Artifacts {
  const out: Artifacts = new Map();
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  for (const row of sorted) {
    if (row.body.type !== 'tool-call') continue;
    const a = artifactArgsOf(row.body);
    if (!a) continue;
    const version = { seq: row.seq, title: a.title, html: a.html, createdAt: row.createdAt };
    const list = out.get(a.artifactId);
    if (list) list.push(version);
    else out.set(a.artifactId, [version]);
  }
  return out;
}

/** Where a row sits in its artifact's history: 1-based, with the total. Null for any other row. */
export function versionOf(artifacts: Artifacts, artifactId: ArtifactId, seq: number): { n: number; of: number } | null {
  const list = artifacts.get(artifactId);
  const i = list?.findIndex((v) => v.seq === seq) ?? -1;
  return list && i >= 0 ? { n: i + 1, of: list.length } : null;
}

/** The artifact most recently written, for a panel opened without a card click. */
export function latestArtifact(artifacts: Artifacts): ArtifactId | null {
  let best: { id: ArtifactId; seq: number } | null = null;
  for (const [id, list] of artifacts) {
    const seq = list[list.length - 1].seq;
    if (!best || seq > best.seq) best = { id, seq };
  }
  return best?.id ?? null;
}

/** A file name for downloading an artifact, from its title. */
export function artifactFilename(title: string): string {
  const base = title.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80).toLowerCase();
  return `${base || 'artifact'}.html`;
}
