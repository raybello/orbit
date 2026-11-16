import type { CardBody, InitiativeLevel } from '@orbit/contracts';
import { db } from './db.js';
import { allows, briefingContext, cardTitle, signalKey, type InitiativeSignal } from './domain/initiative.js';

/**
 * The initiative tables, as queries. A leaf module (it imports only db.ts and the pure domain) because
 * routines.ts and agent/loop.ts need it too, and proactive.ts imports routines.ts.
 */

export interface PrimaryBot { id: string; name: string; initiative: InitiativeLevel }

/** The person's first primary Bot, which check-ins, briefings and signals all go to. */
export function primaryBotOf(userId: string): PrimaryBot | null {
  return (db.prepare(
    "SELECT id, name, initiative FROM bots WHERE user_id=? AND is_primary=1 AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room' ORDER BY created_at ASC LIMIT 1",
  ).get(userId) as PrimaryBot | undefined) ?? null;
}

export type RoutineRunStatus = 'ok' | 'failed' | 'stopped';

/** How the run that started at `last_run_at` ended (runRoutine marks it 'running' when it starts). */
export function recordRoutineOutcome(routineId: string, status: RoutineRunStatus) {
  db.prepare("UPDATE routines SET last_run_status=? WHERE id=? AND last_run_status='running'").run(status, routineId);
}

const briefingOwner = (routineId: string) =>
  db.prepare('SELECT m.user_id, b.initiative FROM morning_briefings m JOIN bots b ON b.id=m.bot_id WHERE m.routine_id=?').get(routineId) as
    | { user_id: string; initiative: InitiativeLevel }
    | undefined;

/** Whether a routine's cron may fire. Only the briefing is gated, by its own Bot's initiative. */
export function scheduledRunAllowed(routineId: string): boolean {
  const owner = briefingOwner(routineId);
  return !owner || allows(owner.initiative, 'briefing');
}

export interface WaitingCard { botId: string; botName: string; generation: number; seq: number; title: string; since: number }

/** Cards still pending in a Bot's current conversation, created inside [after, before]. */
export function waitingCards(userId: string, window: { after: number; before: number }): WaitingCard[] {
  const rows = db.prepare(
    `SELECT r.bot_id, b.name, r.generation, r.seq, r.body, r.created_at FROM rows r JOIN bots b ON b.id=r.bot_id AND r.generation=b.generation
     WHERE b.user_id=? AND r.kind='card' AND json_extract(r.body,'$.status')='pending' AND r.created_at >= ? AND r.created_at <= ?
     ORDER BY r.created_at ASC LIMIT 20`,
  ).all(userId, window.after, window.before) as { bot_id: string; name: string; generation: number; seq: number; body: string; created_at: number }[];
  return rows.map((r) => ({ botId: r.bot_id, botName: r.name, generation: r.generation, seq: r.seq, title: cardTitle(JSON.parse(r.body) as CardBody), since: r.created_at }));
}

const BRIEFING_LOOKBACK_MS = 3 * 86_400_000;

/** The prompt a routine runs with. The briefing also carries the team's open tasks and waiting cards. */
export function routinePrompt(r: { id: string; prompt: string }, at: number): string {
  const owner = briefingOwner(r.id);
  if (!owner) return r.prompt;
  const tasks = db.prepare(
    "SELECT b.name botName, t.title, t.state FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? AND t.state IN ('working','needs_input') ORDER BY t.updated_at DESC LIMIT 15",
  ).all(owner.user_id) as { botName: string; title: string; state: 'working' | 'needs_input' }[];
  const waiting = waitingCards(owner.user_id, { after: at - BRIEFING_LOOKBACK_MS, before: at });
  return `${r.prompt}\n\n${briefingContext({ tasks, waiting })}`;
}

// ------------------------------------------------------------------ signal outbox

/** False when this occurrence was queued before (pending, delivered or suppressed). */
export function queueSignal(userId: string, signal: InitiativeSignal, at: number): boolean {
  return db.prepare('INSERT OR IGNORE INTO initiative_signals(user_id,key,kind,payload,created_at) VALUES (?,?,?,?,?)')
    .run(userId, signalKey(signal), signal.kind, JSON.stringify(signal), at).changes === 1;
}

export function pendingSignals(userId: string): InitiativeSignal[] {
  return (db.prepare("SELECT payload FROM initiative_signals WHERE user_id=? AND state='pending' ORDER BY created_at ASC").all(userId) as { payload: string }[])
    .map((r) => JSON.parse(r.payload) as InitiativeSignal);
}

export function settleSignals(userId: string, signals: readonly InitiativeSignal[], state: 'delivered' | 'suppressed', at: number) {
  const settle = db.prepare("UPDATE initiative_signals SET state=?, settled_at=? WHERE user_id=? AND key=? AND state='pending'");
  db.transaction(() => { for (const s of signals) settle.run(state, at, userId, signalKey(s)); })();
}

/** Forget settled signals settled before `before`; pending ones wait however long it takes. */
export function pruneSignals(before: number) {
  db.prepare("DELETE FROM initiative_signals WHERE state<>'pending' AND settled_at < ?").run(before);
}
