import type { EventFields, GoogleCalendarEvent } from '@orbit/contracts';

/** An instant as wall-clock time in a timezone: "YYYY-MM-DDTHH:mm". */
export function wallClock(instant: string | Date, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** A Google event (ISO instants) as card fields in its own timezone; an all-day end is its last day. */
export function fieldsOfGoogle(e: GoogleCalendarEvent): EventFields {
  return {
    summary: e.title, description: e.description, location: e.location,
    start: e.allDay ? e.start.slice(0, 10) : wallClock(e.start, e.timezone),
    end: e.allDay ? addDays(e.end.slice(0, 10), -1) : wallClock(e.end, e.timezone),
    allDay: e.allDay, timezone: e.timezone, attendees: e.attendees, meet: Boolean(e.meetLink),
  };
}

/** The local days an event covers, as YYYY-MM-DD keys (all-day events by their own dates). */
export function daysOf(start: string, end: string, allDay: boolean, keyOf: (d: Date) => string): string[] {
  if (allDay) {
    const out: string[] = [];
    for (let d = start.slice(0, 10); d < end.slice(0, 10) && out.length < 62; d = addDays(d, 1)) out.push(d);
    return out.length ? out : [start.slice(0, 10)];
  }
  const s = new Date(start);
  const e = new Date(Math.max(Date.parse(end) - 1, s.getTime()));
  const out: string[] = [];
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= e && out.length < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(keyOf(d));
  return out;
}
