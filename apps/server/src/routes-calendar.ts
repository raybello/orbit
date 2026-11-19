import { Hono } from 'hono';
import { db } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { createRoutine } from './routines.js';
import { requireBody, CalendarToggleSchema, CreateRoutineSchema, GoogleEventCreateSchema, GoogleEventPatchSchema, type CreateRoutineBody } from './api/schemas.js';
import { listCalendars, listMirror, mirrorEvent, mirrorState, setCalendarEnabled, syncCalendar, syncIfStale, syncStatus } from './calendar/mirror.js';
import { duplicateDefaults, linkRoutine, parentTitles } from './calendar/links.js';
import { createGoogleEvent, deleteGoogleEvent, toGoogleEvent, updateGoogleEvent } from './calendar/actions.js';
import type { CalendarEvent } from '@orbit/contracts';
import { buildCalendar, type CalendarRoutineRow } from './domain/calendar-view.js';

/** /api/calendar and the calendar's POST /api/routines. */
export const calendarApi = new Hono<AuthVars>();
calendarApi.use('*', requireUser);

export type { CalendarRoutineRow };

const DAY_MS = 24 * 60 * 60 * 1000;

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

  // Google events from the person's mirror, refreshed in the background when it is over a minute old.
  const state = mirrorState();
  const cals = new Map(listCalendars(user.id).map((cal) => [cal.key, cal]));
  if (state.available && cals.size) syncIfStale(user.id);
  const google = state.available ? listMirror(user.id, from, to).map((e) => toGoogleEvent(e, cals)) : [];
  const sync = syncStatus(user.id);
  const orbit = buildCalendar(rows, from, to);
  const parents = parentTitles([...new Set(orbit.map((e) => e.routineId))]);
  const paused = new Set(rows.filter((r) => r.enabled === 0).map((r) => r.id));
  return c.json({
    events: orbit.map((e) => ({
      ...e,
      ...(parents.has(e.routineId) ? { parentTitle: parents.get(e.routineId) } : {}),
      ...(paused.has(e.routineId) ? { paused: true } : {}),
    })),
    google,
    googleState: { available: state.available, ...(state.available ? {} : { reason: state.reason }), connected: cals.size > 0, lastSyncAt: sync.lastSyncAt, lastError: sync.lastError },
  });
});

/** GET /api/calendar/google → the Google calendars, which are shown, and how the mirror is doing. */
calendarApi.get('/calendar/google', (c) => {
  const user = c.get('user');
  return c.json({ state: mirrorState(), calendars: listCalendars(user.id).map(({ id: _id, ...cal }) => cal), sync: syncStatus(user.id) });
});

/** PATCH /api/calendar/google/:key → show or hide one Google calendar. */
calendarApi.patch('/calendar/google/:key', async (c) => {
  const user = c.get('user');
  const { enabled } = await requireBody(c, CalendarToggleSchema);
  if (!setCalendarEnabled(user.id, c.req.param('key'), enabled)) return c.json({ error: 'No such calendar.' }, 404);
  void syncCalendar(user.id).catch(() => {});
  return c.json({ ok: true });
});

/** POST /api/calendar/google/sync → sync now. */
calendarApi.post('/calendar/google/sync', async (c) => {
  const r = await syncCalendar(c.get('user').id);
  return r.ok ? c.json({ ok: true, changes: r.changes }) : c.json({ error: r.reason }, 503);
});

/** GET /api/calendar/google/events/:key/duplicate → what an Orbit event made from this one starts with. */
calendarApi.get('/calendar/google/events/:key/duplicate', async (c) => {
  const d = await duplicateDefaults(c.get('user').id, c.req.param('key'));
  return d ? c.json(d) : c.json({ error: 'That event is no longer in your calendar.' }, 404);
});

/** POST /api/calendar/google/events → create a Google event (no bot). */
calendarApi.post('/calendar/google/events', async (c) => {
  const body = await requireBody(c, GoogleEventCreateSchema);
  return c.json({ ok: true, ...(await createGoogleEvent(c.get('user').id, body)) }, 201);
});

/** PATCH /api/calendar/google/events/:key → change one, with the scope for a repeating event. */
calendarApi.patch('/calendar/google/events/:key', async (c) => {
  const { edits } = await requireBody(c, GoogleEventPatchSchema);
  await updateGoogleEvent(c.get('user').id, c.req.param('key'), edits);
  return c.json({ ok: true });
});

/** DELETE /api/calendar/google/events/:key?scope=&notify= → delete one, its series, or it and later ones. */
calendarApi.delete('/calendar/google/events/:key', async (c) => {
  const scope = c.req.query('scope');
  const notify = c.req.query('notify');
  if (scope && !['this', 'following', 'all'].includes(scope)) return c.json({ error: 'scope must be this, following or all.' }, 400);
  await deleteGoogleEvent(c.get('user').id, c.req.param('key'), { ...(scope ? { scope: scope as 'this' | 'following' | 'all' } : {}), ...(notify ? { notifyGuests: notify !== '0' } : {}) });
  return c.json({ ok: true });
});

/** POST /api/routines → create a calendar event (a routine with calendar metadata). */
calendarApi.post('/routines', async (c) => {
  const user = c.get('user');

  let body: CreateRoutineBody;
  try {
    body = await requireBody(c, CreateRoutineSchema);
  } catch {
    return c.json({ error: 'Expected a JSON body.' }, 400);
  }

  const botId = body.botId ?? '';
  if (!botId) return c.json({ error: 'botId is required.' }, 400);

  const bot = db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').get(botId, user.id) as { id: string } | undefined;
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

  // Made from a Google event: it must be one of this person's, still in their calendar.
  const parentKey = typeof body.parentEventKey === 'string' && body.parentEventKey ? body.parentEventKey : null;
  if (parentKey && !mirrorEvent(user.id, parentKey)) return c.json({ error: 'That Google event is no longer in your calendar.' }, 404);

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
    if (parentKey) linkRoutine(user.id, routine.id, parentKey, body.eventType === 'one_time' && body.eventDate ? new Date(body.eventDate) : null);
    hub.emit(user.id, { type: 'routines', botId: routine.botId });
    return c.json({ routine }, 201);
  } catch (e) {
    // createRoutine only throws for input it has already validated against, e.g. a bad cron.
    return c.json({ error: (e as Error).message }, 400);
  }
});
