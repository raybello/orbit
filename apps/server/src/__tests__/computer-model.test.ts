import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assignScreen,
  canAssignScreen,
  freeScreens,
  releaseScreen,
  type ComputerStatus,
  type Screen,
} from '../domain/computer-model.js';

/**
 * The allocator is tested against a full computer as well as an empty one: the interesting cases are
 * "no screen left", "computer is not ready yet", and "a released screen goes back into circulation".
 */

const computerId = 'host_1';

function screen(screenId: string, botId: string | null = null, lastUsedAt = 0): Screen {
  return { screenId, botId, lastUsedAt };
}

function ready(screens: Screen[]): Extract<ComputerStatus, { status: 'ready' }> {
  return { status: 'ready', computerId, screens };
}

function expectReady(computer: ComputerStatus): Extract<ComputerStatus, { status: 'ready' }> {
  if (computer.status !== 'ready') assert.fail(`expected ready, got ${computer.status}`);
  return computer;
}

/** Everything not ready, for the "refuses to touch it" table. */
const notReady: ComputerStatus[] = [
  { status: 'absent' },
  { status: 'provisioning', computerId, startedAt: 10 },
  { status: 'suspended', computerId, suspendedAt: 20, reason: 'asleep' },
  { status: 'error', error: new Error('boom'), failedAt: 30 },
];

describe('freeScreens', () => {
  test('returns only unassigned screens, in order', () => {
    const computer = ready([screen('s1', 'bot_a'), screen('s2'), screen('s3'), screen('s4', 'bot_b')]);
    assert.deepEqual(freeScreens(computer).map((s) => s.screenId), ['s2', 's3']);
  });

  test('is empty on a full computer', () => {
    assert.deepEqual(freeScreens(ready([screen('s1', 'bot_a'), screen('s2', 'bot_b')])), []);
  });

  test('is empty while the computer is not ready, because there are no live screens', () => {
    for (const computer of notReady) assert.deepEqual(freeScreens(computer), []);
  });
});

describe('canAssignScreen', () => {
  test('is true when ready with a free screen', () => {
    assert.equal(canAssignScreen(ready([screen('s1'), screen('s2', 'bot_a')])), true);
  });

  test('is false when every screen is taken', () => {
    assert.equal(canAssignScreen(ready([screen('s1', 'bot_a'), screen('s2', 'bot_b')])), false);
  });

  test('is false when the computer has no screens at all', () => {
    assert.equal(canAssignScreen(ready([])), false);
  });

  test('is false for every non-ready status', () => {
    for (const computer of notReady) assert.equal(canAssignScreen(computer), false, computer.status);
  });
});

describe('assignScreen', () => {
  test('gives the bot the first free screen and stamps when it was used', () => {
    const computer = ready([screen('s1', 'bot_a', 5), screen('s2'), screen('s3')]);
    const next = expectReady(assignScreen(computer, 'bot_b', () => 4242));

    assert.notEqual(next, computer);
    assert.notEqual(next.screens, computer.screens);
    assert.deepEqual(next.screens, [
      screen('s1', 'bot_a', 5),
      screen('s2', 'bot_b', 4242),
      screen('s3'),
    ]);
    assert.equal(next.computerId, computerId);
  });

  test('does not mutate the computer it is given', () => {
    const screens = [screen('s1'), screen('s2', 'bot_a')];
    const computer = ready(screens);
    const snapshot = structuredClone(computer);

    assignScreen(computer, 'bot_b', () => 1);

    assert.deepEqual(computer, snapshot);
    assert.deepEqual(freeScreens(computer).map((s) => s.screenId), ['s1']);
  });

  test('works on a deeply frozen computer, proving there is no hidden mutation', () => {
    const frozen = ready([Object.freeze(screen('s1')), Object.freeze(screen('s2', 'bot_a'))]);
    Object.freeze(frozen.screens);
    Object.freeze(frozen);

    const next = expectReady(assignScreen(frozen, 'bot_b', () => 7));
    assert.deepEqual(next.screens.map((s) => s.botId), ['bot_b', 'bot_a']);
  });

  test('adds a middle bot without disturbing either neighbour', () => {
    const computer = ready([screen('s1', 'bot_a'), screen('s2'), screen('s3')]);
    const next = expectReady(assignScreen(computer, 'bot_b', () => 9));
    assert.deepEqual(next.screens.map((s) => s.botId), ['bot_a', 'bot_b', null]);
    assert.equal(next.screens[2], computer.screens[2]);
  });

  test('is idempotent for a bot that already holds a screen, even when the computer is full', () => {
    const computer = ready([screen('s1', 'bot_a'), screen('s2', 'bot_b')]);
    assert.equal(assignScreen(computer, 'bot_a', () => 1), computer);
  });

  test('throws when every screen is taken', () => {
    const full = ready([screen('s1', 'bot_a'), screen('s2', 'bot_b')]);
    assert.throws(() => assignScreen(full, 'bot_c'), /no free screen on computer host_1: all 2 are assigned/);
  });

  test('throws when the computer is not ready, naming the status', () => {
    for (const computer of notReady) {
      assert.throws(
        () => assignScreen(computer, 'bot_a'),
        new RegExp(`computer is ${computer.status}, not ready`),
        computer.status,
      );
    }
  });

  test('fills a computer one bot at a time, then refuses the next', () => {
    let computer: ComputerStatus = ready([screen('s1'), screen('s2')]);
    computer = assignScreen(computer, 'bot_a', () => 1);
    assert.equal(canAssignScreen(computer), true);
    computer = assignScreen(computer, 'bot_b', () => 2);
    assert.equal(canAssignScreen(computer), false);
    assert.deepEqual(freeScreens(computer), []);
    assert.throws(() => assignScreen(computer, 'bot_c'), /no free screen/);
  });

  test('defaults to the wall clock when no clock is injected', () => {
    const before = Date.now();
    const next = expectReady(assignScreen(ready([screen('s1')]), 'bot_a'));
    const after = Date.now();
    const used = next.screens[0].lastUsedAt;
    assert.ok(used >= before && used <= after, `lastUsedAt ${used} is outside [${before}, ${after}]`);
  });
});

describe('releaseScreen', () => {
  test('frees the bot screen and stamps the release time', () => {
    const computer = ready([screen('s1', 'bot_a', 5), screen('s2', 'bot_b', 6)]);
    const next = expectReady(releaseScreen(computer, 'bot_a', () => 777));
    assert.deepEqual(next.screens, [screen('s1', null, 777), screen('s2', 'bot_b', 6)]);
    assert.notEqual(next, computer);
    assert.deepEqual(computer.screens[0].botId, 'bot_a');
  });

  test('a released screen goes back into circulation for a different bot', () => {
    const computer = ready([screen('s1', 'bot_a'), screen('s2', 'bot_b')]);
    assert.equal(canAssignScreen(computer), false);

    const freed = releaseScreen(computer, 'bot_a', () => 3);
    assert.equal(canAssignScreen(freed), true);

    const reassigned = expectReady(assignScreen(freed, 'bot_c', () => 4));
    assert.deepEqual(reassigned.screens, [screen('s1', 'bot_c', 4), screen('s2', 'bot_b', 0)]);
  });

  test('is a no-op for a bot that holds no screen', () => {
    const computer = ready([screen('s1', 'bot_a')]);
    assert.equal(releaseScreen(computer, 'bot_b'), computer);
  });

  test('is a no-op on a computer that is not ready', () => {
    for (const computer of notReady) assert.equal(releaseScreen(computer, 'bot_a'), computer, computer.status);
  });

  test('releasing twice is safe and the second release changes nothing', () => {
    const once = releaseScreen(ready([screen('s1', 'bot_a')]), 'bot_a', () => 1);
    assert.equal(releaseScreen(once, 'bot_a', () => 2), once);
  });

  test('does not mutate a frozen computer', () => {
    const frozen = ready([Object.freeze(screen('s1', 'bot_a', 5))]);
    Object.freeze(frozen.screens);
    Object.freeze(frozen);

    const next = expectReady(releaseScreen(frozen, 'bot_a', () => 8));
    assert.deepEqual(next.screens, [screen('s1', null, 8)]);
    assert.equal(frozen.screens[0].botId, 'bot_a');
  });

  test('defaults to the wall clock when no clock is injected', () => {
    const before = Date.now();
    const next = expectReady(releaseScreen(ready([screen('s1', 'bot_a')]), 'bot_a'));
    const after = Date.now();
    const used = next.screens[0].lastUsedAt;
    assert.ok(used >= before && used <= after, `lastUsedAt ${used} is outside [${before}, ${after}]`);
  });
});
