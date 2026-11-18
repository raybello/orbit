import { z } from 'zod';
import type { EventFields, EventReview, ReviewPayload } from '@orbit/contracts';
import { runAction } from '../composio.js';
import { ReviewEditError, type Applied, type PreStep, type ReviewAdapter } from './types.js';

/**
 * The Event card: creating, changing, deleting and quick-adding Google Calendar events.
 *
 * What phase 0 found shapes this file:
 *  - GOOGLECALENDAR_UPDATE_EVENT replaces the whole event and drops attendees, location and
 *    description it is not given. Every change therefore runs as PATCH_EVENT with only the fields
 *    that changed, including a bot's own UPDATE_EVENT.
 *  - Create takes `start_datetime` plus `end_datetime` or a duration (or `start_date`/`end_date` for
 *    all-day, end exclusive) and `create_meeting_room`; patch takes `start_time`/`end_time` and
 *    `conference_data`. Both take `timezone`, `attendees` (a list that replaces the guests) and
 *    `send_updates` ('all' | 'externalOnly' | 'none').
 *  - Responses wrap the event differently per action; readEvent() handles every wrapper seen.
 *
 * Times on the card are local wall-clock times in the event's timezone ("2026-11-19T15:00"), and
 * an all-day event's `end` is its last day (inclusive), as people read it.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The event inside any calendar response: `response_data`, `event`, `items[0]` or the data itself. */
export function readEvent(data: unknown): Record<string, unknown> {
  const d = rec(data);
  if (rec(d.response_data).id || rec(d.response_data).start) return rec(d.response_data);
  if (rec(d.event).id) return rec(d.event);
  if (Array.isArray(d.items) && d.items.length) return rec(d.items[0]);
  return d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An instant as wall-clock time in a timezone: "YYYY-MM-DDTHH:mm". */
export function wallClock(instant: string | Date, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The instant a wall-clock time in a timezone names. */
export function instantOf(local: string, timeZone: string): Date {
  const [date, time = '00:00'] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // The offset at that moment, read back from the timezone; one correction covers DST edges.
  const offsetAt = (t: number) => { const w = wallClock(new Date(t), timeZone); const [wd, wt] = w.split('T'); const [a, b, c] = wd.split('-').map(Number); const [e, f] = wt.split(':').map(Number); return Date.UTC(a, b - 1, c, e, f) - t; };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMinutes = (local: string, n: number) => { const d = new Date(`${local}:00Z`); d.setUTCMinutes(d.getUTCMinutes() + n); return d.toISOString().slice(0, 16); };
const minutesBetween = (a: string, b: string) => Math.round((new Date(`${b}:00Z`).getTime() - new Date(`${a}:00Z`).getTime()) / 60_000);

/** An attendee list as addresses, from strings or `{ email }` objects. */
const emails = (v: unknown): string[] => (Array.isArray(v) ? v.map((a) => (typeof a === 'string' ? a : str(rec(a).email))).map((x) => x.trim()).filter(Boolean) : []);

/** A Google event (as EVENTS_GET returns it) as card fields. The organizer is not listed as a guest. */
export function fieldsFromEvent(e: Record<string, unknown>): EventFields {
  const start = rec(e.start);
  const end = rec(e.end);
  const timezone = str(start.timeZone) || str(end.timeZone) || 'UTC';
  const allDay = Boolean(str(start.date)) && !str(start.dateTime);
  const guests = (Array.isArray(e.attendees) ? e.attendees : []).map(rec).filter((a) => !(a.organizer === true && a.self === true)).map((a) => str(a.email)).filter(Boolean);
  return {
    summary: str(e.summary),
    description: str(e.description),
    location: str(e.location),
    start: allDay ? str(start.date) : wallClock(str(start.dateTime), timezone),
    end: allDay ? addDays(str(end.date) || str(start.date), -1) : wallClock(str(end.dateTime) || str(start.dateTime), timezone),
    allDay,
    timezone,
    attendees: guests,
    meet: Boolean(e.hangoutLink) || Boolean(rec(e.conferenceData).conferenceId) || Boolean(rec(e.conferenceData).createRequest),
  };
}

/** A naive or zoned datetime argument as wall-clock time in `tz`. */
const localOf = (v: unknown, tz: string) => {
  const s = str(v);
  if (!s) return '';
  return /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? wallClock(s, tz) : s.replace(' ', 'T').slice(0, 16);
};

/** A GOOGLECALENDAR_CREATE_EVENT call as card fields. */
export function fieldsFromCreate(args: Record<string, unknown>): EventFields {
  const timezone = str(args.timezone) || 'UTC';
  const allDay = Boolean(str(args.start_date)) && !str(args.start_datetime);
  const start = allDay ? str(args.start_date) : localOf(args.start_datetime, timezone);
  const duration = (Number(args.event_duration_hour) || 0) * 60 + (Number(args.event_duration_minutes) || 0);
  const end = allDay
    ? addDays(str(args.end_date) || addDays(start, 1), -1)
    : localOf(args.end_datetime, timezone) || (start ? addMinutes(start, duration || 30) : '');
  return {
    summary: str(args.summary), description: str(args.description), location: str(args.location),
    start, end, allDay, timezone, attendees: emails(args.attendees), meet: args.create_meeting_room === true,
  };
}

/** The fields a PATCH_EVENT or UPDATE_EVENT call names, over the event as it is. */
function fieldsFromChange(before: EventFields, args: Record<string, unknown>): EventFields {
  const timezone = str(args.timezone) || before.timezone;
  const startArg = args.start_time ?? args.start_datetime;
  const endArg = args.end_time ?? args.end_datetime;
  const out: EventFields = { ...before, timezone };
  for (const k of ['summary', 'description', 'location'] as const) if (typeof args[k] === 'string') out[k] = args[k] as string;
  if (Array.isArray(args.attendees)) out.attendees = emails(args.attendees);
  if (typeof startArg === 'string' && startArg) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(startArg)) { out.allDay = true; out.start = startArg; }
    else { out.allDay = false; out.start = localOf(startArg, timezone); }
  }
  if (typeof endArg === 'string' && endArg) out.end = /^\d{4}-\d{2}-\d{2}$/.test(endArg) ? addDays(endArg, -1) : localOf(endArg, timezone);
  else if (typeof startArg === 'string' && startArg && !out.allDay && !before.allDay) {
    const minutes = minutesBetween(before.start, before.end) || Number(args.event_duration_minutes) || 30;
    out.end = addMinutes(out.start, minutes);
  }
  if (rec(args.conference_data).createRequest || args.create_meeting_room === true) out.meet = true;
  return out;
}

const ACTIONS: Record<string, EventReview['action']> = {
  GOOGLECALENDAR_CREATE_EVENT: 'create', GOOGLECALENDAR_QUICK_ADD: 'quick_add', GOOGLECALENDAR_PATCH_EVENT: 'update',
  GOOGLECALENDAR_UPDATE_EVENT: 'update', GOOGLECALENDAR_DELETE_EVENT: 'delete', GOOGLECALENDAR_REMOVE_ATTENDEE: 'remove_attendee',
  GOOGLECALENDAR_EVENTS_MOVE: 'move',
};

/** Read the event as it is now; null when it cannot be read. */
async function current(userId: string, calendarId: string, eventId: string): Promise<Record<string, unknown> | null> {
  if (!eventId) return null;
  const r = await runAction(userId, 'GOOGLECALENDAR_EVENTS_GET', { calendar_id: calendarId, event_id: eventId });
  if (!r.successful) return null;
  const e = readEvent(r.data);
  return e.id || e.start ? e : null;
}

/** Recurring events: an instance knows its series (`recurringEventId`); a series has `recurrence`. */
function recurringOf(e: Record<string, unknown> | null): EventReview['recurring'] | undefined {
  if (!e) return undefined;
  if (str(e.recurringEventId)) return { scope: 'this' };
  if (Array.isArray(e.recurrence) && e.recurrence.length) return { scope: 'all' };
  return undefined;
}

/** Notify guests unless the bot said not to; the person decides on the card. */
const notifyOf = (args: Record<string, unknown>) => str(args.send_updates) !== 'none';

export const eventReview: ReviewAdapter = {
  kind: 'event',
  slugs: Object.keys(ACTIONS),
  alwaysApply: true,

  async build(userId, slug, args) {
    const action = ACTIONS[slug];
    const calendarId = str(args.calendar_id) || 'primary';
    const eventId = str(args.event_id);
    const base = { kind: 'event' as const, action, calendarId, ...(eventId ? { eventId } : {}), notifyGuests: notifyOf(args) };
    if (action === 'create') return { ...base, fields: fieldsFromCreate(args), editable: true };
    if (action === 'quick_add') return { ...base, fields: { summary: str(args.text), description: '', location: '', start: '', end: '', allDay: false, timezone: 'UTC', attendees: [], meet: false }, editable: false };

    const now = await current(userId, calendarId, eventId);
    if (!now) {
      // The card still shows what the bot asked for; without the event as it is, it cannot be edited safely.
      return { ...base, ...(action === 'update' ? { fields: fieldsFromChange(fieldsFromCreate({}), args) } : {}), editable: false };
    }
    const before = fieldsFromEvent(now);
    const recurring = recurringOf(now);
    const common = { ...base, before, ...(recurring ? { recurring } : {}) };
    if (action === 'update') return { ...common, fields: fieldsFromChange(before, args), editable: true };
    if (action === 'delete') return { ...common, editable: true };
    if (action === 'remove_attendee') {
      const gone = str(args.attendee_email).toLowerCase();
      return { ...common, fields: { ...before, attendees: before.attendees.filter((a) => a.toLowerCase() !== gone) }, editable: false };
    }
    return { ...common, editable: false };
  },

  validate(review, edits) {
    parseEdits(review, edits);
  },

  async apply(userId, slug, args, review, edits) {
    if (review.kind !== 'event') throw new ReviewEditError('This card is not a calendar event.');
    const e = parseEdits(review, edits);
    return applyEvent(userId, slug, args, review, e);
  },
};

const Local = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, 'Times need a date (and a time unless the event is all-day).');
const EventEditsSchema = z.strictObject({
  summary: z.string().max(1024).optional(),
  description: z.string().max(8000).optional(),
  location: z.string().max(1024).optional(),
  start: Local.optional(),
  end: Local.optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().min(1).max(64).optional(),
  attendees: z.array(z.string().trim().regex(/@/, 'Each guest needs an email address.').max(320)).max(200).optional(),
  meet: z.boolean().optional(),
  scope: z.enum(['this', 'following', 'all']).optional(),
  notifyGuests: z.boolean().optional(),
});

type Edits = z.infer<typeof EventEditsSchema>;

function parseEdits(review: ReviewPayload, edits: unknown): Edits {
  if (review.kind !== 'event') throw new ReviewEditError('This card is not a calendar event.');
  const parsed = EventEditsSchema.safeParse(edits ?? {});
  if (!parsed.success) throw new ReviewEditError(parsed.error.issues[0]?.message ?? 'Those changes could not be read.');
  const e = parsed.data;
  if (e.timezone && !validZone(e.timezone)) throw new ReviewEditError(`“${e.timezone}” is not a timezone.`);
  if (e.scope && !review.recurring) throw new ReviewEditError('This event does not repeat.');
  const f = review.fields ? { ...review.fields, ...pick(e) } : undefined;
  if (f && f.start && f.end) {
    const ok = f.allDay ? f.end >= f.start.slice(0, 10) : f.end > f.start;
    if (!ok) throw new ReviewEditError('The event has to end after it starts.');
  }
  return e;
}

const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const pick = (e: Edits): Partial<EventFields> => Object.fromEntries(Object.entries(e).filter(([k, v]) => v !== undefined && k !== 'scope' && k !== 'notifyGuests')) as Partial<EventFields>;

/** Sentences for the bot: what the person changed. */
function describe(before: EventFields, after: EventFields): string[] {
  const out: string[] = [];
  if (before.summary !== after.summary) out.push(`title changed to “${after.summary}”`);
  if (before.start !== after.start || before.end !== after.end || before.allDay !== after.allDay || before.timezone !== after.timezone) {
    out.push(after.allDay ? `set to all day ${after.start}${after.end !== after.start ? ` to ${after.end}` : ''}` : `time changed to ${after.start.replace('T', ' ')}–${after.end.slice(11)} (${after.timezone})`);
  }
  if (before.location !== after.location) out.push(after.location ? `location changed to “${after.location}”` : 'location removed');
  if (before.description !== after.description) out.push('description edited');
  const was = new Set(before.attendees.map((a) => a.toLowerCase()));
  const now = new Set(after.attendees.map((a) => a.toLowerCase()));
  const added = after.attendees.filter((a) => !was.has(a.toLowerCase()));
  const removed = before.attendees.filter((a) => !now.has(a.toLowerCase()));
  if (added.length) out.push(`guests added: ${added.join(', ')}`);
  if (removed.length) out.push(`guests removed: ${removed.join(', ')}`);
  if (before.meet !== after.meet) out.push(after.meet ? 'Google Meet link added' : 'Google Meet link removed');
  return out;
}

/** Every argument GOOGLECALENDAR_PATCH_EVENT takes (toolkit 20261116_00); others are not passed to it. */
const PATCH_PARAMS = new Set(["source", "status", "summary", "color_id", "end_time", "event_id", "location", "sequence", "timezone", "attendees", "reminders", "recurrence", "start_time", "visibility", "attachments", "calendar_id", "description", "send_updates", "transparency", "max_attendees", "rsvp_response", "conference_data", "attendees_omitted", "guests_can_modify", "anyone_can_add_self", "extended_properties", "supports_attachments", "focus_time_properties", "conference_data_version", "guests_can_invite_others", "out_of_office_properties", "guests_can_see_other_guests", "working_location_properties"]);

/** A bot's GOOGLECALENDAR_UPDATE_EVENT as PATCH_EVENT arguments: only what it named, under patch's names. */
function updateAsPatch(args: Record<string, unknown>, before: EventFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'start_datetime') out.start_time = v;
    else if (k === 'end_datetime') out.end_time = v;
    else if (k === 'create_meeting_room') { if (v === true && !before.meet) { out.conference_data = { createRequest: { requestId: `orbit-${Date.now().toString(36)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } }; out.conference_data_version = 1; } }
    else if (k === 'guestsCanModify') out.guests_can_modify = v;
    else if (k === 'guestsCanInviteOthers') out.guests_can_invite_others = v;
    else if (k === 'guestsCanSeeOtherGuests') out.guests_can_see_other_guests = v;
    else if (PATCH_PARAMS.has(k)) out[k] = v;
  }
  // UPDATE takes a duration where patch needs an end.
  if (out.start_time && !out.end_time && !before.allDay) {
    const minutes = (Number(args.event_duration_hour) || 0) * 60 + (Number(args.event_duration_minutes) || 0) || minutesBetween(before.start, before.end) || 30;
    const tz = str(args.timezone) || before.timezone;
    out.end_time = `${addMinutes(localOf(out.start_time, tz), minutes)}:00`;
    out.timezone ??= tz;
  }
  return out;
}

/** Bot arguments that are not card fields (colour, visibility, reminders…), kept when the person edits. */
const extras = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([k]) => PATCH_PARAMS.has(k) && !['summary', 'description', 'location', 'start_time', 'end_time', 'timezone', 'attendees', 'conference_data', 'conference_data_version', 'send_updates', 'event_id', 'calendar_id'].includes(k)));

/** Card fields as GOOGLECALENDAR_CREATE_EVENT arguments. */
function createArgs(f: EventFields): Record<string, unknown> {
  if (!f.start) return { summary: f.summary, description: f.description, location: f.location, timezone: f.timezone, attendees: f.attendees, create_meeting_room: f.meet };
  const times = f.allDay
    ? { start_date: f.start.slice(0, 10), end_date: addDays(f.end.slice(0, 10), 1) }
    : { start_datetime: `${f.start}:00`, end_datetime: `${f.end}:00` };
  return { summary: f.summary, description: f.description, location: f.location, timezone: f.timezone, attendees: f.attendees, create_meeting_room: f.meet, ...times };
}

/** Only what differs between `before` and `after`, as GOOGLECALENDAR_PATCH_EVENT arguments. */
function patchArgs(before: EventFields, after: EventFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['summary', 'description', 'location'] as const) if (before[k] !== after[k]) out[k] = after[k];
  if (before.start !== after.start || before.end !== after.end || before.allDay !== after.allDay || before.timezone !== after.timezone) {
    if (after.allDay) { out.start_time = after.start.slice(0, 10); out.end_time = addDays(after.end.slice(0, 10), 1); }
    else { out.start_time = `${after.start}:00`; out.end_time = `${after.end}:00`; out.timezone = after.timezone; }
  }
  if (before.attendees.join(',').toLowerCase() !== after.attendees.join(',').toLowerCase()) out.attendees = after.attendees;
  if (!before.meet && after.meet) {
    out.conference_data = { createRequest: { requestId: `orbit-${Date.now().toString(36)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    out.conference_data_version = 1;
  }
  return out;
}

const SCOPE_WORDS = { this: 'this event only', following: 'this and following events', all: 'every event in the series' } as const;

/** An RRULE line that stops before `instant` (UTC, inclusive end), with any COUNT dropped. */
function endBefore(lines: string[], instant: Date, allDay: boolean): string[] {
  const until = allDay
    ? addDays(instant.toISOString().slice(0, 10), -1).replace(/-/g, '')
    : new Date(instant.getTime() - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return lines.map((l) => (l.startsWith('RRULE:') ? `RRULE:${l.slice(6).split(';').filter((p) => !/^(COUNT|UNTIL)=/.test(p)).concat(`UNTIL=${until}`).join(';')}` : l));
}
/**
 * The series rule for a new series that continues from an instance. A COUNT cannot carry over (the
 * new series starts part-way), so it becomes an UNTIL at the old series' last event, read from
 * Google; the new series then ends exactly where the old one would have.
 */
async function continued(userId: string, calendarId: string, seriesId: string, lines: string[]): Promise<string[]> {
  const rule = lines.find((l) => l.startsWith('RRULE:'));
  const count = Number(/COUNT=(\d+)/.exec(rule ?? '')?.[1] ?? 0);
  if (!count) return lines;
  const r = await runAction(userId, 'GOOGLECALENDAR_EVENTS_INSTANCES', { calendarId, eventId: seriesId, maxResults: Math.min(count, 2500) });
  const items = (rec(r.data).items as unknown[] | undefined) ?? [];
  const last = rec(items[items.length - 1]);
  const lastStart = str(rec(last.start).dateTime) || str(rec(last.start).date);
  if (!r.successful || !lastStart) throw new ReviewEditError('The repeating series could not be read to its end, so it cannot be split here. Choose “This event” or “All events”.');
  const until = lastStart.length === 10 ? lastStart.replace(/-/g, '') : new Date(lastStart).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return lines.map((l) => (l.startsWith('RRULE:') ? `RRULE:${l.slice(6).split(';').filter((p) => !/^(COUNT|UNTIL)=/.test(p)).concat(`UNTIL=${until}`).join(';')}` : l));
}

async function applyEvent(userId: string, slug: string, args: Record<string, unknown>, review: EventReview, e: Edits): Promise<Applied> {
  const notify = e.notifyGuests ?? review.notifyGuests;
  const sendUpdates = notify ? 'all' : 'none';
  const changes: string[] = [];
  if (e.notifyGuests !== undefined && e.notifyGuests !== review.notifyGuests) changes.push(notify ? 'guests will be notified' : 'guests will not be notified');
  const calendar_id = review.calendarId;

  const personEdited = Object.keys(pick(e)).length > 0;
  const notifyChanged = e.notifyGuests !== undefined && e.notifyGuests !== review.notifyGuests;
  const scopeChanged = e.scope !== undefined && e.scope !== review.recurring?.scope;

  if (review.action === 'create') {
    // Untouched, the bot's call runs exactly as it was made.
    if (!personEdited) return { args: notifyChanged ? { ...args, send_updates: sendUpdates } : args, before: [], changes };
    const after = { ...review.fields!, ...pick(e) };
    changes.unshift(...describe(review.fields!, after));
    // The bot's other arguments (colour, visibility, reminders…) are kept; the card's fields win.
    const kept = Object.fromEntries(Object.entries(args).filter(([k]) => !['start_datetime', 'end_datetime', 'start_date', 'end_date', 'event_duration_hour', 'event_duration_minutes'].includes(k)));
    return { args: { ...kept, ...createArgs(after), calendar_id, send_updates: sendUpdates }, before: [], changes };
  }
  if (review.action === 'quick_add') return { args: notifyChanged ? { ...args, send_updates: sendUpdates } : args, before: [], changes };
  if (review.action === 'remove_attendee' || review.action === 'move') return { args, before: [], changes };

  const scope = e.scope ?? review.recurring?.scope;
  if (e.scope && review.recurring && e.scope !== review.recurring.scope) changes.push(`applies to ${SCOPE_WORDS[e.scope]}`);
  const instance = review.recurring?.scope === 'this';
  const eventId = review.eventId ?? str(args.event_id);

  // Which event the change lands on, and the series around an instance when the scope reaches it.
  let seriesId = eventId;
  let series: Record<string, unknown> | null = null;
  if (review.recurring && scope !== 'this') {
    const inst = instance ? await current(userId, calendar_id, eventId) : null;
    seriesId = instance ? str(inst?.recurringEventId) : eventId;
    series = await current(userId, calendar_id, seriesId);
    if (!series) throw new ReviewEditError('The repeating series could not be read, so this change cannot be applied to it. Choose “This event” instead.');
  }

  if (review.action === 'delete') {
    if (!notifyChanged && !scopeChanged) return { args, before: [], changes };
    if (scope === 'following' && series) {
      const original = (series.recurrence as string[]) ?? [];
      const at = instantOf(review.before!.start.length > 10 ? review.before!.start : `${review.before!.start}T00:00`, review.before!.timezone);
      return { slug: 'GOOGLECALENDAR_PATCH_EVENT', args: { calendar_id, event_id: seriesId, recurrence: endBefore(original, at, review.before!.allDay), send_updates: sendUpdates }, before: [], changes };
    }
    return { args: { ...args, calendar_id, event_id: scope === 'all' ? seriesId : eventId, send_updates: sendUpdates }, before: [], changes };
  }

  // An update. The bot's UPDATE_EVENT would drop what it does not name, so every update is a patch.
  const before = review.before ?? review.fields!;
  const after = { ...review.fields!, ...pick(e) };
  const botChanged = describe(before, review.fields!);
  const personChanged = describe(review.fields!, after);
  changes.unshift(...personChanged);
  const rewritten = slug === 'GOOGLECALENDAR_UPDATE_EVENT' ? ['ran as a patch, so fields the bot did not name (guests, location, description) were kept'] : [];
  const diff = { ...extras(slug === 'GOOGLECALENDAR_UPDATE_EVENT' ? updateAsPatch(args, before) : args), ...patchArgs(before, after) };
  if (!personEdited && !scopeChanged) {
    // Untouched: a patch runs as the bot made it; an update runs as the equivalent patch.
    const asPatch = slug === 'GOOGLECALENDAR_UPDATE_EVENT' ? { calendar_id, event_id: eventId, ...updateAsPatch(args, before) } : args;
    return { slug: 'GOOGLECALENDAR_PATCH_EVENT', args: notifyChanged ? { ...asPatch, send_updates: sendUpdates } : asPatch, before: [], changes: [...changes, ...rewritten] };
  }

  if (scope === 'following' && series) {
    // End the series before this event, and start a new one here with the change applied.
    const original = (series.recurrence as string[]) ?? [];
    const at = instantOf(before.allDay ? `${before.start}T00:00` : before.start, before.timezone);
    const end: PreStep = { slug: 'GOOGLECALENDAR_PATCH_EVENT', args: { calendar_id, event_id: seriesId, recurrence: endBefore(original, at, before.allDay), send_updates: 'none' } };
    const undo: PreStep = { slug: 'GOOGLECALENDAR_PATCH_EVENT', args: { calendar_id, event_id: seriesId, recurrence: original, send_updates: 'none' } };
    const next = { ...fieldsFromEvent(series), ...after };
    return {
      slug: 'GOOGLECALENDAR_CREATE_EVENT',
      args: { ...createArgs(next), calendar_id, recurrence: await continued(userId, calendar_id, seriesId, original), send_updates: sendUpdates },
      before: [end], rollback: [undo],
      changes: [...changes, ...rewritten],
    };
  }
  if (scope === 'all' && series && instance) {
    // Changing the whole series from one of its events: the same change, shifted onto the series' own first event.
    const master = fieldsFromEvent(series);
    const shifted = { ...master, ...pick(e), ...(botChanged.length ? pickChanged(before, review.fields!) : {}) };
    if (before.start !== after.start && !after.allDay) {
      const delta = minutesBetween(before.start, after.start);
      const length = minutesBetween(after.start, after.end);
      shifted.start = addMinutes(master.start, delta);
      shifted.end = addMinutes(shifted.start, length);
    }
    return { slug: 'GOOGLECALENDAR_PATCH_EVENT', args: { calendar_id, event_id: seriesId, ...patchArgs(master, shifted), send_updates: sendUpdates }, before: [], changes: [...changes, ...rewritten] };
  }
  return { slug: 'GOOGLECALENDAR_PATCH_EVENT', args: { calendar_id, event_id: eventId, ...diff, send_updates: sendUpdates }, before: [], changes: [...changes, ...rewritten] };
}

/** The card fields the bot's own call changed, to carry onto the series. */
function pickChanged(before: EventFields, after: EventFields): Partial<EventFields> {
  const out: Partial<EventFields> = {};
  for (const k of Object.keys(after) as (keyof EventFields)[]) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) (out as Record<string, unknown>)[k] = after[k];
  return out;
}
