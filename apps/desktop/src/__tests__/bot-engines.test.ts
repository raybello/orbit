import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findBotEngines, parseGatewayPid, signalBotEngines, stopBotEngines, type BotEngineDeps } from '../bot-engines';

const ENGINES = '/data/engines';

/** A fake process table: pid -> command, plus every signal sent. */
function fakes(files: Record<string, string>, procs: Record<number, string>, opts: { ignoreTerm?: number[] } = {}) {
  const live = new Map(Object.entries(procs).map(([pid, cmd]) => [Number(pid), cmd]));
  const signals: [number, string | number][] = [];
  let clock = 0;
  const deps: BotEngineDeps = {
    readDir: (dir) => {
      if (dir !== ENGINES) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...new Set(Object.keys(files).map((f) => path.relative(ENGINES, f).split(path.sep)[0]))];
    },
    readFile: (file) => {
      if (!(file in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[file];
    },
    commandOf: (pid) => live.get(pid) ?? null,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      const target = Math.abs(pid);
      if (!live.has(target)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !opts.ignoreTerm?.includes(target))) live.delete(target);
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { deps, signals, live };
}

const pidFile = (bot: string) => path.join(ENGINES, bot, 'gateway.pid');

describe('parseGatewayPid', () => {
  test('reads a bare pid and a JSON record for this home', () => {
    assert.equal(parseGatewayPid('4242\n', '/h'), 4242);
    assert.equal(parseGatewayPid('{"pid": 4242, "hermes_home": "/h"}', '/h'), 4242);
  });
  test('rejects a record for another home and nonsense', () => {
    assert.equal(parseGatewayPid('{"pid": 4242, "hermes_home": "/other"}', '/h'), null);
    assert.equal(parseGatewayPid('', '/h'), null);
    assert.equal(parseGatewayPid('1', '/h'), null);
    assert.equal(parseGatewayPid('banana', '/h'), null);
  });
});

describe('findBotEngines', () => {
  test('finds live gateways and skips stale pid files and unrelated processes', () => {
    const { deps } = fakes(
      {
        [pidFile('bot_a')]: '{"pid": 101}',
        [pidFile('bot_dead')]: '102',
        [pidFile('bot_reused')]: '103',
        [path.join(ENGINES, 'not_a_bot', 'gateway.pid')]: '104',
      },
      { 101: 'python3 -m hermes gateway run --no-supervise', 103: '/usr/bin/vim notes.txt', 104: 'hermes gateway run' },
    );
    assert.deepEqual(findBotEngines(ENGINES, deps), [{ pid: 101, home: path.join(ENGINES, 'bot_a') }]);
  });
  test("finds the primary's gateway too: the server runs it like every other", () => {
    const { deps } = fakes({ [pidFile('primary')]: '105' }, { 105: 'hermes gateway run --no-supervise' });
    assert.deepEqual(findBotEngines(ENGINES, deps), [{ pid: 105, home: path.join(ENGINES, 'primary') }]);
  });
  test('a missing engines folder is not an error', () => {
    assert.deepEqual(findBotEngines('/nowhere', fakes({}, {}).deps), []);
  });
});

describe('stopBotEngines', () => {
  test('SIGTERMs each gateway\'s process group', async () => {
    const { deps, signals, live } = fakes({ [pidFile('bot_a')]: '201' }, { 201: 'hermes gateway run --no-supervise' });
    const stopped = await stopBotEngines(ENGINES, deps);
    assert.equal(stopped.length, 1);
    assert.deepEqual(signals[0], [-201, 'SIGTERM']);
    assert.equal(live.has(201), false);
    assert.ok(!signals.some(([, s]) => s === 'SIGKILL'));
  });
  test('a gateway that ignores SIGTERM is killed after the grace period', async () => {
    const { deps, signals, live } = fakes({ [pidFile('bot_a')]: '301' }, { 301: 'hermes gateway run' }, { ignoreTerm: [301] });
    await stopBotEngines(ENGINES, { ...deps, graceMs: 1_000 });
    assert.deepEqual(signals.filter(([, s]) => s !== 0), [[-301, 'SIGTERM'], [-301, 'SIGKILL']]);
    assert.equal(live.has(301), false);
  });
});

test('signalBotEngines sends SIGTERM and returns without waiting', () => {
  const { deps, signals } = fakes({ [pidFile('bot_a')]: '401' }, { 401: 'hermes gateway run' }, { ignoreTerm: [401] });
  assert.equal(signalBotEngines(ENGINES, deps).length, 1);
  assert.deepEqual(signals, [[-401, 'SIGTERM']]);
});
