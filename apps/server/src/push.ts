import { createLogger } from '@orbit/logger';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import type { PushPayload, PushPlatform } from './types.js';

const log = createLogger({ scope: 'server:push' });

/** Expo's push service takes a JSON array of messages; no SDK needed. */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo's own recommendation, and the size we can post in one request. */
const CHUNK = 100;

export interface PushTokenRow {
  token: string;
  platform: PushPlatform;
}

/**
 * Remember where to reach a user's phone. Tokens are unique in the table, so the same phone
 * signing in as someone else takes its token with it instead of leaving a stale row behind.
 */
export function registerPushToken(userId: string, token: string, platform: PushPlatform) {
  db.prepare(
    `INSERT INTO push_tokens(id,user_id,token,platform,created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, platform=excluded.platform`,
  ).run(newId('push'), userId, token, platform, now());
}

/** Signing a phone out forgets that device; other phones keep their notifications. */
export function removePushToken(userId: string, token: string) {
  db.prepare('DELETE FROM push_tokens WHERE user_id=? AND token=?').run(userId, token);
}

/** Fallback for a client that cannot say which token it held: forget every device of this user. */
export function removePushTokens(userId: string) {
  db.prepare('DELETE FROM push_tokens WHERE user_id=?').run(userId);
}

export function listPushTokens(userId: string): PushTokenRow[] {
  return db.prepare('SELECT token, platform FROM push_tokens WHERE user_id=?').all(userId) as PushTokenRow[];
}

/**
 * Notify a user's devices. Deliberately incapable of throwing: it is called from the agent loop and
 * from approval handling, where a push that fails must never cost the turn. Errors are logged and
 * dropped, and a user with no registered devices is a no-op.
 */
export async function sendPushNotification(userId: string, payload: PushPayload): Promise<void> {
  try {
    const rows = listPushTokens(userId);
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const messages = rows.slice(i, i + CHUNK).map((r) => ({
        to: r.token,
        sound: payload.sound === null ? undefined : 'default',
        title: payload.title,
        body: payload.body,
        // Expo wants the extra data under `data`, as JSON.
        ...(payload.data ? { data: payload.data } : {}),
      }));
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'gzip, deflate' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        log.warn(`expo push answered ${res.status}`, await res.text().catch(() => ''));
        continue;
      }
      // A ticket can still carry an error per message (bad or expired token); those are worth a line.
      const body = (await res.json().catch(() => null)) as any;
      const failed = (Array.isArray(body?.data) ? body.data : []).filter((t: any) => t?.status === 'error');
      if (failed.length) log.warn('expo push rejected', failed.length, 'message(s):', failed[0]?.message ?? 'unknown');
    }
  } catch (e: any) {
    log.warn('push failed', e?.message ?? e);
  }
}
