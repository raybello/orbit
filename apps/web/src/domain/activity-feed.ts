import type { ActivityItem, Bot, Row } from '@orbit/contracts';
import { cardPreview } from './card-display';

export const ACTIVITY_LIMIT = 200;
/** A preview is one line in the feed; the cut (and its ellipsis) is pinned at this width by tests. */
export const PREVIEW_CHARS = 110;
/** `activitySeen` is pruned past this many keys so it cannot grow without bound. */
export const SEEN_LIMIT = 1000;

export function activityPreview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

export const botNameFor = (bots: Bot[], botId: string) => bots.find((b) => b.id === botId)?.name ?? botId;

/** Feed identity: one entry per row, one per turn status change. */
export const activityKey = (item: ActivityItem): string =>
  item.seq === undefined ? `live:${item.botId}:${item.kind}:${item.at}` : `row:${item.botId}:${item.seq}`;

export function mergeActivity(prev: ActivityItem[], incoming: ActivityItem[], max = ACTIVITY_LIMIT): ActivityItem[] {
  if (incoming.length === 0) return prev;
  const keys = new Set(incoming.map(activityKey));
  return [...incoming, ...prev.filter((p) => !keys.has(activityKey(p)))]
    .sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, max);
}

export function pruneSeen(seen: Record<string, number>): Record<string, number> {
  const keys = Object.keys(seen);
  if (keys.length <= SEEN_LIMIT) return seen;
  const kept: Record<string, number> = {};
  for (const k of keys.slice(-Math.floor(SEEN_LIMIT / 2))) kept[k] = seen[k];
  return kept;
}

/** An assistant message that finished streaming, or a pending card — everything else stays out of the feed. */
export function activityFromRow(row: Row, botName: string): ActivityItem | null {
  let preview: string | null = null;
  let kind: ActivityItem['kind'] | null = null;
  if (row.body.type === 'message') {
    if (row.body.role !== 'assistant' || row.body.streaming) return null;
    preview = activityPreview(row.body.text);
    kind = 'message';
  } else if (row.body.type === 'card') {
    const card = cardPreview(row.body);
    if (card) { preview = activityPreview(card); kind = 'card'; }
  }
  if (!preview || !kind) return null;
  return { botId: row.botId, botName, kind, preview, at: row.createdAt, seq: row.seq };
}
