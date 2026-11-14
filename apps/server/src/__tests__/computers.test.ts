// Must be the first import: env.ts snapshots process.env, and db.ts opens the database it names.
import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotComputerStatus } from '@orbit/contracts';
import {
  computerStatusDeps,
  computerStatusFor,
  computerStatusesFor,
  providerState,
  type ComputerBotRow,
  type ComputerStatusDeps,
} from '../routes-computers.js';

/**
 * GET /api/computers is built from one pure function so the interesting cases (no computer, a
 * provider that throws, a room) need no HTTP, no Docker and no Orgo. The defaults are exercised
 * against the temp database tmp-env.ts points at.
 */

function deps(overrides: Partial<ComputerStatusDeps> = {}): ComputerStatusDeps {
  return {
    kindFor: () => 'docker',
    screenIdFor: () => 'screen-2',
    stateFor: () => 'running',
    isRunning: () => false,
    ...overrides,
  };
}

const bot = (id = 'bot-1', overrides: Partial<ComputerBotRow> = {}): ComputerBotRow => ({
  id,
  name: `Bot ${id}`,
  kind: 'agent',
  ...overrides,
});

test('a docker bot reports its kind and the provider state as awake/sleeping', () => {
  const row = computerStatusFor(bot('bot-1'), deps({ stateFor: () => 'running' }));
  assert.deepEqual(row, {
    botId: 'bot-1',
    botName: 'Bot bot-1',
    kind: 'docker',
    status: 'awake',
    isRunning: false,
    vncAvailable: true,
    screenId: 'screen-2',
  });

  // A stopped container is asleep, and a booting one is on its way.
  assert.equal(computerStatusFor(bot(), deps({ stateFor: () => 'suspended' }))?.status, 'sleeping');
  assert.equal(computerStatusFor(bot(), deps({ stateFor: () => 'stopped' }))?.status, 'sleeping');
  assert.equal(computerStatusFor(bot(), deps({ stateFor: () => 'booting' }))?.status, 'starting');
});

test('an orgo bot reads the shared computer state, not a container', () => {
  const seen: { botId: string; kind: string }[] = [];
  const row = computerStatusFor(
    bot('bot-2'),
    deps({
      kindFor: () => 'orgo',
      screenIdFor: () => 'screen-0',
      stateFor: (botId, kind) => {
        seen.push({ botId, kind });
        return 'resuming';
      },
    }),
  );
  assert.deepEqual(seen, [{ botId: 'bot-2', kind: 'orgo' }]);
  assert.equal(row?.kind, 'orgo');
  assert.equal(row?.status, 'starting');
});

test('a bot with no computer is kind none, unknown, and has nothing to view', () => {
  let stateAsked = false;
  const row = computerStatusFor(
    bot('bot-3'),
    deps({
      kindFor: () => 'none',
      screenIdFor: () => {
        throw new Error('a bot without a computer has no screen');
      },
      stateFor: () => {
        stateAsked = true;
        return 'running';
      },
    }),
  );
  assert.deepEqual(row, {
    botId: 'bot-3',
    botName: 'Bot bot-3',
    kind: 'none',
    status: 'unknown',
    isRunning: false,
    vncAvailable: false,
    screenId: null,
  });
  assert.equal(stateAsked, false, 'no provider is asked about a bot that has no computer');
});

test('a provider that throws gives unknown for that bot instead of failing the list', () => {
  const bots = [bot('bot-down'), bot('bot-up')];
  const rows = computerStatusesFor(
    bots,
    deps({
      stateFor: (botId) => {
        if (botId === 'bot-down') throw new Error('docker daemon is not running');
        return 'running';
      },
    }),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[0].kind, 'docker');
  assert.equal(rows[0].screenId, 'screen-2', 'a failed status does not lose the rest of the row');
  assert.equal(rows[1].status, 'awake');
});

test('a provider state this server does not know is unknown, not a guess', () => {
  for (const raw of ['error', 'absent', 'weird', null, undefined]) {
    assert.equal(providerState(raw), 'unknown');
  }
});

test('rooms are skipped: they are group chats, not computers', () => {
  assert.equal(computerStatusFor(bot('room-1', { kind: 'room' }), deps()), null);
  const rows = computerStatusesFor(
    [bot('room-1', { kind: 'room' }), bot('bot-4'), bot('room-2', { kind: 'room', name: 'Team' })],
    deps(),
  );
  assert.deepEqual(
    rows.map((r) => r.botId),
    ['bot-4'],
  );
});

test('vncAvailable is true only when the bot has a screen row', () => {
  const withScreen: BotComputerStatus | null = computerStatusFor(bot('bot-5'), deps({ screenIdFor: () => 'screen-7', stateFor: () => 'stopped' }));
  const withoutScreen: BotComputerStatus | null = computerStatusFor(bot('bot-6'), deps({ screenIdFor: () => null, stateFor: () => 'stopped' }));

  assert.equal(withScreen?.screenId, 'screen-7');
  assert.equal(withScreen?.vncAvailable, true, 'a sleeping computer still has a screen to open');
  assert.equal(withoutScreen?.screenId, null);
  assert.equal(withoutScreen?.vncAvailable, false);
});

test('isRunning comes from the live turn state, not from the computer', () => {
  const row = computerStatusFor(bot('bot-7'), deps({ stateFor: () => 'suspended', isRunning: () => true }));
  assert.equal(row?.isRunning, true);
  assert.equal(row?.status, 'sleeping', 'the two are independent');
});

test('the default deps read the bot rows the server already keeps', async () => {
  const { db } = await import('../db.js');
  await import('../db-config.js'); // bot_computers / computer_screens
  const { initRooms } = await import('../agent/rooms.js');
  initRooms(); // bots.kind / bots.members, normally added at server start
  const t = Date.now();

  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('user-1', 'one@example.com', 'One', t);
  const addBot = db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)');
  addBot.run('db-bot', 'user-1', 'Docker Bot', t, t);
  addBot.run('db-room', 'user-1', 'Team', t, t);
  db.prepare("UPDATE bots SET kind='room' WHERE id='db-room'").run();
  db.prepare('INSERT INTO bot_computers(bot_id,kind,state,updated_at) VALUES (?,?,?,?)').run('db-bot', 'docker', 'running', t);

  const bots: ComputerBotRow[] = [
    { id: 'db-bot', name: 'Docker Bot', kind: 'agent' },
    { id: 'db-room', name: 'Team', kind: 'room' },
  ];

  const [before] = computerStatusesFor(bots, computerStatusDeps('user-1'));
  assert.equal(before.botId, 'db-bot');
  assert.equal(before.kind, 'docker', 'no COMPUTER_KIND and no Orgo machine means a container per bot');
  assert.equal(before.status, 'awake', 'read from bot_computers, without asking Docker');
  assert.equal(before.screenId, null);
  assert.equal(before.vncAvailable, false);

  db.prepare('INSERT INTO computer_screens(bot_id,screen_id,display_index) VALUES (?,?,?)').run('db-bot', 'screen-4', 4);
  const [after] = computerStatusesFor(bots, computerStatusDeps('user-1'));
  assert.equal(after.screenId, 'screen-4');
  assert.equal(after.vncAvailable, true);
  assert.equal(after.status, 'awake');
});
