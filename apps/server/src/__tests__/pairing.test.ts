// api-env must be the FIRST import (see api-integration.test.ts).
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createPairing, PAIR_CODE_TTL_MS, PAIR_FAILURES_PER_MINUTE } from '../lib/pairing.js';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();
const { createApp } = await import('../api/app.js');
const app = createApp();

after(cleanupTmpEnv);

type Json = Record<string, any>;

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function signedInCookie(email: string): Promise<string> {
  const r = await post('/api/auth/dev', { email });
  assert.equal(r.status, 200);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}

test('a signed-in browser mints a code, and the phone redeems it once for a bearer session of the same account', async () => {
  const cookie = await signedInCookie('pair-owner@example.com');
  const minted = await post('/api/auth/pair', {}, { cookie });
  assert.equal(minted.status, 200);
  const { code, expiresAt } = (await minted.json()) as Json;
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + PAIR_CODE_TTL_MS);

  const redeemed = await post('/api/auth/pair/redeem', { code });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.headers.get('set-cookie'), null, 'the phone gets a token in the body, not a cookie');
  const session = (await redeemed.json()) as Json;
  assert.equal(session.user.email, 'pair-owner@example.com');

  const fromPhone = await app.request('/api/bots', { headers: { authorization: `Bearer ${session.token}` } });
  const fromBrowser = await app.request('/api/bots', { headers: { cookie } });
  assert.equal(fromPhone.status, 200);
  assert.deepEqual(
    ((await fromPhone.json()) as Json).bots.map((b: Json) => b.id),
    ((await fromBrowser.json()) as Json).bots.map((b: Json) => b.id),
    'the phone sees the same Bots as the browser that minted the code',
  );

  const again = await post('/api/auth/pair/redeem', { code });
  assert.equal(again.status, 403, 'a code works once');
});

test('minting needs a session, and a wrong code is refused', async () => {
  assert.equal((await post('/api/auth/pair', {})).status, 401);
  const wrong = await post('/api/auth/pair/redeem', { code: 'x'.repeat(32) });
  assert.equal(wrong.status, 403);
  assert.match(((await wrong.json()) as Json).error, /already used or has expired/);
  assert.equal((await post('/api/auth/pair/redeem', {})).status, 400);
});

test('a code stops working once it expires', () => {
  let now = 1_000_000;
  const pairing = createPairing(() => now);
  const { code } = pairing.mint('usr_a');
  now += PAIR_CODE_TTL_MS;
  assert.deepEqual(pairing.redeem(code), { ok: false, reason: 'invalid' });
});

test('minting a new code retires the previous one for that person only', () => {
  const pairing = createPairing(() => 0);
  const first = pairing.mint('usr_a');
  const other = pairing.mint('usr_b');
  const second = pairing.mint('usr_a');
  assert.deepEqual(pairing.redeem(first.code), { ok: false, reason: 'invalid' });
  assert.deepEqual(pairing.redeem(other.code), { ok: true, userId: 'usr_b' });
  assert.deepEqual(pairing.redeem(second.code), { ok: true, userId: 'usr_a' });
});

test('too many wrong codes in a minute lock redeeming until the minute passes', () => {
  let now = 0;
  const pairing = createPairing(() => now);
  const { code } = pairing.mint('usr_a');
  for (let i = 0; i < PAIR_FAILURES_PER_MINUTE; i += 1) assert.equal(pairing.redeem(`wrong-${i}`).ok, false);
  assert.deepEqual(pairing.redeem(code), { ok: false, reason: 'rate-limited' }, 'even the right code waits');
  now += 60_000;
  assert.deepEqual(pairing.redeem(code), { ok: true, userId: 'usr_a' });
});
