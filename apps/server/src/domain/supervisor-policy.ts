import { failureReason, type TurnFailure } from './turn-failure.js';
import { describeTrip, type LoopTrip, type ToolEvent } from './tool-loop.js';

/**
 * What the turn supervisor does after each attempt at a run, as one decision table. A run is one
 * thing a bot was asked to do (a message, a routine, a teammate's request); it may take several
 * attempts. Nothing here is the model's judgement: the bot is only told, in fixed words, what
 * happened and what to do next.
 */

/** How long a run keeps retrying a provider outage, from its first failure. */
export const RETRY_WINDOW_MS = 20 * 60_000;
/** Waits between transient retries; the last one repeats until the window closes. */
export const BACKOFF_MS = [15_000, 45_000, 120_000, 240_000, 480_000] as const;
/** A turn whose agent sends nothing for this long is wedged, unless it is waiting on the person. */
export const STALL_MS = 10 * 60_000;
/** Times a run may be sent back to reassess before the person is asked. */
export const MAX_REASSESS = 2;

/** How one attempt ended. */
export type AttemptOutcome =
  | { ok: true }
  | { ok: false; stopped: true }
  | { ok: false; failure: TurnFailure; events: ToolEvent[] }
  | { ok: false; trip: LoopTrip; events: ToolEvent[] };

/** What the run remembers between attempts. */
export interface RunState {
  retries: number;
  reassessments: number;
  firstFailureAt: number | null;
  authRepaired: boolean;
  gatewayRestarted: boolean;
  turnsDiscarded: boolean;
}

export const freshRun = (): RunState => ({ retries: 0, reassessments: 0, firstFailureAt: null, authRepaired: false, gatewayRestarted: false, turnsDiscarded: false });

/** What is done to a bot before a retry: refresh its sign-in, restart its agent, or clear a lost turn. */
export type Repair = 'auth' | 'gateway' | 'discard';

export type Next =
  | { do: 'done' }
  | { do: 'stopped' }
  | { do: 'retry'; afterMs: number; repair?: Repair; notice: string; state: RunState }
  | { do: 'reassess'; notice: string; state: RunState }
  | { do: 'give-up'; notice: string };

const seconds = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

export function nextStep(run: RunState, outcome: AttemptOutcome, now: number, botName = 'The Bot'): Next {
  if (outcome.ok) return { do: 'done' };
  if ('stopped' in outcome) return { do: 'stopped' };

  if ('trip' in outcome) {
    const stuck = describeTrip(outcome.trip);
    if (run.reassessments >= MAX_REASSESS) {
      return { do: 'give-up', notice: `${botName} was still stuck after trying another way ${MAX_REASSESS} times: ${stuck}. It has stopped; tell it how to proceed.` };
    }
    return { do: 'reassess', notice: `${botName} was stuck: ${stuck}. Asked it to step back and try another way.`, state: { ...run, reassessments: run.reassessments + 1 } };
  }

  const f = outcome.failure;
  const reason = failureReason(f);
  const first = run.firstFailureAt ?? now;
  switch (f.kind) {
    case 'auth':
      if (!run.authRepaired) return { do: 'retry', afterMs: 0, repair: 'auth', notice: `${botName} stopped because ${reason}. Refreshing its sign-in and trying again.`, state: { ...run, authRepaired: true, firstFailureAt: first } };
      return { do: 'give-up', notice: `${botName} stopped because ${reason}, again after refreshing it. Sign the primary agent in again under Settings → Engine Auth, then ask it to continue.` };
    case 'gateway':
      if (!run.gatewayRestarted) return { do: 'retry', afterMs: 0, repair: 'gateway', notice: `${botName} stopped because ${reason}. Restarting it and trying again.`, state: { ...run, gatewayRestarted: true, turnsDiscarded: true, firstFailureAt: first } };
      return transient(run, first, now, reason, botName);
    case 'lost-turn':
      if (!run.turnsDiscarded) return { do: 'retry', afterMs: 0, repair: 'discard', notice: `${botName} stopped because ${reason}. Clearing it and continuing.`, state: { ...run, turnsDiscarded: true, firstFailureAt: first } };
      return { do: 'give-up', notice: `${botName} stopped because ${reason}, and clearing it did not help. Start a new chat with it to continue.` };
    case 'transient':
      return transient(run, first, now, reason, botName);
    case 'model':
      return { do: 'give-up', notice: `${botName} stopped because ${reason} (${f.message.slice(0, 160)}). Pick another model for it under Settings → Engine Auth.` };
    case 'context':
      return { do: 'give-up', notice: `${botName} stopped because ${reason}. Start a new chat with it to continue.` };
    case 'billing':
      return { do: 'give-up', notice: `${botName} stopped because ${reason}. Add credit or switch its provider, then ask it to continue.` };
    case 'fatal':
      return { do: 'give-up', notice: `${botName} stopped: ${reason}` };
  }
}

function transient(run: RunState, first: number, now: number, reason: string, botName: string): Next {
  const wait = BACKOFF_MS[Math.min(run.retries, BACKOFF_MS.length - 1)];
  if (now + wait - first > RETRY_WINDOW_MS) {
    return { do: 'give-up', notice: `${botName} stopped because ${reason}, and it still was after ${Math.round((now - first) / 60_000)} min of retrying. Ask it to continue when the provider is back.` };
  }
  return { do: 'retry', afterMs: wait, notice: `${botName} paused because ${reason}. Trying again in ${seconds(wait)}.`, state: { ...run, retries: run.retries + 1, firstFailureAt: first } };
}

const MAX_REQUEST = 2_000;
const listCalls = (events: readonly ToolEvent[]) =>
  events.slice(-15).map((e) => `- ${e.name}: ${e.ok ? 'ran' : `failed${e.error ? ` (${e.error.slice(0, 120)})` : ''}`}`).join('\n');

/** The message a retried attempt starts with: why it stopped, what already ran, the request. */
export function retryInput(request: string, reason: string, events: readonly ToolEvent[]): string {
  const ran = events.length ? `\nThese tool calls already ran in that attempt:\n${listCalls(events)}\n` : '';
  return `Your previous attempt at this request stopped because ${reason}. Continue the task from where it stopped.${ran}
Check what is already done before you repeat anything that sends, creates or changes something.

The request was:
${request.slice(0, MAX_REQUEST)}`;
}

/** The message a reassess attempt starts with. The bot's first line says what it was stuck on, for the person. */
export function reassessInput(request: string, trip: LoopTrip, events: readonly ToolEvent[]): string {
  return `You were stuck: ${describeTrip(trip)}. Running it again unchanged will fail the same way. Find out why it failed first (read the full error, check the files and tools it depends on), then change something (the command, a file it uses, or your approach) before you run it again.
Start your reply with one short line telling the user what you were stuck on and what you will try instead (for example "I was stuck on X, so I'm trying Y."), then do it. If there is no other way, ask the user with ask_user.

Tool calls so far:
${listCalls(events)}

The request was:
${request.slice(0, MAX_REQUEST)}`;
}

/** The message a run interrupted by a server restart resumes with. */
export function resumeInput(request: string): string {
  return `The team app restarted while you were working on this request. Continue the task. Check what is already done before you repeat anything that sends, creates or changes something.

The request was:
${request.slice(0, MAX_REQUEST)}`;
}
