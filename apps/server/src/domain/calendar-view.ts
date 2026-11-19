import { Cron } from 'croner';
import { isEventSchedule } from '../triggers.js';
import type { CalendarEvent } from '@orbit/contracts';

/** How long a calendar entry is shown as lasting. Routines have no end time of their own. */
export const EVENT_MINUTES = 30;
/** Safety valve: one badly-written cron in a wide window must not return unbounded rows. */
export const MAX_OCCURRENCES_PER_ROUTINE = 200;

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
  enabled?: number;
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
