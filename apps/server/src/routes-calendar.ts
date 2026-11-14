import { Hono } from 'hono';
import { Cron } from 'croner';
import { db } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { createRoutine } from './routines.js';
import { isEventSchedule } from './triggers.js';
import type { CalendarEvent, CreateRoutineRequest } from './types.js';

/** /api/calendar and the calendar's POST /api/routines. */
export const calendarApi = new Hono<AuthVars>();
calendarApi.use('*', requireUser);

/** How long a calendar entry is shown as lasting. Routines have no end time of their own. */
export const EVENT_MINUTES = 30;
/** Safety valve: one badly-written cron in a wide window must not return unbounded rows. */
export const MAX_OCCURRENCES_PER_ROUTINE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A routine row joined with its bot's name (what GET /calendar reads). */
export interface CalendarRoutineRow {
  id: string;
  bot_id: string;
  bot_name: string;
  name: string;
  schedule: string;
  timezone: string | null;
  calendar_title: string | null;
  event_type: string | null;
  event_date: string | null;
  completed_at: string | null;
}

/**
 * Expand one routine into the occurrences inside [from, to).
 * A one-time event contributes its single event_date; a recurring one is expanded with croner.
 */
export function expandRoutine(row: CalendarRoutineRow, from: Date, to: Date): CalendarEvent[] {
  const botName = row.bot_name ?? '';
  const title = row.calendar_title || row.name;
  const base = { routineId: row.id, botId: row.bot_id, botName, title };

  if (row.event_type === 'one_time') {
    const start = row.event_date ? new Date(row.event_date) : null;
    if (!start || Number.isNaN(start.getTime())) return [];
    if (start.getTime() < from.getTime() || start.getTime() >= to.getTime()) return [];
    return [{
      ...base,
      start: start.toISOString(),
      end: new Date(start.getTime() + EVENT_MINUTES * 60_000).toISOString(),
      recurrenceRule: null,
      eventType: 'one_time',
      completedAt: row.completed_at ?? null,
    }];
  }

  // Event-triggered routines ('event:app_click') are not scheduled on the calendar.
  if (isEventSchedule(row.schedule)) return [];

  let cron: Cron;
  try {
    cron = new Cron(row.schedule, { timezone: row.timezone || 'UTC', paused: true });
  } catch {
    return [];
  }

  const events: CalendarEvent[] = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  // croner's nextRun(prev) is strictly after prev, so start one second early to include `from`.
  let cursor = new Date(fromMs - 1000);
  while (events.length < MAX_OCCURRENCES_PER_ROUTINE) {
    const next = cron.nextRun(cursor);
    if (!next) break;
    const startMs = next.getTime();
    if (startMs >= toMs) break;
    if (startMs > cursor.getTime() && startMs >= fromMs) {
      events.push({
        ...base,
        start: next.toISOString(),
        end: new Date(startMs + EVENT_MINUTES * 60_000).toISOString(),
        recurrenceRule: row.schedule,
        eventType: 'recurring',
        completedAt: row.completed_at ?? null,
      });
    }
    if (startMs <= cursor.getTime()) break; // malformed schedule: do not spin
    cursor = next;
  }
  cron.stop();
  return events;
}

/** Expand every routine and return the occurrences sorted by start. */
export function buildCalendar(rows: CalendarRoutineRow[], from: Date, to: Date): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const row of rows) events.push(...expandRoutine(row, from, to));
  return events.sort((a, b) => (a.start === b.start ? a.title.localeCompare(b.title) : a.start < b.start ? -1 : 1));
}

/**
 * Read one query bound. A bare YYYY-MM-DD is the local day it names: its midnight for `from`,
 * the following midnight for `to`, so `from=2026-03-01&to=2026-03-01` is that whole day.
 * Returns null when the value is not a date.
 */
export function parseCalendarBound(raw: string | undefined, edge: 'start' | 'end', fallback: Date): Date | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const date = new Date(y, m - 1, d);
    // Rejects values like 2026-02-31, which Date would silently roll into March.
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    if (edge === 'end') date.setDate(date.getDate() + 1);
    return date;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** GET /api/calendar?from=&to= → every occurrence in the window, across the user's bots. */
calendarApi.get('/calendar', (c) => {
  const user = c.get('user');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const from = parseCalendarBound(c.req.query('from'), 'start', today);
  const to = parseCalendarBound(c.req.query('to'), 'end', new Date(today.getTime() + 31 * DAY_MS));
  if (!from) return c.json({ error: 'from must be an ISO datetime or YYYY-MM-DD.' }, 400);
  if (!to) return c.json({ error: 'to must be an ISO datetime or YYYY-MM-DD.' }, 400);
  if (to.getTime() <= from.getTime()) return c.json({ error: 'to must be after from.' }, 400);

  const rows = db
    .prepare('SELECT r.*, b.name AS bot_name FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ORDER BY r.created_at')
    .all(user.id) as CalendarRoutineRow[];

  return c.json({ events: buildCalendar(rows, from, to) });
});

/** POST /api/routines → create a calendar event (a routine with calendar metadata). */
calendarApi.post('/routines', async (c) => {
  const user = c.get('user');

  let body: CreateRoutineRequest;
  try {
    body = await c.req.json<CreateRoutineRequest>();
  } catch {
    return c.json({ error: 'Expected a JSON body.' }, 400);
  }
  if (!body || typeof body !== 'object') return c.json({ error: 'Expected a JSON body.' }, 400);

  const botId = typeof body.botId === 'string' ? body.botId : '';
  if (!botId) return c.json({ error: 'botId is required.' }, 400);

  const bot = db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').get(botId, user.id) as any;
  if (!bot) return c.json({ error: 'botId must be one of your Bots.' }, 404);

  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return c.json({ error: 'prompt is required.' }, 400);
  if (body.eventType !== 'recurring' && body.eventType !== 'one_time') {
    return c.json({ error: "eventType must be 'recurring' or 'one_time'." }, 400);
  }
  if (body.eventType === 'recurring' && (typeof body.schedule !== 'string' || !body.schedule.trim())) {
    return c.json({ error: 'A recurring routine needs a 5-field cron schedule.' }, 400);
  }
  if (body.eventType === 'one_time' && (typeof body.eventDate !== 'string' || !body.eventDate.trim())) {
    return c.json({ error: 'A one-time event needs an ISO eventDate.' }, 400);
  }

  try {
    const routine = createRoutine({
      botId,
      title: typeof body.title === 'string' ? body.title : '',
      prompt: body.prompt,
      eventType: body.eventType,
      schedule: body.schedule,
      eventDate: body.eventDate,
      timezone: body.timezone,
      description: body.description,
    });
    hub.emit(user.id, { type: 'routines', botId: routine.botId });
    return c.json({ routine }, 201);
  } catch (e) {
    // createRoutine only throws for input it has already validated against, e.g. a bad cron.
    return c.json({ error: (e as Error).message }, 400);
  }
});
