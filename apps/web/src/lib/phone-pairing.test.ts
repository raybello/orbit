import assert from 'node:assert/strict';
import test from 'node:test';
import { pairLink, parsePairLink } from '@orbit/contracts';
import { phoneServer } from './phone-pairing.js';

test('in the desktop app, the phone switch decides the address', () => {
  const origin = 'http://127.0.0.1:41234';
  assert.deepEqual(phoneServer(origin, { phase: 'on', url: 'http://192.168.1.23:52000' }), { kind: 'ready', url: 'http://192.168.1.23:52000' });
  assert.deepEqual(phoneServer(origin, { phase: 'off' }), { kind: 'switch-off' });
  assert.deepEqual(phoneServer(origin, { phase: 'no-network' }), { kind: 'no-network' });
});

test('without a local stack, a reachable page origin is the address and a loopback one is not', () => {
  assert.deepEqual(phoneServer('https://orbit.example.com', null), { kind: 'ready', url: 'https://orbit.example.com' });
  assert.deepEqual(phoneServer('https://orbit.example.com', { phase: 'unavailable' }), { kind: 'ready', url: 'https://orbit.example.com' });
  assert.deepEqual(phoneServer('http://localhost:5173', null), { kind: 'loopback' });
  assert.deepEqual(phoneServer('http://127.0.0.1:8787', { phase: 'unavailable' }), { kind: 'loopback' });
});

test('the QR link round-trips, and anything else is not a pair link', () => {
  const link = pairLink({ server: 'http://192.168.1.23:52000', code: 'abcDEF123_-abcDEF123_-abcDEF123_' });
  assert.equal(link, 'orbit://pair?server=http%3A%2F%2F192.168.1.23%3A52000&code=abcDEF123_-abcDEF123_-abcDEF123_');
  assert.deepEqual(parsePairLink(link), { server: 'http://192.168.1.23:52000', code: 'abcDEF123_-abcDEF123_-abcDEF123_' });
  assert.equal(parsePairLink('orbit://pair?server=javascript%3Aalert(1)&code=abcDEF123_-abcDEF123_'), null);
  assert.equal(parsePairLink('orbit://pair?server=http%3A%2F%2Fevil%40host&code=abcDEF123_-abcDEF123_'), null);
  assert.equal(parsePairLink('orbit://pair?server=https%3A%2F%2Fa.b&code=short'), null);
  assert.equal(parsePairLink('orbit://app/v1/prompt?text=hi'), null);
});
