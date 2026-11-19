/**
 * The per-bot turn scheduler: a bot handles one turn at a time, in arrival order.
 * The agent loop registers how a turn runs, so routes, schedulers and tools can queue
 * work without importing the loop itself.
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

export interface TurnRunner {
  runTurn(botId: string, trigger: Trigger, signal: AbortSignal): Promise<void>;
  expireApprovals(botId: string): void;
}

let runner: TurnRunner | null = null;
const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();

export function registerTurnRunner(r: TurnRunner) {
  runner = r;
}

function requireRunner(): TurnRunner {
  if (!runner) throw new Error('No turn runner registered; import agent/loop.js at boot.');
  return runner;
}

async function runOne(botId: string, trigger: Trigger) {
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  try {
    await requireRunner().runTurn(botId, trigger, ctrl.signal);
  } finally {
    if (aborts.get(botId) === ctrl) aborts.delete(botId);
  }
}

export function enqueue(botId: string, trigger: Trigger) {
  // A new message from the user supersedes whatever is waiting for their approval.
  if (trigger.type === 'user') requireRunner().expireApprovals(botId);
  const prev = queues.get(botId) ?? Promise.resolve();
  const next = prev.then(() => runOne(botId, trigger)).catch((e) => console.error('[agent] turn failed', botId, e));
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
}

export function interrupt(botId: string) {
  requireRunner().expireApprovals(botId);
  aborts.get(botId)?.abort();
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

export const isBotBusy = (botId: string) => queues.has(botId);
