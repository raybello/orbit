import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerEvent } from '@orbit/contracts';
import { eventsUrl, hubCursorOf } from './events.js';

// Pure helpers that drive the cursor-resume protocol. No browser, no EventSource.

test('eventsUrl returns /api/events when cursor is null', () => {
  assert.equal(eventsUrl(null), '/api/events');
});

test('eventsUrl returns /api/events when cursor is 0 (no events seen yet)', () => {
  assert.equal(eventsUrl(0), '/api/events');
});

test('eventsUrl appends ?since=<n> for a positive cursor', () => {
  assert.equal(eventsUrl(42), '/api/events?since=42');
  assert.equal(eventsUrl(1), '/api/events?since=1');
});

test('hubCursorOf returns null for non-hello events', () => {
  const rows = { type: 'rows', botId: 'b', generation: 1, rows: [] } as unknown as ServerEvent;
  assert.equal(hubCursorOf(rows), null);
  const ping = { type: 'ping' } as ServerEvent;
  assert.equal(hubCursorOf(ping), null);
});

test('hubCursorOf returns null for a hello without a seq', () => {
  const hello = { type: 'hello' } as ServerEvent;
  assert.equal(hubCursorOf(hello), null);
});

test('hubCursorOf returns seq from a hello event', () => {
  const hello = { type: 'hello', seq: 99 } as unknown as ServerEvent;
  assert.equal(hubCursorOf(hello), 99);
});

test('after a hello with seq=42 the next eventsUrl would include ?since=42', () => {
  // Simulates what startEvents does: extract cursor from hello, then rebuild URL.
  const hello = { type: 'hello', seq: 42 } as unknown as ServerEvent;
  const cursor = hubCursorOf(hello);
  assert.equal(eventsUrl(cursor), '/api/events?since=42');
});
