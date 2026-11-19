import crypto from 'node:crypto';
import { db } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { parseSecretKey, Secret, secretBox, SecretBoxUnavailableError, type SecretBox } from '../lib/secret-box.js';
import { connectedToolkits, runAction } from '../composio.js';
import { rec, str } from '../lib/coerce.js';

/**
 * The Google Calendar mirror: the person's chosen Google calendars, kept in Orbit's database so the
 * Orbit calendar and the bots can show real events without asking Google each time.
 *
 * Encrypted at rest. A calendar's id (often an email address), its name, and everything about an
 * event (title, description, location, guests, links, ids) are sealed with DB_ENCRYPTION_KEY
 * (AES-256-GCM, lib/secret-box.ts), each bound to a context naming its user and row, so a sealed
 * value moved to another row fails to open. Rows are found by keys that are HMACs of the Google ids
 * under a key derived from the same secret, so no lookup needs plaintext. Only times, an all-day
 * flag, a recurring flag and a hash of the sealed payload (to notice changes) are stored in the clear.
 * With no usable key the mirror is off and says why; it never falls back to plaintext.
 *
 * Sync: the calendars the person turned on (primary by default), 30 days back and 90 ahead, through
 * GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS with `response_detail: 'full'` (the default answer is only
 * a summary). Events gone from a calendar that answered are removed; a calendar listed in
 * `errors_by_calendar` keeps its rows as they were. A failed sync backs off and never wipes anything.
 */

export const WINDOW_BACK_DAYS = 30;
export const WINDOW_AHEAD_DAYS = 90;
export const SYNC_EVERY_MS = 5 * 60_000;
/** A calendar view asks for a sync only when the last one is older than this. */
export const FRESH_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/** An event as the mirror keeps it (decrypted). Times are ISO instants; an all-day event's are UTC midnights, end exclusive. */
export interface MirrorEvent {
  key: string;
  calendarKey: string;
  calendarId: string;
  eventId: string;
  recurringEventId: string | null;
  title: string;
  description: string;
  location: string;
  attendees: string[];
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  htmlLink: string;
  meetLink: string;
  updated: string;
}

export interface MirrorCalendar { key: string; id: string; name: string; color: string | null; primary: boolean; enabled: boolean }

/** What changed in one sync, for the parts of the app that follow Google events (linked Orbit events). */
export type MirrorChange =
  | { kind: 'added'; event: MirrorEvent }
  | { kind: 'changed'; event: MirrorEvent; before: MirrorEvent }
  | { kind: 'removed'; event: MirrorEvent };

const listeners: ((userId: string, changes: MirrorChange[]) => void)[] = [];
export const onMirrorChanges = (fn: (userId: string, changes: MirrorChange[]) => void) => { listeners.push(fn); };

// ---------- keys and sealing ----------

export type MirrorState = { available: true } | { available: false; reason: string };

function keys(): { box: SecretBox; index: Buffer } | null {
  try {
    const raw = parseSecretKey(env.dbEncryptionKey);
    return { box: secretBox(env.dbEncryptionKey), index: crypto.createHash('sha256').update(Buffer.concat([Buffer.from('orbit-gcal-index:'), raw])).digest() };
  } catch (e) {
    if (e instanceof SecretBoxUnavailableError) return null;
    throw e;
  }
}

export function mirrorState(): MirrorState {
  return keys() ? { available: true } : { available: false, reason: 'Google Calendar events are not shown: this server has no DB_ENCRYPTION_KEY to keep them encrypted. Set one (openssl rand -hex 32) and restart.' };
}

const hmac = (index: Buffer, ...parts: string[]) => crypto.createHmac('sha256', index).update(parts.join('\u0000')).digest('base64url').slice(0, 32);
const calCtx = (userId: string, calKey: string) => `gcal-cal:${userId}:${calKey}`;
const evCtx = (userId: string, eventKey: string) => `gcal-ev:${userId}:${eventKey}`;

// ---------- reading Google's answers ----------


/** A Google event as the mirror keeps it, or null for one it cannot place in time. */
export function toMirrorEvent(e: Record<string, unknown>, calendarId: string, calendarKey: string, key: string): MirrorEvent | null {
  const start = rec(e.start);
  const end = rec(e.end);
  const allDay = Boolean(str(start.date)) && !str(start.dateTime);
  const s = allDay ? `${str(start.date)}T00:00:00.000Z` : str(start.dateTime);
  const en = allDay ? `${str(end.date) || str(start.date)}T00:00:00.000Z` : str(end.dateTime) || s;
  if (!s || Number.isNaN(Date.parse(s)) || Number.isNaN(Date.parse(en))) return null;
  return {
    key, calendarKey, calendarId,
    eventId: str(e.id),
    recurringEventId: str(e.recurringEventId) || null,
    title: str(e.summary),
    description: str(e.description),
    location: str(e.location),
    attendees: (Array.isArray(e.attendees) ? e.attendees : []).map((a) => str(rec(a).email)).filter(Boolean),
    start: new Date(s).toISOString(),
    end: new Date(en).toISOString(),
    allDay,
    timezone: str(start.timeZone) || 'UTC',
    htmlLink: str(e.htmlLink),
    meetLink: str(e.hangoutLink),
    updated: str(e.updated),
  };
}

// ---------- the stored mirror ----------

interface CalRow { cal_key: string; sealed: string; color: string | null; is_primary: number; enabled: number }
interface EvRow { event_key: string; cal_key: string; start_ms: number; end_ms: number; all_day: number; recurring: number; sealed: string; payload_hash: string }

export function listCalendars(userId: string): MirrorCalendar[] {
  const k = keys();
  if (!k) return [];
  const rows = db.prepare('SELECT * FROM gcal_calendars WHERE user_id=? ORDER BY is_primary DESC').all(userId) as CalRow[];
  return rows.flatMap((r) => {
    try {
      const { id, name } = JSON.parse(k.box.open(r.sealed, calCtx(userId, r.cal_key)).reveal()) as { id: string; name: string };
      return [{ key: r.cal_key, id, name, color: r.color, primary: r.is_primary === 1, enabled: r.enabled === 1 }];
    } catch {
      return [];
    }
  });
}

export function setCalendarEnabled(userId: string, calKey: string, enabled: boolean): boolean {
  const r = db.prepare('UPDATE gcal_calendars SET enabled=? WHERE user_id=? AND cal_key=?').run(enabled ? 1 : 0, userId, calKey);
  if (!enabled) db.prepare('DELETE FROM gcal_events WHERE user_id=? AND cal_key=?').run(userId, calKey);
  if (r.changes) db.prepare('UPDATE gcal_sync SET next_attempt_at=0, last_sync_at=NULL WHERE user_id=?').run(userId);
  return r.changes > 0;
}

/** The mirrored events that overlap [from, to), from enabled calendars. */
export function listMirror(userId: string, from: Date, to: Date): MirrorEvent[] {
  const k = keys();
  if (!k) return [];
  const rows = db.prepare(`SELECT e.* FROM gcal_events e JOIN gcal_calendars c ON c.user_id=e.user_id AND c.cal_key=e.cal_key
    WHERE e.user_id=? AND c.enabled=1 AND e.start_ms < ? AND e.end_ms > ? ORDER BY e.start_ms`).all(userId, to.getTime(), from.getTime()) as EvRow[];
  return rows.flatMap((r) => {
    try {
      return [JSON.parse(k.box.open(r.sealed, evCtx(userId, r.event_key)).reveal()) as MirrorEvent];
    } catch {
      return [];
    }
  });
}

/** One mirrored event by its key. */
export function mirrorEvent(userId: string, eventKey: string): MirrorEvent | null {
  const k = keys();
  const r = db.prepare('SELECT * FROM gcal_events WHERE user_id=? AND event_key=?').get(userId, eventKey) as EvRow | undefined;
  if (!k || !r) return null;
  try { return JSON.parse(k.box.open(r.sealed, evCtx(userId, r.event_key)).reveal()) as MirrorEvent; } catch { return null; }
}

/** Forget the mirror for this person (they disconnected Google Calendar). */
export function clearMirror(userId: string) {
  db.prepare('DELETE FROM gcal_events WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM gcal_calendars WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM gcal_sync WHERE user_id=?').run(userId);
  hub.emit(userId, { type: 'calendar' });
}

export interface SyncStatus { lastSyncAt: number | null; lastError: string | null }
export function syncStatus(userId: string): SyncStatus {
  const r = db.prepare('SELECT last_sync_at, last_error FROM gcal_sync WHERE user_id=?').get(userId) as { last_sync_at: number | null; last_error: string | null } | undefined;
  return { lastSyncAt: r?.last_sync_at ?? null, lastError: r?.last_error ?? null };
}

// ---------- sync ----------

function noteFailure(userId: string, message: string, now: number) {
  const prev = (db.prepare('SELECT failures FROM gcal_sync WHERE user_id=?').get(userId) as { failures: number } | undefined)?.failures ?? 0;
  const failures = prev + 1;
  const wait = Math.min(MAX_BACKOFF_MS, SYNC_EVERY_MS * 2 ** (failures - 1));
  db.prepare(`INSERT INTO gcal_sync(user_id, last_error, failures, next_attempt_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_error=excluded.last_error, failures=excluded.failures, next_attempt_at=excluded.next_attempt_at`).run(userId, message.slice(0, 300), failures, now + wait);
}

const inFlight = new Map<string, Promise<SyncResult>>();
export type SyncResult = { ok: true; changes: number } | { ok: false; reason: string };

/** Sync one person's mirror now (one at a time per person). */
export function syncCalendar(userId: string, now = Date.now()): Promise<SyncResult> {
  const running = inFlight.get(userId);
  if (running) return running;
  const p = doSync(userId, now).finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
}

async function doSync(userId: string, now: number): Promise<SyncResult> {
  const k = keys();
  if (!k) return { ok: false, reason: (mirrorState() as { reason: string }).reason };

  // The calendars this account has; a new one is on only if it is the primary.
  const cals = await runAction(userId, 'GOOGLECALENDAR_LIST_CALENDARS', {});
  if (!cals.successful) { noteFailure(userId, `calendars: ${JSON.stringify(cals.error)}`, now); return { ok: false, reason: 'Google Calendar did not answer.' }; }
  const known = new Map((db.prepare('SELECT cal_key, enabled FROM gcal_calendars WHERE user_id=?').all(userId) as { cal_key: string; enabled: number }[]).map((r) => [r.cal_key, r.enabled]));
  const idByKey = new Map<string, string>();
  for (const c of (Array.isArray(rec(cals.data).calendars) ? rec(cals.data).calendars as unknown[] : []).map(rec)) {
    const id = str(c.id);
    if (!id) continue;
    const calKey = hmac(k.index, userId, 'cal', id);
    idByKey.set(calKey, id);
    const sealed = k.box.seal(new Secret(JSON.stringify({ id, name: str(c.summaryOverride) || str(c.summary) || id })), calCtx(userId, calKey));
    const primary = c.primary === true ? 1 : 0;
    db.prepare(`INSERT INTO gcal_calendars(user_id, cal_key, sealed, color, is_primary, enabled) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id, cal_key) DO UPDATE SET sealed=excluded.sealed, color=excluded.color, is_primary=excluded.is_primary`).run(userId, calKey, sealed, str(c.backgroundColor) || null, primary, known.get(calKey) ?? primary);
  }
  // A calendar the account no longer has goes, with its events.
  for (const calKey of known.keys()) if (!idByKey.has(calKey)) {
    db.prepare('DELETE FROM gcal_events WHERE user_id=? AND cal_key=?').run(userId, calKey);
    db.prepare('DELETE FROM gcal_calendars WHERE user_id=? AND cal_key=?').run(userId, calKey);
  }

  const enabled = (db.prepare('SELECT cal_key FROM gcal_calendars WHERE user_id=? AND enabled=1').all(userId) as { cal_key: string }[]).map((r) => r.cal_key).filter((ck) => idByKey.has(ck));
  const from = now - WINDOW_BACK_DAYS * DAY_MS;
  const to = now + WINDOW_AHEAD_DAYS * DAY_MS;
  const changes: MirrorChange[] = [];
  let partial: string | null = null;

  if (enabled.length) {
    const r = await runAction(userId, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', {
      time_min: new Date(from).toISOString(), time_max: new Date(to).toISOString(), calendar_ids: enabled.map((ck) => idByKey.get(ck)),
      single_events: true, show_deleted: true, response_detail: 'full', max_results_per_calendar: 2500,
    });
    if (!r.successful) { noteFailure(userId, `events: ${JSON.stringify(r.error)}`, now); return { ok: false, reason: 'Google Calendar did not answer.' }; }
    const d = rec(r.data);
    const failedIds = new Set(Object.keys(rec(d.errors_by_calendar)));
    const answered = new Set(enabled.filter((ck) => !failedIds.has(idByKey.get(ck)!)));
    const seen = new Set<string>();

    const existing = new Map((db.prepare('SELECT event_key, payload_hash, sealed FROM gcal_events WHERE user_id=?').all(userId) as { event_key: string; payload_hash: string; sealed: string }[]).map((x) => [x.event_key, x]));
    const open = (key: string, sealed: string) => { try { return JSON.parse(k.box.open(sealed, evCtx(userId, key)).reveal()) as MirrorEvent; } catch { return null; } };
    const upsert = db.prepare(`INSERT INTO gcal_events(user_id, event_key, cal_key, start_ms, end_ms, all_day, recurring, sealed, payload_hash, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, event_key) DO UPDATE SET cal_key=excluded.cal_key, start_ms=excluded.start_ms, end_ms=excluded.end_ms, all_day=excluded.all_day, recurring=excluded.recurring, sealed=excluded.sealed, payload_hash=excluded.payload_hash, updated_at=excluded.updated_at`);
    const remove = db.prepare('DELETE FROM gcal_events WHERE user_id=? AND event_key=?');

    db.transaction(() => {
      for (const item of (Array.isArray(d.events) ? d.events : []).map(rec)) {
        const e = rec(item.event);
        const calendarId = str(item.source_calendar_id);
        const calKey = hmac(k.index, userId, 'cal', calendarId);
        if (!answered.has(calKey) || !str(e.id)) continue;
        const key = hmac(k.index, userId, 'ev', calendarId, str(e.id));
        seen.add(key);
        const prev = existing.get(key);
        if (str(e.status) === 'cancelled') {
          if (prev) { const was = open(key, prev.sealed); remove.run(userId, key); if (was) changes.push({ kind: 'removed', event: was }); }
          continue;
        }
        const ev = toMirrorEvent(e, calendarId, calKey, key);
        if (!ev) continue;
        const plain = JSON.stringify(ev);
        const hash = crypto.createHash('sha256').update(plain).digest('base64url');
        if (prev?.payload_hash === hash) continue;
        upsert.run(userId, key, calKey, Date.parse(ev.start), Date.parse(ev.end), ev.allDay ? 1 : 0, ev.recurringEventId ? 1 : 0, k.box.seal(new Secret(plain), evCtx(userId, key)), hash, now);
        const was = prev ? open(key, prev.sealed) : null;
        changes.push(was ? { kind: 'changed', event: ev, before: was } : { kind: 'added', event: ev });
      }
      // Gone from a calendar that answered: removed. A calendar that failed keeps what it had.
      const inWindow = db.prepare('SELECT event_key, cal_key, sealed FROM gcal_events WHERE user_id=? AND start_ms < ? AND end_ms > ?').all(userId, to, from) as { event_key: string; cal_key: string; sealed: string }[];
      for (const row of inWindow) {
        if (seen.has(row.event_key) || !answered.has(row.cal_key)) continue;
        const was = open(row.event_key, row.sealed);
        remove.run(userId, row.event_key);
        if (was) changes.push({ kind: 'removed', event: was });
      }
      // Outside the window there is nothing to show; old rows go.
      db.prepare('DELETE FROM gcal_events WHERE user_id=? AND end_ms <= ?').run(userId, from);
    })();
    if (failedIds.size) partial = `${failedIds.size} calendar(s) could not be read; their events are kept as they were.`;
  } else {
    db.prepare('DELETE FROM gcal_events WHERE user_id=?').run(userId);
  }

  db.prepare(`INSERT INTO gcal_sync(user_id, last_sync_at, last_error, failures, next_attempt_at) VALUES (?,?,?,0,?)
    ON CONFLICT(user_id) DO UPDATE SET last_sync_at=excluded.last_sync_at, last_error=excluded.last_error, failures=0, next_attempt_at=excluded.next_attempt_at`).run(userId, now, partial, now + SYNC_EVERY_MS);
  if (changes.length) {
    hub.emit(userId, { type: 'calendar' });
    for (const fn of listeners) { try { fn(userId, changes); } catch (e) { console.warn('[calendar] change listener failed', (e as Error).message); } }
  }
  return { ok: true, changes: changes.length };
}

/** Sync in the background when the last sync is older than FRESH_MS and no backoff holds it. */
export function syncIfStale(userId: string, now = Date.now()): boolean {
  if (!keys()) return false;
  const s = db.prepare('SELECT last_sync_at, next_attempt_at, failures FROM gcal_sync WHERE user_id=?').get(userId) as { last_sync_at: number | null; next_attempt_at: number; failures: number } | undefined;
  if (s && s.failures > 0 && s.next_attempt_at > now) return false;
  if (s?.last_sync_at && now - s.last_sync_at < FRESH_MS) return false;
  void syncCalendar(userId, now).catch((e) => console.warn('[calendar] sync failed', (e as Error).message));
  return true;
}

let timer: NodeJS.Timeout | null = null;

/** Every SYNC_EVERY_MS, sync each person who has Google Calendar connected, unless their backoff holds. */
export function startCalendarSync() {
  if (timer || !keys()) return;
  const tick = async () => {
    const users = (db.prepare('SELECT id FROM users').all() as { id: string }[]).map((u) => u.id);
    for (const userId of users) {
      try {
        if (!(await connectedToolkits(userId)).has('googlecalendar')) continue;
        const s = db.prepare('SELECT next_attempt_at FROM gcal_sync WHERE user_id=?').get(userId) as { next_attempt_at: number } | undefined;
        if ((s?.next_attempt_at ?? 0) > Date.now()) continue;
        await syncCalendar(userId);
      } catch (e) {
        console.warn('[calendar] sync failed', (e as Error).message);
      }
    }
  };
  timer = setInterval(() => void tick(), SYNC_EVERY_MS);
  timer.unref?.();
  void tick();
}
