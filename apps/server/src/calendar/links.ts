import { db } from '../db.js';
import { env } from '../env.js';
import { appendRow } from '../store.js';
import { hub } from '../lib/hub.js';
import { Secret, secretBox, SecretBoxUnavailableError } from '../lib/secret-box.js';
import { runAction } from '../composio.js';
import { readEvent, wallClock } from '../review/event.js';
import { listCalendars, mirrorEvent, onMirrorChanges, type MirrorEvent } from './mirror.js';
import { oneShotCron } from '../lib/one-shot-cron.js';
import type { DuplicateDefaults } from '@orbit/contracts';

/**
 * Orbit events made from Google events ("Duplicate as Orbit event").
 *
 * The routine keeps the mirror key of its Google parent, how far before or after the parent it runs,
 * and a sealed snapshot of the parent (title, time, calendar, place, guests, notes, link) so its bot
 * gets that context when it runs, even after the parent is gone. The snapshot is sealed like the
 * mirror itself (DB_ENCRYPTION_KEY, bound to the routine).
 *
 * Following the parent: when a sync finds the parent moved, a one-time Orbit event moves with it,
 * keeping its offset; when the parent is cancelled or removed, the Orbit event is paused and its
 * bot's chat says why. A repeating Orbit event is left alone and gets a notice when its series changes.
 */

export const DEFAULT_PROMPT = (title: string, when: string) =>
  `Prepare me for “${title}” at ${when}: check the attendees, related email threads and docs, and send me a short brief.`;

const box = () => {
  try { return secretBox(env.dbEncryptionKey); } catch (e) { if (e instanceof SecretBoxUnavailableError) return null; throw e; }
};
const snapCtx = (routineId: string) => `gcal-parent:${routineId}`;

interface Snapshot { title: string; start: string; end: string; allDay: boolean; timezone: string; calendar: string; location: string; attendees: string[]; description: string; link: string }

const snapshotOf = (e: MirrorEvent, calendar: string): Snapshot => ({
  title: e.title, start: e.start, end: e.end, allDay: e.allDay, timezone: e.timezone, calendar,
  location: e.location, attendees: e.attendees, description: e.description.slice(0, 2000), link: e.htmlLink,
});

const whenText = (s: { start: string; allDay: boolean; timezone: string }) =>
  s.allDay ? `${s.start.slice(0, 10)} (all day)` : `${wallClock(s.start, s.timezone).replace('T', ' ')} (${s.timezone})`;

// ---------- RRULE → cron ----------

const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * A Google repeat rule as a 5-field cron at the event's wall-clock time, or why cron cannot say it.
 * Cron has no "every other", no "the second Tuesday", and no end, so those are refused.
 */
export function rruleToCron(lines: string[], localStart: string): { cron: string } | { reason: string } {
  const rule = lines.find((l) => l.startsWith('RRULE:'));
  if (!rule) return { reason: 'The Google series has no repeat rule Orbit can read.' };
  if (lines.some((l) => /^(EXRULE|RDATE|EXDATE)/.test(l))) return { reason: 'The Google series has added or skipped dates, which a repeating Orbit event cannot follow.' };
  const p = Object.fromEntries(rule.slice(6).split(';').map((kv) => kv.split('=')));
  if (p.INTERVAL && p.INTERVAL !== '1') return { reason: `It repeats every ${p.INTERVAL} ${String(p.FREQ).toLowerCase().replace(/ly$/, '').replace('dai', 'day')}s, which cron cannot express.` };
  if (p.COUNT || p.UNTIL) return { reason: 'The Google series ends on a set date; a repeating Orbit event cannot end by itself. Make it one-time, or add the end yourself later.' };
  if (p.BYSETPOS || p.BYWEEKNO || p.BYYEARDAY || p.BYHOUR || p.BYMINUTE) return { reason: 'The Google repeat rule is more detailed than cron can express.' };
  const [date, time = '00:00'] = localStart.split('T');
  const [, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const hm = `${minute} ${hour}`;
  switch (p.FREQ) {
    case 'DAILY':
      if (p.BYDAY) return byDay(p.BYDAY, hm);
      return { cron: `${hm} * * *` };
    case 'WEEKLY':
      return p.BYDAY ? byDay(p.BYDAY, hm) : { cron: `${hm} * * ${dow}` };
    case 'MONTHLY':
      if (p.BYDAY) return { reason: 'It repeats on a weekday of the month (like the first Monday), which cron cannot express.' };
      return { cron: `${hm} ${p.BYMONTHDAY ?? day} * *` };
    case 'YEARLY':
      if (p.BYDAY) return { reason: 'It repeats on a weekday of the year, which cron cannot express.' };
      return { cron: `${hm} ${p.BYMONTHDAY ?? day} ${p.BYMONTH ?? month} *` };
    default:
      return { reason: 'The Google repeat rule is not one Orbit can follow.' };
  }
}

function byDay(spec: string, hm: string): { cron: string } | { reason: string } {
  const days = spec.split(',');
  if (days.some((d) => !(d in DAYS))) return { reason: 'It repeats on a weekday of the month (like the first Monday), which cron cannot express.' };
  return { cron: `${hm} * * ${days.map((d) => DAYS[d]).sort((a, b) => a - b).join(',')}` };
}

// ---------- duplicating ----------

/** What the "Duplicate as Orbit event" dialog starts with for this Google event. */
export async function duplicateDefaults(userId: string, key: string): Promise<DuplicateDefaults | null> {
  const e = mirrorEvent(userId, key);
  if (!e) return null;
  const base: DuplicateDefaults = { title: e.title || 'Untitled event', start: e.start, timezone: e.timezone, prompt: DEFAULT_PROMPT(e.title || 'the event', whenText(e)), recurring: !!e.recurringEventId, cron: null };
  if (!e.recurringEventId) return base;
  const r = await runAction(userId, 'GOOGLECALENDAR_EVENTS_GET', { calendar_id: e.calendarId, event_id: e.recurringEventId });
  const series = r.successful ? readEvent(r.data) : null;
  const lines = Array.isArray(series?.recurrence) ? (series!.recurrence as string[]) : [];
  if (!lines.length) return { ...base, cronReason: 'The Google series could not be read.' };
  const local = e.allDay ? `${e.start.slice(0, 10)}T09:00` : wallClock(e.start, e.timezone);
  const c = rruleToCron(lines, local);
  return 'cron' in c ? { ...base, cron: c.cron } : { ...base, cronReason: c.reason };
}

/** Link a new routine to its Google parent: remember the parent, the offset, and a sealed snapshot. */
export function linkRoutine(userId: string, routineId: string, parentKey: string, runsAt: Date | null): boolean {
  const e = mirrorEvent(userId, parentKey);
  const b = box();
  if (!e || !b) return false;
  const calendar = listCalendars(userId).find((c) => c.key === e.calendarKey)?.name ?? '';
  const offset = runsAt ? runsAt.getTime() - Date.parse(e.start) : 0;
  db.prepare('UPDATE routines SET parent_event_key=?, parent_offset_ms=?, parent_sealed=? WHERE id=?')
    .run(parentKey, offset, b.seal(new Secret(JSON.stringify(snapshotOf(e, calendar))), snapCtx(routineId)), routineId);
  return true;
}

function snapshotFor(routineId: string, sealed: string | null): Snapshot | null {
  const b = box();
  if (!b || !sealed) return null;
  try { return JSON.parse(b.open(sealed, snapCtx(routineId)).reveal()) as Snapshot; } catch { return null; }
}

/** The parent's title for each linked routine, for the calendar's chip. */
export function parentTitles(routineIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!routineIds.length) return out;
  const rows = db.prepare(`SELECT id, parent_sealed FROM routines WHERE parent_sealed IS NOT NULL AND id IN (${routineIds.map(() => '?').join(',')})`).all(...routineIds) as { id: string; parent_sealed: string }[];
  for (const r of rows) { const s = snapshotFor(r.id, r.parent_sealed); if (s) out.set(r.id, s.title || 'Google event'); }
  return out;
}

/** What the bot is told about the Google event a routine was made from, when it runs. */
export function parentContext(routine: { id: string; parent_sealed?: string | null }): string {
  const s = snapshotFor(routine.id, routine.parent_sealed ?? null);
  if (!s) return '';
  const lines = [
    `This routine was made from the user's Google Calendar event “${s.title}” on ${whenText(s)}${s.calendar ? `, calendar “${s.calendar}”` : ''}.`,
    s.location ? `Where: ${s.location}` : '',
    s.attendees.length ? `Guests: ${s.attendees.join(', ')}` : '',
    s.description ? `Event notes: ${s.description}` : '',
    s.link ? `Link: ${s.link}` : '',
  ].filter(Boolean);
  return `\n\n${lines.join('\n')}`;
}

// ---------- following the parent ----------

interface LinkedRow { id: string; bot_id: string; name: string; event_type: string; enabled: number; completed_at: string | null; timezone: string | null; parent_offset_ms: number | null; parent_sealed: string | null }

let reschedule: ((routineId: string) => void) | null = null;
let unschedule: ((routineId: string) => void) | null = null;
/** The scheduler's hooks, set by routines.ts at start (it imports this module, not the other way round). */
export function setLinkScheduler(hooks: { reschedule: (id: string) => void; unschedule: (id: string) => void }) {
  reschedule = hooks.reschedule;
  unschedule = hooks.unschedule;
}

onMirrorChanges((userId, changes) => {
  const b = box();
  for (const c of changes) {
    if (c.kind === 'added') continue;
    const rows = db.prepare('SELECT r.* FROM routines r JOIN bots bo ON bo.id=r.bot_id WHERE bo.user_id=? AND r.parent_event_key=?').all(userId, c.event.key) as LinkedRow[];
    for (const r of rows) {
      if (r.completed_at) continue;
      if (c.kind === 'removed') {
        if (r.enabled) {
          db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run(r.id);
          unschedule?.(r.id);
          appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-updated', text: `Paused “${r.name}”: the Google event “${c.event.title}” it was made from was cancelled.`, ref: r.id });
          hub.emit(userId, { type: 'routines', botId: r.bot_id });
        }
        continue;
      }
      if (c.event.start === c.before.start) continue;
      if (r.event_type !== 'one_time') {
        appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-updated', text: `The Google event “${c.event.title}” moved; “${r.name}” repeats on its own schedule and was not changed.`, ref: r.id });
        continue;
      }
      const at = new Date(Date.parse(c.event.start) + (r.parent_offset_ms ?? 0));
      if (at.getTime() <= Date.now()) continue;
      db.prepare('UPDATE routines SET event_date=?, schedule=? WHERE id=?').run(at.toISOString(), oneShotCron(at, r.timezone || 'UTC'), r.id);
      if (b) {
        const calendar = listCalendars(userId).find((x) => x.key === c.event.calendarKey)?.name ?? '';
        db.prepare('UPDATE routines SET parent_sealed=? WHERE id=?').run(b.seal(new Secret(JSON.stringify(snapshotOf(c.event, calendar))), snapCtx(r.id)), r.id);
      }
      if (r.enabled) reschedule?.(r.id);
      appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-updated', text: `Moved “${r.name}” to ${whenText({ start: at.toISOString(), allDay: false, timezone: r.timezone || 'UTC' })}, following the Google event “${c.event.title}”.`, ref: r.id });
      hub.emit(userId, { type: 'routines', botId: r.bot_id });
    }
  }
});
