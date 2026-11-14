import type { ActivityItem, Bot, LiveState } from '@orbit/contracts';

/**
 * The cross-bot Activity feed.
 *
 * The server declares `activity` frames in its event union but has no producer for them yet, and
 * there is no `/api/activity` route, so the honest source on a phone is what the app already knows:
 * each bot's last message (`lastPreview` / `lastActivityAt` from GET /api/bots) and the live turn
 * state pushed over SSE. Streamed `activity` frames are folded in when a server does send them, so
 * this screen gets richer without changing.
 */

/** How many entries the feed keeps, and how long a preview line is. */
const FEED_LIMIT = 200;
const PREVIEW_CHARS = 110;
/** No single bot may fill the feed: the point of it is to see across bots. */
const PER_BOT_LIMIT = 12;

/** One line of preview text: whitespace collapsed, cut at ~110 characters. */
export function activityPreview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** "searching_web" → "Searching web" — the same wording the thread header uses. */
export function activityLabel(kind: string | null | undefined): string {
  if (!kind) return 'Working…';
  return kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export interface FeedInput {
  bots: Bot[];
  live: Record<string, LiveState>;
  /** `activity` frames from the SSE stream, newest or oldest. */
  streamed: ActivityItem[];
}

export function buildActivityFeed({ bots, live, streamed }: FeedInput): ActivityItem[] {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const entries: ActivityItem[] = [];
  // A bot's own row and a streamed frame can describe the same moment; keep one.
  const seen = new Set<string>();
  const key = (item: ActivityItem) => `${item.botId}|${item.kind}|${item.at}`;

  const push = (item: ActivityItem) => {
    if (seen.has(key(item))) return;
    seen.add(key(item));
    entries.push(item);
  };

  for (const item of streamed) push({ ...item, preview: activityPreview(item.preview) });

  for (const [botId, state] of Object.entries(live)) {
    const botName = names.get(botId) ?? botId;
    if (state.awaiting) {
      push({ botId, botName, kind: 'card', preview: activityPreview(state.awaiting.reason), at: state.awaiting.since });
    }
    if (state.isRunning) {
      const label = state.caption || activityLabel(state.activity?.kind);
      const detail = state.activity?.detail ? ` · ${state.activity.detail}` : '';
      push({
        botId,
        botName,
        kind: 'working',
        preview: activityPreview(`${label}${detail}`),
        at: state.activity?.since ?? state.startedAt ?? Date.now(),
      });
    }
  }

  for (const bot of bots) {
    if (!bot.lastActivityAt) continue;
    const preview = bot.lastPreview?.trim();
    if (!preview) continue;
    // The newest message the server knows about, unless a stream frame already covers that moment.
    const covered = entries.some((e) => e.botId === bot.id && e.kind === 'message' && e.at >= bot.lastActivityAt);
    if (covered) continue;
    push({ botId: bot.id, botName: bot.name, kind: 'message', preview: activityPreview(preview), at: bot.lastActivityAt });
  }

  const trimmed: ActivityItem[] = [];
  const perBot = new Map<string, number>();
  for (const item of [...entries].sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0))) {
    const count = perBot.get(item.botId) ?? 0;
    if (count >= PER_BOT_LIMIT) continue;
    perBot.set(item.botId, count + 1);
    trimmed.push(item);
    if (trimmed.length >= FEED_LIMIT) break;
  }
  return trimmed;
}
