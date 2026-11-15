// Must be the first import: env.ts snapshots process.env, and db.ts opens the database it names.
import './helpers/tmp-env.js';
// bot_computers / computer_screens, normally created when the server starts.
import '../db-config.js';
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { claimScreen, deleteScreen, getScreen } from '../computer-store.js';
import { db } from '../db.js';
import { cleanupTmpEnv } from './helpers/tmp-env.js';

/**
 * claimScreen used to pick its display with a SQL loop of its own; the rule now lives in
 * domain/computer-model.ts (assignScreen) and computer-store adapts rows to slots. These tests pin
 * the store's half of that contract: lowest free display first, an existing screen reused without a
 * second slot, the limit enforced with the old message, and a deleted row freeing its display.
 *
 * Displays start at 1, not 0 — the allocator has always handed out 1..limit and the port maths
 * (5900+i / 9200+i) and the container's `DISPLAY=:i` depend on it. Slot i is therefore `screen-i`
 * and there are `limit` slots, not limit+1.
 */

const token = () => 'view-token';

/** A fresh table per test: each file gets its own process and database, tests share it. */
beforeEach(() => {
  db.exec('DELETE FROM computer_screens');
});

after(() => cleanupTmpEnv());

const screenCount = () => (db.prepare('SELECT COUNT(*) AS n FROM computer_screens').get() as { n: number }).n;

test('the first bot gets display 1, with its screen id, ports and token', () => {
  const row = claimScreen('bot-a', 3, token);

  assert.equal(row.display_index, 1);
  assert.equal(row.screen_id, 'screen-1');
  assert.equal(row.vnc_port, 5901);
  assert.equal(row.cdp_port, 9201);
  assert.equal(row.view_token, 'view-token');
  assert.equal(row.control_token, null);
  assert.equal(row.ensured_at, null);
  assert.ok(row.idle_at !== null && row.idle_at > 0, 'a claimed screen is stamped as used now');
  assert.deepEqual(getScreen('bot-a'), row, 'the row is what the database holds');
});

test('the second bot gets the next free display, not a second screen-1', () => {
  const first = claimScreen('bot-a', 3, token);
  const second = claimScreen('bot-b', 3, token);

  assert.equal(first.display_index, 1);
  assert.equal(second.display_index, 2);
  assert.equal(second.screen_id, 'screen-2');
  assert.equal(second.vnc_port, 5902);
  assert.equal(second.cdp_port, 9202);
  assert.equal(screenCount(), 2);
});

test('a re-claim returns the same screen and takes no second slot', () => {
  const first = claimScreen('bot-a', 3, token);
  const again = claimScreen('bot-a', 3, () => 'a-new-token');

  assert.deepEqual(again, first, 'same row: the view token is not replaced on resume');
  assert.equal(screenCount(), 1);

  // The slot it already holds is not consumed, so the next bot still gets display 2.
  assert.equal(claimScreen('bot-b', 3, token).display_index, 2);
});

test('filling every display throws the message the server has always thrown', () => {
  claimScreen('bot-a', 2, token);
  claimScreen('bot-b', 2, token);

  assert.throws(() => claimScreen('bot-c', 2, token), {
    message: 'No free display left (2 bot screens at most). Remove a bot to free one.',
  });
  assert.equal(getScreen('bot-c'), null, 'a bot that could not claim gets no row');
  assert.equal(screenCount(), 2);
});

test('a deleted screen row makes its display claimable again', () => {
  const first = claimScreen('bot-a', 2, token);
  claimScreen('bot-b', 2, token);
  assert.throws(() => claimScreen('bot-c', 2, token), /No free display left/);

  deleteScreen('bot-a'); // a freed screen is a deleted row here, not a slot marked free
  assert.equal(getScreen('bot-a'), null);

  const reused = claimScreen('bot-c', 2, token);
  assert.equal(reused.display_index, first.display_index, 'the lowest freed display comes back first');
  assert.equal(reused.screen_id, first.screen_id);
  assert.equal(screenCount(), 2);
});

test('rows above the limit never move the allocation window', () => {
  // e.g. COMPUTER_MAX_DISPLAYS was lowered: display 5 exists but is outside 1..2.
  db.prepare('INSERT INTO computer_screens(bot_id,screen_id,display_index) VALUES (?,?,?)').run('bot-old', 'screen-5', 5);

  assert.equal(claimScreen('bot-a', 2, token).display_index, 1, 'display 1 is free even though 5 is taken');
  assert.equal(claimScreen('bot-b', 2, token).display_index, 2);

  // A bot already on an out-of-window display keeps it rather than being moved.
  const kept = claimScreen('bot-old', 2, token);
  assert.equal(kept.display_index, 5);
  assert.equal(kept.screen_id, 'screen-5');
});
