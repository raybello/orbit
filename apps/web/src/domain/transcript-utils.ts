import type { Bot, Row } from '@orbit/contracts';

/**
 * Transcript as the store keeps it: rows keyed by seq inside one generation. `cleared` bumps the
 * generation, so a row that arrives late from the old transcript is dropped instead of reappearing.
 */
export interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

export function sortedRows(t: Transcript | undefined): Row[] {
  if (!t) return [];
  return Object.values(t.bySeq).sort((a, b) => a.seq - b.seq);
}

export const displayName = (b: Pick<Bot, 'name' | 'label'>) => (b.label ? `${b.name} · ${b.label}` : b.name);
