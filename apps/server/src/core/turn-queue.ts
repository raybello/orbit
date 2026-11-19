import { db } from '../db.js';
import { newId } from '../lib/ids.js';
import {
  RETRY_WINDOW_MS, freshRun, nextStep, reassessInput, resumeInput, retryInput,
  type AttemptOutcome, type Repair, type RunState,
} from '../domain/supervisor-policy.js';
import { failureReason } from '../domain/turn-failure.js';

/**
 * The per-bot turn scheduler and its supervisor. A bot handles one turn at a time, in arrival
 * order. Each thing it is asked to do is a run (a `turn_runs` row) that may take several attempts:
 * when an attempt fails or the bot gets stuck, domain/supervisor-policy.ts decides whether to
 * retry, repair, send it to reassess, or give up, and the run survives a server restart.
 *
 * The agent loop registers how an attempt runs and how the bot is repaired and told, so routes,
 * schedulers and tools can queue work without importing the loop itself.
 */

export type Trigger =
  /**
   * `voice`: asked on a live call. The caller is listening for the first word, so the turn runs at
   * low reasoning effort whatever the bot's own setting is: thinking tokens are seconds of silence.
   */
  | { type: 'user'; text: string; voice?: boolean }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  /** `_groupDepth` is set by the group-chat dispatcher (agent/rooms.ts): how many bot-to-bot hops into one group conversation this turn is. */
  | { type: 'system'; text: string; _groupDepth?: number };

/** What the bot is sent for a trigger. */
export function triggerText(t: Trigger): string {
  switch (t.type) {
    case 'user': return t.text;
    case 'routine': return `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}`;
    case 'bot': return `[Message from ${t.fromName}, another Bot on the team. Reply to them with send_to_bot if they asked you something.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
  }
}

export type SupervisorNotice = 'retrying' | 'reassessing' | 'gave-up';

export interface TurnRunner {
  runTurn(botId: string, trigger: Trigger, signal: AbortSignal): Promise<AttemptOutcome>;
  expireApprovals(botId: string): void;
  /** Refresh the bot's inherited sign-in, restart its agent, or clear a turn its agent lost, before a retry. */
  repair(botId: string, what: Repair): Promise<void>;
  /** Tell the person, in the bot's chat, what the supervisor did. */
  notice(botId: string, kind: SupervisorNotice, text: string): void;
  /** A run reached its end: a routine records how it went. */
  finished(root: Trigger, status: 'ok' | 'failed' | 'stopped'): void;
  botName(botId: string): string;
}

let runner: TurnRunner | null = null;
const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();
/** Retries waiting for their time, by run id. */
const waiting = new Map<string, { botId: string; timer: NodeJS.Timeout }>();

export function registerTurnRunner(r: TurnRunner) {
  runner = r;
}

/** The registered runner, for a test that replaces one of its parts. */
export const currentTurnRunner = (): TurnRunner => requireRunner();

/** Scales every supervisor wait. Tests set it near zero; nothing else changes it. */
export const supervisorTiming = { scale: 1 };

/** A retry timer never keeps the process alive: the run's row is what survives, and resumeRuns() picks it up. */
const later = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms * supervisorTiming.scale);
  t.unref?.();
  return t;
};

function requireRunner(): TurnRunner {
  if (!runner) throw new Error('No turn runner registered; import agent/loop.js at boot.');
  return runner;
}

// ---------- runs ----------

interface RunRow { id: string; bot_id: string; root: string; state: string; run_state: string; next_input: string | null; next_attempt_at: number | null; updated_at: number }

const setRun = (id: string, fields: { state: string; run_state?: RunState; next_input?: string | null; next_attempt_at?: number | null; last_error?: string | null }) => {
  const cur = db.prepare('SELECT * FROM turn_runs WHERE id=?').get(id) as RunRow | undefined;
  if (!cur) return;
  db.prepare('UPDATE turn_runs SET state=?, run_state=?, next_input=?, next_attempt_at=?, last_error=COALESCE(?, last_error), updated_at=? WHERE id=?').run(
    fields.state,
    fields.run_state ? JSON.stringify(fields.run_state) : cur.run_state,
    fields.next_input === undefined ? cur.next_input : fields.next_input,
    fields.next_attempt_at === undefined ? cur.next_attempt_at : fields.next_attempt_at,
    fields.last_error ?? null,
    Date.now(), id,
  );
};

function queueJob(botId: string, job: () => Promise<void>) {
  const prev = queues.get(botId) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => console.error('[agent] turn failed', botId, e));
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
}

/** Queue one attempt at a run. `trigger` is what this attempt sends: the root itself, or a continuation. */
function attemptLater(runId: string, botId: string, root: Trigger, trigger: Trigger) {
  queueJob(botId, () => attempt(runId, botId, root, trigger));
}

async function attempt(runId: string, botId: string, root: Trigger, trigger: Trigger) {
  const row = db.prepare('SELECT * FROM turn_runs WHERE id=?').get(runId) as RunRow | undefined;
  if (!row || row.state === 'stopped' || row.state === 'done' || row.state === 'failed') return;
  const r = requireRunner();
  setRun(runId, { state: 'running', next_attempt_at: null });
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  let outcome: AttemptOutcome;
  try {
    outcome = await r.runTurn(botId, trigger, ctrl.signal);
  } catch (e) {
    outcome = { ok: false, failure: { kind: 'fatal', message: String((e as Error)?.message ?? e) }, events: [] };
  } finally {
    if (aborts.get(botId) === ctrl) aborts.delete(botId);
  }
  settle(runId, botId, root, JSON.parse(row.run_state) as RunState, outcome);
}

/** Act on how an attempt ended. */
function settle(runId: string, botId: string, root: Trigger, state: RunState, outcome: AttemptOutcome) {
  const r = requireRunner();
  const next = nextStep(state, outcome, Date.now(), r.botName(botId));
  const request = triggerText(root);
  const lastError = !outcome.ok && 'failure' in outcome ? outcome.failure.message : null;
  switch (next.do) {
    case 'done':
      setRun(runId, { state: 'done', next_input: null });
      r.finished(root, 'ok');
      return;
    case 'stopped':
      setRun(runId, { state: 'stopped', next_input: null });
      r.finished(root, 'stopped');
      return;
    case 'give-up':
      setRun(runId, { state: 'failed', next_input: null, last_error: lastError });
      r.notice(botId, 'gave-up', next.notice);
      r.finished(root, 'failed');
      return;
    case 'reassess': {
      if (outcome.ok || !('trip' in outcome)) return;
      const text = reassessInput(request, outcome.trip, outcome.events);
      setRun(runId, { state: 'queued', run_state: next.state, next_input: text });
      r.notice(botId, 'reassessing', next.notice);
      attemptLater(runId, botId, root, { type: 'system', text });
      return;
    }
    case 'retry': {
      if (outcome.ok || !('failure' in outcome)) return;
      const text = retryInput(request, failureReason(outcome.failure), outcome.events);
      const at = Date.now() + next.afterMs;
      setRun(runId, { state: 'retry_wait', run_state: next.state, next_input: text, next_attempt_at: at, last_error: lastError });
      r.notice(botId, 'retrying', next.notice);
      const go = () => {
        waiting.delete(runId);
        attemptLater(runId, botId, root, { type: 'system', text });
      };
      const repaired = next.repair ? r.repair(botId, next.repair).catch((e) => console.warn(`[supervisor] repair ${next.repair} for ${botId} failed: ${(e as Error).message}`)) : Promise.resolve();
      void repaired.then(() => {
        if ((db.prepare('SELECT state FROM turn_runs WHERE id=?').get(runId) as { state: string } | undefined)?.state !== 'retry_wait') return;
        waiting.set(runId, { botId, timer: later(go, next.afterMs) });
      });
      return;
    }
  }
}

/** Cancel every retry this bot is waiting on. */
function cancelWaiting(botId: string, only?: (root: Trigger) => boolean): number {
  const rows = db.prepare("SELECT id, root FROM turn_runs WHERE bot_id=? AND state='retry_wait'").all(botId) as { id: string; root: string }[];
  let n = 0;
  for (const row of rows) {
    const root = JSON.parse(row.root) as Trigger;
    if (only && !only(root)) continue;
    const w = waiting.get(row.id);
    if (w) clearTimeout(w.timer);
    waiting.delete(row.id);
    setRun(row.id, { state: 'stopped', next_input: null, next_attempt_at: null });
    requireRunner().finished(root, 'stopped');
    n++;
  }
  return n;
}

export function enqueue(botId: string, trigger: Trigger) {
  const r = requireRunner();
  if (trigger.type === 'user') {
    r.expireApprovals(botId);
    // The person is steering now: a request of theirs that is still waiting to retry gives way.
    if (cancelWaiting(botId, (root) => root.type === 'user')) r.notice(botId, 'gave-up', 'Stopped retrying the earlier request: you sent a new message.');
  }
  const id = newId('run');
  const at = Date.now();
  db.prepare('INSERT INTO turn_runs(id,bot_id,root,state,run_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, botId, JSON.stringify(trigger), 'queued', JSON.stringify(freshRun()), at, at);
  attemptLater(id, botId, trigger, trigger);
}

/** Stop the running turn and every retry the bot is waiting on. */
export function interrupt(botId: string) {
  requireRunner().expireApprovals(botId);
  aborts.get(botId)?.abort();
  cancelWaiting(botId);
}

/**
 * After a restart: pick up every run that was queued, running or waiting to retry. A run older
 * than the retry window is not resumed; the person is told it was interrupted.
 */
export function resumeRuns(): number {
  const r = requireRunner();
  const rows = db.prepare("SELECT * FROM turn_runs WHERE state IN ('queued','running','retry_wait') ORDER BY created_at").all() as RunRow[];
  let resumed = 0;
  for (const row of rows) {
    const root = JSON.parse(row.root) as Trigger;
    if (Date.now() - row.updated_at > RETRY_WINDOW_MS) {
      setRun(row.id, { state: 'failed', next_input: null, last_error: 'interrupted by a restart' });
      r.notice(row.bot_id, 'gave-up', `${r.botName(row.bot_id)} was interrupted by a restart and it was too long ago to pick up again. Ask it to continue if it still matters.`);
      r.finished(root, 'failed');
      continue;
    }
    resumed++;
    if (row.state === 'queued' && !row.next_input) { attemptLater(row.id, row.bot_id, root, root); continue; }
    if (row.state === 'retry_wait' && row.next_input) {
      const text = row.next_input;
      const wait = Math.max(0, (row.next_attempt_at ?? 0) - Date.now());
      waiting.set(row.id, { botId: row.bot_id, timer: later(() => { waiting.delete(row.id); attemptLater(row.id, row.bot_id, root, { type: 'system', text }); }, wait) });
      continue;
    }
    // Running (or queued with a continuation) when the server stopped: carry on from the transcript.
    const text = row.state === 'running' ? resumeInput(triggerText(root)) : row.next_input!;
    setRun(row.id, { state: 'queued', next_input: text });
    attemptLater(row.id, row.bot_id, root, { type: 'system', text });
  }
  return resumed;
}

/** Run a job in the bot's serial queue, after any running turn. */
export function runInBotQueue<T>(botId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(botId) ?? Promise.resolve();
  const result = prev.then(job);
  const next = result.then(() => {}, () => {});
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
  return result;
}

export const isBotBusy = (botId: string) => queues.has(botId) || [...waiting.values()].some((w) => w.botId === botId);
