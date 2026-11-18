// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, beforeEach } from 'node:test';

const { db } = await import('../db.js');
const { env } = await import('../env.js');
const { retireGoogleOAuth } = await import('../retire-google-oauth.js');

after(() => cleanupTmpEnv());

/**
 * A database left by a server that still had the direct Google OAuth integration: its two tables,
 * with tokens sealed the way that module sealed them. Starting the new server must revoke each grant
 * at Google and remove both tables, and doing it again must be harmless.
 */

function sealLegacy(plain: string): string {
  const key = crypto.createHash('sha256').update(`google-token-key:${env.sessionSecret}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${enc.toString('hex')}.${cipher.getAuthTag().toString('hex')}`;
}

const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'google_%'").all() as { name: string }[]).map((r) => r.name).sort();

function plantLegacy(rows: { user: string; refresh: string; access: string }[]) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_tokens (user_id TEXT PRIMARY KEY, access_token_enc TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, expires_at INTEGER NOT NULL, email TEXT, scopes TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS google_oauth_states (state TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_verifier TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  for (const r of rows) {
    db.prepare('INSERT INTO google_tokens(user_id, access_token_enc, refresh_token_enc, expires_at, updated_at) VALUES (?,?,?,?,?)').run(r.user, sealLegacy(r.access), sealLegacy(r.refresh), 0, 0);
  }
  db.prepare('INSERT INTO google_oauth_states VALUES (?,?,?,?)').run(`st_${crypto.randomUUID()}`, 'u1', 'verifier', 0);
}

/** A stand-in for fetch that records every revoke and answers with the given status (and OAuth error, for a 400). */
function fakeGoogle(status: number | 'throw', error = 'invalid_token') {
  const revoked: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/revoke', 'the token must not be in the URL');
    assert.equal(init?.method, 'POST');
    revoked.push(new URLSearchParams(String(init?.body ?? '')).get('token') ?? '');
    if (status === 'throw') throw new Error('offline');
    return status === 400 ? Response.json({ error }, { status }) : new Response(null, { status });
  }) as typeof fetch;
  return { revoked, fetchImpl };
}

beforeEach(() => db.exec('DROP TABLE IF EXISTS google_tokens; DROP TABLE IF EXISTS google_oauth_states;'));

test('a fresh database has no Google OAuth tables, and retiring does nothing', async () => {
  assert.deepEqual(tables(), []);
  const google = fakeGoogle(200);
  assert.deepEqual(await retireGoogleOAuth(google.fetchImpl), { found: 0, revoked: 0, failed: 0, dropped: false });
  assert.deepEqual(google.revoked, []);
});

test('every stored grant is revoked with its refresh token, then both tables are dropped', async () => {
  plantLegacy([{ user: 'u1', refresh: 'refresh-one', access: 'access-one' }, { user: 'u2', refresh: 'refresh-two', access: 'access-two' }]);
  const google = fakeGoogle(200);
  const r = await retireGoogleOAuth(google.fetchImpl);
  assert.deepEqual(google.revoked.sort(), ['refresh-one', 'refresh-two']);
  assert.deepEqual(r, { found: 2, revoked: 2, failed: 0, dropped: true });
  assert.deepEqual(tables(), []);
});

test('a token Google no longer knows (400) counts as revoked', async () => {
  plantLegacy([{ user: 'u1', refresh: 'gone', access: 'gone-too' }]);
  const r = await retireGoogleOAuth(fakeGoogle(400).fetchImpl);
  assert.equal(r.revoked, 1);
  assert.deepEqual(tables(), []);
});

test('any other 400 (a malformed request) is not counted as revoked', async () => {
  plantLegacy([{ user: 'u1', refresh: 'r', access: 'a' }]);
  const r = await retireGoogleOAuth(fakeGoogle(400, 'invalid_request').fetchImpl);
  assert.deepEqual(r, { found: 1, revoked: 0, failed: 1, dropped: true });
  assert.deepEqual(tables(), []);
});

test('the tables are dropped even when Google cannot be reached', async () => {
  plantLegacy([{ user: 'u1', refresh: 'r', access: 'a' }]);
  const r = await retireGoogleOAuth(fakeGoogle('throw').fetchImpl);
  assert.deepEqual(r, { found: 1, revoked: 0, failed: 1, dropped: true });
  assert.deepEqual(tables(), []);
});

test('a row sealed under another secret is not revoked, and is still dropped', async () => {
  plantLegacy([]);
  db.prepare('INSERT INTO google_tokens(user_id, access_token_enc, refresh_token_enc, expires_at, updated_at) VALUES (?,?,?,?,?)').run('u9', 'aa.bb.cc', 'aa.bb.cc', 0, 0);
  const google = fakeGoogle(200);
  const r = await retireGoogleOAuth(google.fetchImpl);
  assert.deepEqual(google.revoked, []);
  assert.equal(r.failed, 1);
  assert.deepEqual(tables(), []);
});

test('running it again after a retirement is harmless', async () => {
  plantLegacy([{ user: 'u1', refresh: 'r', access: 'a' }]);
  await retireGoogleOAuth(fakeGoogle(200).fetchImpl);
  const google = fakeGoogle(200);
  assert.equal((await retireGoogleOAuth(google.fetchImpl)).dropped, false);
  assert.deepEqual(google.revoked, []);
});
