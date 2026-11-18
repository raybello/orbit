/**
 * One-shot cron expressions for one-time calendar events. Its own module so the calendar link code
 * (calendar/links.ts) can use it without importing routines.ts, which imports that code.
 */

/** The date's wall-clock fields in `timeZone`, so a one-shot cron fires at the instant asked for. */
function zonedFields(d: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month) };
}

/** A cron expression for exactly one run at `d`: "minute hour day month *". */
export function oneShotCron(d: Date, timeZone = 'UTC'): string {
  const f = zonedFields(d, timeZone);
  return `${f.minute} ${f.hour} ${f.day} ${f.month} *`;
}
