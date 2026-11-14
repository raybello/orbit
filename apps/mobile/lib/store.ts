import { create } from 'zustand';
import type { ActivityItem, Bot, LiveState, Row } from '@orbit/contracts';

/** How many streamed activity frames the store keeps. The feed caps itself far lower. */
const ACTIVITY_LIMIT = 200;

/**
 * What the app keeps in memory: the roster, one transcript per bot, and the live turn state.
 * Screens read from here so an SSE frame lands in every open view at once; React Query owns the
 * fetching, this owns the streaming.
 */
export interface OrbitMobileStore {
  bots: Bot[];
  live: Record<string, LiveState>;
  threads: Record<string, Row[]>;
  /** `activity` frames from the SSE stream, newest first. */
  activity: ActivityItem[];
  /** True once the roster has been loaded at least once, so the UI can tell empty from unknown. */
  loaded: boolean;
  setBots(bots: Bot[]): void;
  setLive(states: LiveState[]): void;
  upsertLive(state: LiveState): void;
  upsertBot(bot: Bot): void;
  pushActivity(item: ActivityItem): void;
  setThread(botId: string, rows: Row[]): void;
  upsertRow(botId: string, row: Row): void;
  clearThread(botId: string): void;
  markRead(botId: string): void;
  reset(): void;
}

/** Rows are ordered by `seq` and rewritten in place while streaming, so a row replaces its own seq. */
function withRow(rows: Row[], row: Row): Row[] {
  const at = rows.findIndex((r) => r.seq === row.seq);
  if (at === -1) {
    const next = [...rows, row];
    next.sort((a, b) => a.seq - b.seq);
    return next;
  }
  if (rows[at].updatedSeq >= row.updatedSeq && rows[at].kind === row.kind) return rows;
  const next = rows.slice();
  next[at] = row;
  return next;
}

export const useOrbitStore = create<OrbitMobileStore>((set) => ({
  bots: [],
  live: {},
  threads: {},
  activity: [],
  loaded: false,

  setBots: (bots) => set({ bots, loaded: true }),

  setLive: (states) =>
    set(() => {
      const live: Record<string, LiveState> = {};
      for (const state of states) live[state.botId] = state;
      return { live };
    }),

  upsertLive: (state) => set((s) => ({ live: { ...s.live, [state.botId]: state } })),

  upsertBot: (bot) =>
    set((s) => {
      const at = s.bots.findIndex((b) => b.id === bot.id);
      if (at === -1) return { bots: [...s.bots, bot] };
      const bots = s.bots.slice();
      bots[at] = bot;
      return { bots };
    }),

  setThread: (botId, rows) => set((s) => ({ threads: { ...s.threads, [botId]: rows } })),

  pushActivity: (item) =>
    set((s) => {
      // The same moment can arrive twice on a reconnect; the last version wins.
      const at = s.activity.findIndex((a) => a.botId === item.botId && a.kind === item.kind && a.at === item.at);
      const next = at === -1 ? [item, ...s.activity] : s.activity.map((a, i) => (i === at ? item : a));
      return { activity: next.slice(0, ACTIVITY_LIMIT) };
    }),

  upsertRow: (botId, row) =>
    set((s) => ({ threads: { ...s.threads, [botId]: withRow(s.threads[botId] ?? [], row) } })),

  clearThread: (botId) =>
    set((s) => ({ threads: { ...s.threads, [botId]: [] } })),

  markRead: (botId) =>
    set((s) => ({
      bots: s.bots.map((b) => (b.id === botId && b.unread !== 0 ? { ...b, unread: 0 } : b)),
    })),

  reset: () => set({ bots: [], live: {}, threads: {}, activity: [], loaded: false }),
}));

/** Pinned bots first, then the ones that spoke last — the order a person expects in a chat list. */
export function sortBots(bots: Bot[]): Bot[] {
  return [...bots].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt;
  });
}
