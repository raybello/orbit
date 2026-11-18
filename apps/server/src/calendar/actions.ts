import type { EventEdits, EventFields, GoogleCalendarEvent } from '@orbit/contracts';
import { runAction } from '../composio.js';
import { applyReviewEdits, buildReview } from '../review/index.js';
import { createArgs, readEvent } from '../review/event.js';
import { listCalendars, mirrorEvent, syncCalendar, type MirrorEvent } from './mirror.js';

/**
 * The person changing their own Google Calendar from the Orbit calendar. No bot is involved and no
 * approval card: the page itself shows the person what will happen and asks them to confirm. The
 * changes go through the same event review logic the cards use (so a change is always a patch, a
 * repeating event asks its scope, and a two-step "this and following" is undone if it fails half-way),
 * then the mirror is synced so the calendar shows the result.
 */

export class CalendarActionError extends Error {
  constructor(readonly status: 400 | 404 | 502 | 503, message: string) {
    super(message);
    this.name = 'CalendarActionError';
  }
}

/** A mirrored event as the calendar shows it. */
export function toGoogleEvent(e: MirrorEvent, calendars: Map<string, { name: string; color: string | null }>): GoogleCalendarEvent {
  const cal = calendars.get(e.calendarKey);
  return {
    key: e.key, calendarKey: e.calendarKey, calendarName: cal?.name ?? '', color: cal?.color ?? null,
    title: e.title, description: e.description, location: e.location, attendees: e.attendees,
    start: e.start, end: e.end, allDay: e.allDay, timezone: e.timezone, meetLink: e.meetLink, htmlLink: e.htmlLink, recurring: !!e.recurringEventId,
  };
}

const failed = (slug: string, error: unknown) => new CalendarActionError(502, `Google Calendar did not accept it (${slug}): ${JSON.stringify(error).slice(0, 200)}`);

/** Run a reviewed change: its first steps, the change, and the undo if the change fails. */
async function runApplied(userId: string, slug: string, a: Awaited<ReturnType<typeof applyReviewEdits>>) {
  for (const step of a.before) {
    const r = await runAction(userId, step.slug, step.args);
    if (!r.successful) throw failed(step.slug, r.error);
  }
  const main = a.slug ?? slug;
  const r = await runAction(userId, main, a.args);
  if (!r.successful) {
    for (const step of a.rollback ?? []) await runAction(userId, step.slug, step.args).catch(() => null);
    throw failed(main, r.error);
  }
  return r.data;
}

function find(userId: string, key: string): MirrorEvent {
  const e = mirrorEvent(userId, key);
  if (!e) throw new CalendarActionError(404, 'That event is no longer in your calendar.');
  return e;
}

/** Create a Google event in one of the person's calendars (the primary one unless they chose). */
export async function createGoogleEvent(userId: string, input: { calendarKey?: string; fields: EventFields; notifyGuests?: boolean }) {
  const cals = listCalendars(userId);
  const cal = input.calendarKey ? cals.find((c) => c.key === input.calendarKey) : cals.find((c) => c.primary);
  if (!cal) throw new CalendarActionError(404, 'That calendar is not connected.');
  const args = { ...createArgs(input.fields), calendar_id: cal.id, send_updates: input.notifyGuests === false ? 'none' : 'all' };
  const review = await buildReview(userId, 'GOOGLECALENDAR_CREATE_EVENT', args);
  // Checking through the review catches an end before the start, a bad timezone or guest.
  const a = await applyReviewEdits(userId, 'GOOGLECALENDAR_CREATE_EVENT', args, review, {});
  const data = await runApplied(userId, 'GOOGLECALENDAR_CREATE_EVENT', a);
  await syncCalendar(userId).catch(() => null);
  return { eventId: String(readEvent(data).id ?? '') };
}

/** Change a Google event: only what the person changed, for the scope they chose. */
export async function updateGoogleEvent(userId: string, key: string, edits: EventEdits) {
  const e = find(userId, key);
  const args = { calendar_id: e.calendarId, event_id: e.eventId };
  const review = await buildReview(userId, 'GOOGLECALENDAR_PATCH_EVENT', args);
  if (!review || !review.editable) throw new CalendarActionError(502, 'The event could not be read from Google, so it cannot be changed now.');
  await runApplied(userId, 'GOOGLECALENDAR_PATCH_EVENT', await applyReviewEdits(userId, 'GOOGLECALENDAR_PATCH_EVENT', args, review, edits));
  await syncCalendar(userId).catch(() => null);
}

/** Delete a Google event, or its series, or it and the ones after it. */
export async function deleteGoogleEvent(userId: string, key: string, opts: { scope?: 'this' | 'following' | 'all'; notifyGuests?: boolean }) {
  const e = find(userId, key);
  const args = { calendar_id: e.calendarId, event_id: e.eventId };
  const review = await buildReview(userId, 'GOOGLECALENDAR_DELETE_EVENT', args);
  if (!review || !review.editable) throw new CalendarActionError(502, 'The event could not be read from Google, so it cannot be deleted now.');
  const edits = { ...(opts.scope ? { scope: opts.scope } : {}), ...(opts.notifyGuests !== undefined ? { notifyGuests: opts.notifyGuests } : {}) };
  await runApplied(userId, 'GOOGLECALENDAR_DELETE_EVENT', await applyReviewEdits(userId, 'GOOGLECALENDAR_DELETE_EVENT', args, review, edits));
  await syncCalendar(userId).catch(() => null);
}
