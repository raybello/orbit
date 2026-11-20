// Must be the first import: env.ts snapshots process.env, and db.ts opens the database it names.
import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const { db } = await import('../db.js');
const { migrateSharedComputerBots } = await import('../db-config.js');
const { registerBotComputer } = await import('../computer-provider-registry.js');
const { getComputer } = await import('../computer-store.js');

// Every bot has a computer of its own, a container. There is no shared Orgo machine any more.

test('a new bot is registered with a container', () => {
  registerBotComputer('bot_new');
  assert.equal(getComputer('bot_new')?.kind, 'docker');
  assert.equal(getComputer('bot_new')?.state, 'stopped', 'it starts on demand');
});

test('a bot that lived on the shared Orgo computer gets a container, and the migration is idempotent', () => {
  db.prepare("INSERT INTO bot_computers(bot_id,kind,state,updated_at) VALUES ('bot_old','orgo','running',?)").run(Date.now());
  migrateSharedComputerBots();
  migrateSharedComputerBots();
  assert.equal(getComputer('bot_old')?.kind, 'docker');
  assert.equal(getComputer('bot_old')?.state, 'running', 'only the kind changes');
});
