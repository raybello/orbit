import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canTransition,
  transition,
  type BotEvent,
  type BotState,
  type EngineRef,
  type ScreenRef,
} from '../domain/bot-lifecycle.js';

/**
 * The lifecycle is exercised as a machine, not as a pile of examples: every canonical state is run
 * against every event, and the only accepted outcomes are "moved" or "same object back".
 */

const botId = 'bot_alpha';
const engine: EngineRef = { kind: 'managed', url: 'http://127.0.0.1:18811' };
const otherEngine: EngineRef = { kind: 'primary', url: 'http://127.0.0.1:18800' };
const screen: ScreenRef = { screenId: 'screen-2' };
const otherScreen: ScreenRef = { screenId: 'screen-3' };
const failure = new Error('gateway exited');

const created: BotState = { status: 'created', botId };
const planned: BotState = { status: 'provisioning', botId, engineKind: 'managed' };
const withEngine: BotState = { status: 'provisioning', botId, engineKind: 'managed', engine };
const withScreen: BotState = { status: 'provisioning', botId, screen };
const ready: BotState = { status: 'ready', botId, engine, screen };
const running: BotState = { status: 'running', botId, engine, screen, turnId: 'turn_1' };
const errored: BotState = { status: 'error', botId, error: failure, lastState: ready };

function expectStatus<S extends BotState['status']>(state: BotState, status: S): Extract<BotState, { status: S }> {
  if (state.status !== status) assert.fail(`expected ${status}, got ${state.status}`);
  return state as Extract<BotState, { status: S }>;
}

const allEvents: BotEvent[] = [
  { type: 'provision-engine', engineKind: 'primary' },
  { type: 'provision-engine', engineKind: 'managed' },
  { type: 'engine-ready', engine },
  { type: 'screen-assigned', screen },
  { type: 'turn-started', turnId: 'turn_2' },
  { type: 'turn-finished', turnId: 'turn_1' },
  { type: 'turn-finished', turnId: 'turn_stale' },
  { type: 'error', error: failure },
];

const canonicalStates: BotState[] = [created, planned, withEngine, withScreen, ready, running, errored];

describe('bot lifecycle: provisioning accumulates facts', () => {
  test('provision-engine moves created to provisioning with the engine kind it intends to start', () => {
    const next = expectStatus(transition(created, { type: 'provision-engine', engineKind: 'managed' }), 'provisioning');
    assert.equal(next.botId, botId);
    assert.equal(next.engineKind, 'managed');
    assert.equal(next.engine, undefined);
    assert.equal(next.screen, undefined);
    assert.equal(canTransition(created, { type: 'provision-engine', engineKind: 'managed' }), true);
  });

  test('a screen may arrive before the engine, and the bot stays provisioning until the engine is up', () => {
    const next = expectStatus(transition(created, { type: 'screen-assigned', screen }), 'provisioning');
    assert.equal(next.screen, screen);
    assert.equal(next.engine, undefined);

    const afterEngine = expectStatus(transition(next, { type: 'engine-ready', engine }), 'ready');
    assert.equal(afterEngine.engine, engine);
    assert.equal(afterEngine.screen, screen);
  });

  test('engine-ready alone leaves the bot provisioning until a screen exists', () => {
    const provisioned = transition(created, { type: 'provision-engine', engineKind: 'managed' });
    const next = expectStatus(transition(provisioned, { type: 'engine-ready', engine }), 'provisioning');
    assert.equal(next.engine, engine);
    assert.equal(next.screen, undefined);
    // The engine fact must not be lost while waiting for a display.
    assert.equal(next.engineKind, 'managed');
  });

  test('screen-assigned after provision-engine stays provisioning until the engine is ready', () => {
    const provisioned = transition(created, { type: 'provision-engine', engineKind: 'managed' });
    const next = expectStatus(transition(provisioned, { type: 'screen-assigned', screen }), 'provisioning');
    assert.equal(next.screen, screen);
    assert.equal(next.engine, undefined);
  });

  test('the happy path becomes ready exactly once both facts are present', () => {
    const steps: BotEvent[] = [
      { type: 'provision-engine', engineKind: 'managed' },
      { type: 'engine-ready', engine },
      { type: 'screen-assigned', screen },
    ];
    let state: BotState = created;
    const seen: BotState['status'][] = [];
    for (const event of steps) {
      state = transition(state, event);
      seen.push(state.status);
    }
    assert.deepEqual(seen, ['provisioning', 'provisioning', 'ready']);
    const done = expectStatus(state, 'ready');
    assert.equal(done.botId, botId);
    assert.deepEqual(done.engine, engine);
    assert.deepEqual(done.screen, screen);
  });

  test('ready comes out the same whichever fact arrives second, and keeps both values', () => {
    const screenFirst = transition(
      transition(created, { type: 'screen-assigned', screen }),
      { type: 'engine-ready', engine },
    );
    const engineFirst = transition(
      transition(
        transition(created, { type: 'provision-engine', engineKind: 'primary' }),
        { type: 'engine-ready', engine: otherEngine },
      ),
      { type: 'screen-assigned', screen: otherScreen },
    );
    assert.deepEqual(expectStatus(screenFirst, 'ready').engine, engine);
    assert.deepEqual(expectStatus(screenFirst, 'ready').screen, screen);
    assert.deepEqual(expectStatus(engineFirst, 'ready').engine, otherEngine);
    assert.deepEqual(expectStatus(engineFirst, 'ready').screen, otherScreen);
    // A repeat of a fact is accepted while provisioning; the latest value wins.
    const replaced = transition(
      transition(withScreen, { type: 'screen-assigned', screen: otherScreen }),
      { type: 'engine-ready', engine },
    );
    assert.deepEqual(expectStatus(replaced, 'ready').screen, otherScreen);
    // A repeated engine-ready while provisioning replaces the engine ref and still waits for a screen.
    const reengine = expectStatus(transition(withEngine, { type: 'engine-ready', engine: otherEngine }), 'provisioning');
    assert.deepEqual(reengine.engine, otherEngine);
    assert.equal(reengine.screen, undefined);
  });
});

describe('bot lifecycle: turns', () => {
  test('turn-started moves ready to running and records the turn id', () => {
    const next = expectStatus(transition(ready, { type: 'turn-started', turnId: 'turn_2' }), 'running');
    assert.equal(next.turnId, 'turn_2');
    assert.deepEqual(next.engine, engine);
    assert.deepEqual(next.screen, screen);
  });

  test('turn-finished for the active turn returns to ready and drops the turn id', () => {
    const next = expectStatus(transition(running, { type: 'turn-finished', turnId: 'turn_1' }), 'ready');
    assert.equal('turnId' in next, false);
    assert.deepEqual(next.engine, engine);
    assert.deepEqual(next.screen, screen);
  });

  test('a late turn-finished from an older turn cannot end the current one', () => {
    const next = transition(running, { type: 'turn-finished', turnId: 'turn_stale' });
    assert.equal(next, running);
    assert.equal(canTransition(running, { type: 'turn-finished', turnId: 'turn_stale' }), false);
  });

  test('a turn cannot start while one is already running', () => {
    assert.equal(transition(running, { type: 'turn-started', turnId: 'turn_2' }), running);
    assert.equal(canTransition(running, { type: 'turn-started', turnId: 'turn_2' }), false);
  });
});

describe('bot lifecycle: errors', () => {
  for (const [label, state] of [
    ['created', created],
    ['provisioning (planned)', planned],
    ['provisioning (engine up)', withEngine],
    ['ready', ready],
    ['running', running],
  ] as const) {
    test(`an error from ${label} is terminal and remembers the state it came from`, () => {
      const next = expectStatus(transition(state, { type: 'error', error: failure }), 'error');
      assert.equal(next.botId, botId);
      assert.equal(next.error, failure);
      assert.equal(next.lastState, state);
      assert.equal(canTransition(state, { type: 'error', error: failure }), true);
    });
  }

  test('an error does not carry the error status forward from another error', () => {
    assert.equal(transition(errored, { type: 'error', error: new Error('again') }), errored);
    assert.equal(canTransition(errored, { type: 'error', error: new Error('again') }), false);
  });

  test('an error from running keeps the turn id in lastState', () => {
    const next = expectStatus(transition(running, { type: 'error', error: failure }), 'error');
    const last = expectStatus(next.lastState, 'running');
    assert.equal(last.turnId, 'turn_1');
  });
});

describe('bot lifecycle: illegal moves are no-ops', () => {
  test('provisioning events are refused before provisioning starts', () => {
    for (const event of [
      { type: 'engine-ready', engine },
      { type: 'turn-started', turnId: 'turn_1' },
      { type: 'turn-finished', turnId: 'turn_1' },
    ] as BotEvent[]) {
      assert.equal(transition(created, event), created);
      assert.equal(canTransition(created, event), false);
    }
  });

  test('turns cannot start before the bot is ready and cannot finish before it runs', () => {
    for (const state of [created, planned, withEngine, withScreen] as BotState[]) {
      const start: BotEvent = { type: 'turn-started', turnId: 'turn_1' };
      assert.equal(transition(state, start), state);
      assert.equal(canTransition(state, start), false);
    }
    const finish: BotEvent = { type: 'turn-finished', turnId: 'turn_1' };
    assert.equal(transition(ready, finish), ready);
    assert.equal(canTransition(ready, finish), false);
  });

  test('ready and running never go back to provisioning', () => {
    for (const state of [ready, running] as BotState[]) {
      for (const event of [
        { type: 'provision-engine', engineKind: 'managed' },
        { type: 'engine-ready', engine },
        { type: 'screen-assigned', screen },
      ] as BotEvent[]) {
        assert.equal(transition(state, event), state);
        assert.equal(canTransition(state, event), false);
      }
    }
  });

  test('nothing leaves the error state', () => {
    for (const event of allEvents) {
      assert.equal(transition(errored, event), errored);
      assert.equal(canTransition(errored, event), false);
    }
  });
});

describe('bot lifecycle: canTransition and transition agree', () => {
  test('on every canonical state and every event', () => {
    for (const state of canonicalStates) {
      for (const event of allEvents) {
        const moved = transition(state, event) !== state;
        assert.equal(
          canTransition(state, event),
          moved,
          `disagreement for ${state.status} + ${event.type} (${'turnId' in event ? event.turnId : ''})`,
        );
      }
    }
  });

  test('transition never mutates the state it is given', () => {
    const frozen = Object.freeze({ ...withEngine });
    const next = transition(frozen, { type: 'screen-assigned', screen });
    assert.equal(expectStatus(next, 'ready').screen, screen);
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(frozen.screen, undefined);
  });
});
