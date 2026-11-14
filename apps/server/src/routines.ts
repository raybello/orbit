import { Cron } from 'croner';
import { db, now } from './db.js';
import { appendRow, toRoutine } from './store.js';
import { newId } from './lib/ids.js';
import type { Routine } from './types.js';
import { isEventSchedule, setEventRoutineEnabled } from './triggers.js';

const jobs = new Map<string, Cron>();
let enqueueFn: ((botId: string, t: any) => void) | null = null;

/** Wire the queue a routine run lands in. Also used by tests, which do not want live timers. */
export function setRoutineEnqueue(enqueue: (botId: string, t: any) => void) {
  enqueueFn = enqueue;
}

export function initRoutines(enqueue: (botId: string, t: any) => void) {
  setRoutineEnqueue(enqueue);
  const all = db.prepare("SELECT * FROM routines WHERE enabled=1 AND schedule NOT LIKE 'event:%'").all() as any[];
  for (const r of all) scheduleRoutine({ id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone } as Routine);
  console.log(`[routines] scheduled ${jobs.size}`);
}

export function scheduleRoutine(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  if (isEventSchedule(r.schedule)) { void setEventRoutineEnabled(r.id, true); return; }
  unscheduleRoutine(r.id);
  try {
    const job = new Cron(r.schedule, { timezone: r.timezone || 'UTC', protect: true }, () => runRoutine(r.id));
    jobs.set(r.id, job);
  } catch (e) {
    console.warn('[routines] bad schedule', r.id, r.schedule, (e as Error).message);
  }
}

export function unscheduleRoutine(id: string) {
  const row = db.prepare('SELECT schedule FROM routines WHERE id=?').get(id) as any;
  if (row && isEventSchedule(row.schedule)) void setEventRoutineEnabled(id, false);
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function runRoutine(id: string) {
  const r = db.prepare('SELECT * FROM routines WHERE id=?').get(id) as any;
  if (!r || !enqueueFn) return;
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), id);
  appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-run', text: `Running routine: ${r.name}`, ref: id });
  // A calendar event can be assigned to another bot; it still logs on the bot that owns it.
  enqueueFn(r.assigned_bot_id || r.bot_id, { type: 'routine', routineId: id, name: r.name, prompt: r.prompt });
  // A one-time event is done once it has run: record it, stop it, and leave it on the calendar as
  // completed rather than deleting it.
  if (r.event_type === 'one_time') {
    db.prepare('UPDATE routines SET completed_at=?, enabled=0 WHERE id=?').run(new Date(now()).toISOString(), id);
    unscheduleRoutine(id);
  }
}

// ---------- calendar events ----------

export interface CreateRoutineInput {
  botId: string;
  title: string;
  prompt: string;
  eventType: 'recurring' | 'one_time';
  schedule?: string;
  eventDate?: string;
  timezone?: string;
  description?: string;
}

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

/**
 * Create a calendar-backed routine. Recurring ones take a 5-field cron; one-time ones take an ISO
 * datetime, from which we derive a single-fire cron so the existing scheduler needs no special case.
 */
export function createRoutine(input: CreateRoutineInput): Routine {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) throw new Error('A routine needs a prompt.');

  const title = (input.title ?? '').trim() || prompt.slice(0, 80);
  const eventType = input.eventType;
  if (eventType !== 'recurring' && eventType !== 'one_time') throw new Error("eventType must be 'recurring' or 'one_time'.");

  const timezone = (input.timezone ?? '').trim() || 'UTC';
  let schedule: string;
  let eventDate: string | null = null;

  if (eventType === 'one_time') {
    const parsed = input.eventDate ? new Date(input.eventDate) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new Error('A one-time event needs a valid ISO eventDate.');
    eventDate = parsed.toISOString();
    // Keep the timezone consistent with the cron we derive: the date's own instant.
    schedule = oneShotCron(parsed, timezone);
  } else {
    schedule = (input.schedule ?? '').trim();
    if (!schedule) throw new Error('A recurring routine needs a 5-field cron schedule.');
    try {
      new Cron(schedule, { timezone, paused: true });
    } catch (e) {
      throw new Error(`Invalid cron schedule "${schedule}": ${(e as Error).message}`);
    }
  }

  const id = newId('rtn');
  db.prepare(
    `INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,calendar_title,event_type,event_date,assigned_bot_id,completed_at)
     VALUES (?,?,?,?,?,?,1,?,?,?,?,NULL,NULL)`,
  ).run(id, input.botId, title, prompt, schedule, timezone, now(), title, eventType, eventDate);

  const routine = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id));
  scheduleRoutine(routine);
  return routine;
}
