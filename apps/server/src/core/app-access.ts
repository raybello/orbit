import { db, now } from '../db.js';
import { appOfSlug } from '../domain/app-access.js';

/**
 * Per-bot access to the person's connected apps. A bot may use every connected app unless the
 * person turned that app off for it; each turned-off pair is one row of `bot_app_revocations`.
 */

/** The apps turned off for this bot, sorted (so the list can key a cache). */
export function revokedApps(botId: string): string[] {
  return (db.prepare('SELECT toolkit FROM bot_app_revocations WHERE bot_id=? ORDER BY toolkit').all(botId) as { toolkit: string }[]).map((r) => r.toolkit);
}

/** Allow or stop one bot using one app. Idempotent. */
export function setAppAccess(botId: string, toolkit: string, allowed: boolean): void {
  const app = toolkit.trim().toLowerCase();
  if (allowed) db.prepare('DELETE FROM bot_app_revocations WHERE bot_id=? AND toolkit=?').run(botId, app);
  else db.prepare('INSERT OR IGNORE INTO bot_app_revocations(bot_id, toolkit, created_at) VALUES (?,?,?)').run(botId, app, now());
}

/** Every turned-off app of this person's bots, by bot id. */
export function revocationsFor(userId: string): Record<string, string[]> {
  const rows = db.prepare('SELECT r.bot_id, r.toolkit FROM bot_app_revocations r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ORDER BY r.toolkit').all(userId) as { bot_id: string; toolkit: string }[];
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.bot_id] ??= []).push(r.toolkit);
  return out;
}

/** The first app among these slugs (actions, triggers or toolkits) that is turned off for this bot. */
export function blockedApp(botId: string, slugs: string[]): string | null {
  if (!slugs.length) return null;
  const revoked = revokedApps(botId);
  if (!revoked.length) return null;
  for (const s of slugs) {
    const app = appOfSlug(s, revoked);
    if (app) return app;
  }
  return null;
}

export const appAllowed = (botId: string, toolkit: string) => blockedApp(botId, [toolkit]) === null;
