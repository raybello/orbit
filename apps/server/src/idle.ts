/**
 * Who is watching: per user for the computer panel, and per bot so docker-provider.ts keeps a
 * watched bot's computer awake.
 */

// ---------- viewer tracking (called from vnc.ts) ----------

const viewers = new Map<string, number>();

export function viewerOpened(userId: string) {
  viewers.set(userId, (viewers.get(userId) ?? 0) + 1);
  console.log(`[idle] viewer connected user=${userId} (now ${viewers.get(userId)})`);
}

export function viewerClosed(userId: string) {
  const n = Math.max(0, (viewers.get(userId) ?? 1) - 1);
  if (n) viewers.set(userId, n); else viewers.delete(userId);
  console.log(`[idle] viewer disconnected user=${userId} (now ${n})`);
}

export const viewerCount = (userId: string) => viewers.get(userId) ?? 0;

/** Per-bot viewers, for suspending a bot's own container when nobody is looking at it. */
const botViewers = new Map<string, number>();
const botSeen = new Map<string, number>();

export function botViewerOpened(botId: string) {
  botViewers.set(botId, (botViewers.get(botId) ?? 0) + 1);
  botSeen.set(botId, Date.now());
}

export function botViewerClosed(botId: string) {
  const n = Math.max(0, (botViewers.get(botId) ?? 1) - 1);
  if (n) botViewers.set(botId, n); else botViewers.delete(botId);
  botSeen.set(botId, Date.now());
}

export const botViewerCount = (botId: string) => botViewers.get(botId) ?? 0;
/** When this bot's screen was last looked at (0 if never). */
export const botLastSeen = (botId: string) => botSeen.get(botId) ?? 0;

