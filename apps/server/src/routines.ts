import { Cron } from 'croner';
import { db, now } from './db.js';
import { appendRow, toRoutine, type RoutineRow } from './store.js';
import { newId } from './lib/ids.js';
import type { Routine } from '@orbit/contracts';
import type { Trigger } from './core/turn-queue.js';
import { isEventSchedule, setEventRoutineEnabled } from './triggers.js';
import { routinePrompt, scheduledRunAllowed } from './initiative-store.js';
import { parentContext, setLinkScheduler } from './calendar/links.js';
import { oneShotCron } from './lib/one-shot-cron.js';

export { oneShotCron };

const jobs = new Map<string, Cron>();
let enqueueFn: ((botId: string, t: Trigger) => void) | null = null;

/** Wire the queue a routine run lands in. Also used by tests, which do not want live timers. */
export function setRoutineEnqueue(enqueue: (botId: string, t: Trigger) => void) {
  enqueueFn = enqueue;
}

export function initRoutines(enqueue: (botId: string, t: Trigger) => void) {
  setRoutineEnqueue(enqueue);
  const all = db.prepare("SELECT * FROM routines WHERE enabled=1 AND schedule NOT LIKE 'event:%'").all() as RoutineRow[];
  for (const r of all) scheduleRoutine({ id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone } as Routine);
  console.log(`[routines] scheduled ${jobs.size}`);
}

export function scheduleRoutine(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  if (isEventSchedule(r.schedule)) { void setEventRoutineEnabled(r.id, true); return; }
  unscheduleRoutine(r.id);
  try {
    // A scheduled briefing is unsolicited, so its Bot's initiative can hold it back; Run now always runs.
    const job = new Cron(r.schedule, { timezone: r.timezone || 'UTC', protect: true }, () => { if (scheduledRunAllowed(r.id)) runRoutine(r.id); });
    jobs.set(r.id, job);
  } catch (e) {
    console.warn('[routines] bad schedule', r.id, r.schedule, (e as Error).message);
  }
}

export function unscheduleRoutine(id: string) {
  const row = db.prepare('SELECT schedule FROM routines WHERE id=?').get(id) as { schedule: string } | undefined;
  if (row && isEventSchedule(row.schedule)) void setEventRoutineEnabled(id, false);
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function runRoutine(id: string) {
  const r = db.prepare('SELECT * FROM routines WHERE id=?').get(id) as RoutineRow | undefined;
  if (!r || !enqueueFn) return;
  const at = now();
  db.prepare("UPDATE routines SET last_run_at=?, last_run_status='running' WHERE id=?").run(at, id);
  appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-run', text: `Running routine: ${r.name}`, ref: id });
  // A calendar event can be assigned to another bot; it still logs on the bot that owns it.
  // An Orbit event made from a Google event also gets that event's details.
  enqueueFn(r.assigned_bot_id || r.bot_id, { type: 'routine', routineId: id, name: r.name, prompt: routinePrompt(r, at) + parentContext(r as RoutineRow & { parent_sealed?: string | null }) });
  // A one-time event is done once it has run: record it, stop it, and leave it on the calendar as
  // completed rather than deleting it.
  if (r.event_type === 'one_time') {
    db.prepare('UPDATE routines SET completed_at=?, enabled=0 WHERE id=?').run(new Date(now()).toISOString(), id);
    unscheduleRoutine(id);
  }
}

export interface CreateRoutineInput {
  botId: string;
  title: string;
  prompt: string;
  eventType: 'recurring' | 'one_time';
  schedule?: string;
  eventDate?: string;
  timezone?: string;
  description?: string;
  /** Defaults to on; a seeded routine starts off until the person turns it on. */
  enabled?: boolean;
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
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
  ).run(id, input.botId, title, prompt, schedule, timezone, input.enabled === false ? 0 : 1, now(), title, eventType, eventDate);

  const routine = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id) as RoutineRow);
  if (routine.enabled) scheduleRoutine(routine);
  return routine;
}

// Orbit events made from Google events move with them (calendar/links.ts asks the scheduler to re-arm one).
setLinkScheduler({
  reschedule: (id) => {
    const row = db.prepare('SELECT * FROM routines WHERE id=?').get(id) as RoutineRow | undefined;
    if (row) { unscheduleRoutine(id); scheduleRoutine(toRoutine(row)); }
  },
  unschedule: (id) => unscheduleRoutine(id),
});
