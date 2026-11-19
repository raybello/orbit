import type { EventFields, GoogleCalendarEvent } from '@orbit/contracts';

/** An instant as wall-clock time in a timezone: "YYYY-MM-DDTHH:mm". */
export function wallClock(instant: string | Date, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const addDaysStr = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** A Google event (ISO instants) as card fields in its own timezone; an all-day end is its last day. */
export function fieldsOfGoogle(e: GoogleCalendarEvent): EventFields {
  return {
    summary: e.title, description: e.description, location: e.location,
    start: e.allDay ? e.start.slice(0, 10) : wallClock(e.start, e.timezone),
    end: e.allDay ? addDaysStr(e.end.slice(0, 10), -1) : wallClock(e.end, e.timezone),
    allDay: e.allDay, timezone: e.timezone, attendees: e.attendees, meet: Boolean(e.meetLink),
  };
}

/** The local days an event covers, as YYYY-MM-DD keys (all-day events by their own dates). */
export function daysOf(start: string, end: string, allDay: boolean, keyOf: (d: Date) => string): string[] {
  if (allDay) {
    const out: string[] = [];
    for (let d = start.slice(0, 10); d < end.slice(0, 10) && out.length < 62; d = addDaysStr(d, 1)) out.push(d);
    return out.length ? out : [start.slice(0, 10)];
  }
  const s = new Date(start);
  const e = new Date(Math.max(Date.parse(end) - 1, s.getTime()));
  const out: string[] = [];
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= e && out.length < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(keyOf(d));
  return out;
}

/** Cron needs five (or six) whitespace-separated fields. */
export const looksLikeCron = (s: string) => /^\s*\S+(\s+\S+){4,5}\s*$/.test(s);

export interface CronPreset { value: string; label: string; cron: string }

export const CRON_PRESETS: CronPreset[] = [
  { value: 'daily', label: 'Daily 09:00', cron: '0 9 * * *' },
  { value: 'weekly', label: 'Weekly Mon 09:00', cron: '0 9 * * 1' },
  { value: 'weekdays', label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { value: 'custom', label: 'Custom', cron: '' },
];

export const TIMINGS: { value: string; label: string; at: (start: Date) => Date }[] = [
  { value: 'same', label: 'Same time', at: (s) => s },
  { value: '15m', label: '15 min before', at: (s) => new Date(s.getTime() - 15 * 60_000) },
  { value: '1h', label: '1 hour before', at: (s) => new Date(s.getTime() - 60 * 60_000) },
  { value: 'eve', label: '9:00 the day before', at: (s) => new Date(s.getFullYear(), s.getMonth(), s.getDate() - 1, 9, 0) },
];

type Mode = 'month' | 'week' | 'day';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date) => addDays(startOfDay(d), -d.getDay());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

export interface CalendarRange { start: Date; end: Date; days: Date[] }

export function rangeFor(mode: Mode, cursor: Date): CalendarRange {
  if (mode === 'day') {
    const start = startOfDay(cursor);
    return { start, end: addDays(start, 1), days: [start] };
  }
  if (mode === 'week') {
    const start = startOfWeek(cursor);
    return { start, end: addDays(start, 7), days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
  }
  // Month: always six weeks so the grid height never jumps between months.
  const start = startOfWeek(startOfMonth(cursor));
  return { start, end: addDays(start, 42), days: Array.from({ length: 42 }, (_, i) => addDays(start, i)) };
}
