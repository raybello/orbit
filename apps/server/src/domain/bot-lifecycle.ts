/**
 * The lifecycle of one bot, as a pure state machine.
 *
 * Truth taken from engine.ts and computer.ts: a bot needs two independent things before it can work —
 * a Hermes engine (`primary` or `managed`) and a screen on the computer. Those two finish in whatever
 * order the machine feels like, so this machine accumulates facts instead of waiting for one combined
 * event: `provisioning` carries an optional `engine` and an optional `screen`, and the move to `ready`
 * happens the moment both are present, no matter which event supplied the second one.
 *
 * (The refactoring plan's sample tested `event.type === 'engine-ready' && event.type === 'screen-assigned'`,
 * which is never true for a single event. That impossible condition is why facts accumulate here.)
 *
 * `error` keeps the state it came from so a caller can report what was running when it failed; the
 * `Error` object is deliberately kept live rather than serialised — this is in-process domain state,
 * not a wire format.
 */

export type EngineKind = 'primary' | 'managed';

/** The part of engine.ts's `Engine` a state machine needs. Keys and home paths are not state. */
export interface EngineRef {
  kind: EngineKind;
  url: string;
}

/** The part of computer.ts's `BotScreen` a state machine needs. */
export interface ScreenRef {
  screenId: string;
}

export type BotState =
  | { status: 'created'; botId: string }
  /**
   * `engineKind` is what we intend to start (assignEngine), `engine` is the engine once it is up.
   * Either can be missing: a screen may be claimed before the gateway has booted, and the engine
   * may answer before a display is free.
   */
  | { status: 'provisioning'; botId: string; engineKind?: EngineKind; engine?: EngineRef; screen?: ScreenRef }
  | { status: 'ready'; botId: string; engine: EngineRef; screen: ScreenRef }
  | { status: 'running'; botId: string; engine: EngineRef; screen: ScreenRef; turnId: string }
  | { status: 'error'; botId: string; error: Error; lastState: BotState };

export type BotEvent =
  | { type: 'provision-engine'; engineKind: EngineKind }
  /** The gateway is listening; this is the event that supplies the engine's URL. */
  | { type: 'engine-ready'; engine: EngineRef }
  | { type: 'screen-assigned'; screen: ScreenRef }
  | { type: 'turn-started'; turnId: string }
  /** Carries its turn id so a late finish from an older turn cannot end the current one. */
  | { type: 'turn-finished'; turnId: string }
  | { type: 'error'; error: Error };

type NonErrorState = Exclude<BotState, { status: 'error' }>;

function failed(state: NonErrorState, error: Error): BotState {
  return { status: 'error', botId: state.botId, error, lastState: state };
}

function readyOrProvisioning(
  state: Extract<BotState, { status: 'provisioning' }>,
  patch: { engine?: EngineRef; screen?: ScreenRef },
): BotState {
  const engine = patch.engine ?? state.engine;
  const screen = patch.screen ?? state.screen;
  if (engine && screen) return { status: 'ready', botId: state.botId, engine, screen };
  return { ...state, ...patch };
}

/** The pure transition. Anything illegal is a no-op: the same state object comes back. */
export function transition(state: BotState, event: BotEvent): BotState {
  if (event.type === 'error') return state.status === 'error' ? state : failed(state, event.error);

  switch (state.status) {
    case 'created':
      if (event.type === 'provision-engine') {
        return { status: 'provisioning', botId: state.botId, engineKind: event.engineKind };
      }
      if (event.type === 'screen-assigned') {
        // A screen can be claimed before the engine is assigned; the engine fact is still missing.
        return { status: 'provisioning', botId: state.botId, screen: event.screen };
      }
      return state;

    case 'provisioning':
      if (event.type === 'engine-ready') return readyOrProvisioning(state, { engine: event.engine });
      if (event.type === 'screen-assigned') return readyOrProvisioning(state, { screen: event.screen });
      return state;

    case 'ready':
      if (event.type === 'turn-started') {
        return { status: 'running', botId: state.botId, engine: state.engine, screen: state.screen, turnId: event.turnId };
      }
      return state;

    case 'running':
      // Only the turn that is actually running can finish. A stale finish is ignored.
      if (event.type === 'turn-finished' && event.turnId === state.turnId) {
        return { status: 'ready', botId: state.botId, engine: state.engine, screen: state.screen };
      }
      return state;

    case 'error':
      return state;
  }
}

/** Whether `event` would move `state`. Kept explicit so it cannot drift from `transition`. */
export function canTransition(state: BotState, event: BotEvent): boolean {
  if (event.type === 'error') return state.status !== 'error';

  switch (state.status) {
    case 'created':
      return event.type === 'provision-engine' || event.type === 'screen-assigned';
    case 'provisioning':
      return event.type === 'engine-ready' || event.type === 'screen-assigned';
    case 'ready':
      return event.type === 'turn-started';
    case 'running':
      return event.type === 'turn-finished' && event.turnId === state.turnId;
    case 'error':
      return false;
  }
}
