import assert from 'node:assert/strict';
import test from 'node:test';
import { hub } from '../lib/hub.js';

/**
 * The hub's replay buffer is what lets a phone reconnect after backgrounding without losing events.
 * These tests run against the real singleton; each test uses its own user id so they do not interact.
 */

test('connections counts live subscribers and reaches zero on unsubscribe', () => {
  const user = 'usr_conn_test';
  assert.equal(hub.connections(user), 0);
  assert.equal(hub.isOnline(user), false);

  const a = hub.subscribe(user, () => {});
  const b = hub.subscribe(user, () => {});
  assert.equal(hub.connections(user), 2);
  assert.equal(hub.isOnline(user), true);

  a();
  assert.equal(hub.connections(user), 1);
  b();
  assert.equal(hub.connections(user), 0);
  assert.equal(hub.isOnline(user), false);
});

test('emit assigns increasing sequence numbers and buffers for replay', () => {
  const user = 'usr_seq_test';
  const seen: string[] = [];
  const unsub = hub.subscribe(user, (ev) => seen.push(ev.type));

  hub.emit(user, { type: 'roster' });
  hub.emit(user, { type: 'connections' });
  hub.emit(user, { type: 'routines', botId: 'bot_1' });
  unsub();

  assert.deepEqual(seen, ['roster', 'connections', 'routines']);
  assert.equal(hub.seq(user), 3);

  // Replaying from zero hands back everything; from 2 hands back just the last event.
  assert.deepEqual(hub.since(user, 0).events.map((e) => e.type), ['roster', 'connections', 'routines']);
  assert.deepEqual(hub.since(user, 2).events.map((e) => e.type), ['routines']);
  assert.deepEqual(hub.since(user, 3).events, []);
  assert.equal(hub.since(user, 0).seq, 3);
});

test('sequence numbers keep counting with nobody connected', () => {
  const user = 'usr_offline_test';
  hub.emit(user, { type: 'roster' });
  hub.emit(user, { type: 'roster' });
  assert.equal(hub.connections(user), 0);
  assert.equal(hub.seq(user), 2);
  assert.equal(hub.since(user, 0).events.length, 2);
});

test('the buffer keeps only the most recent 500 events', () => {
  const user = 'usr_cap_test';
  for (let i = 0; i < 520; i++) hub.emit(user, { type: 'ping' });
  const replay = hub.since(user, 0);
  assert.equal(replay.events.length, 500);
  assert.equal(replay.seq, 520);
});
