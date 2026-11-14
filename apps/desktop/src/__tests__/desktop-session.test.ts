import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_OWNER_EMAIL,
  ensureDesktopSession,
  linkOnOrigin,
  ownerKeyFor,
  sessionSecretFromEnvFile,
} from '../desktop-session';

const SECRET = 'a'.repeat(64);
const ORIGIN = 'http://127.0.0.1:18902';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A fake server: `/api/auth/me` answers with `me`, `/api/auth/owner` with `owner`.
 *
 * Both record the request so the test can assert on the headers and body the app really sent.
 */
function fakeServer(answers: {
  me?: { status?: number; user?: unknown };
  owner?: { status?: number; body?: unknown };
  throwOn?: 'me' | 'owner';
}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    if (url.endsWith('/api/auth/me')) {
      if (answers.throwOn === 'me') throw new Error('ECONNREFUSED');
      return json(answers.me?.status ?? 200, { user: answers.me?.user ?? null, devLogin: false });
    }
    if (url.endsWith('/api/auth/owner')) {
      if (answers.throwOn === 'owner') throw new Error('ECONNRESET');
      return json(answers.owner?.status ?? 200, answers.owner?.body ?? { ok: true });
    }
    return json(404, { error: 'not found' });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ownerKeyFor', () => {
  test('is HMAC-SHA256(SESSION_SECRET, "owner-login") as hex, as isOwnerKey expects', () => {
    const expected = createHmac('sha256', SECRET).update('owner-login').digest('hex');
    assert.equal(ownerKeyFor(SECRET), expected);
    assert.match(ownerKeyFor(SECRET), /^[0-9a-f]{64}$/);
  });

  test('changes with the secret', () => {
    assert.notEqual(ownerKeyFor(SECRET), ownerKeyFor('b'.repeat(64)));
  });
});

describe('ensureDesktopSession', () => {
  test('does nothing when /api/auth/me already has a session', async () => {
    const server = fakeServer({ me: { user: { id: 'usr_1', email: 'owner@orbit.local' } } });
    const result = await ensureDesktopSession({
      webUrl: ORIGIN,
      sessionSecret: SECRET,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(result.status, 'existing');
    assert.equal(result.url, ORIGIN);
    assert.equal(result.user?.id, 'usr_1');
    // No sign-in link means no new session row on every launch.
    assert.equal(server.calls.filter((c) => c.url.endsWith('/api/auth/owner')).length, 0);
  });

  test('mints an owner link when there is no session, and loads it', async () => {
    const server = fakeServer({
      me: { user: null },
      owner: { body: { ok: true, url: `${ORIGIN}/api/auth/link/tok123` } },
    });
    const result = await ensureDesktopSession({
      webUrl: ORIGIN,
      sessionSecret: SECRET,
      email: 'me@example.com',
      fetchImpl: server.fetchImpl,
    });

    const owner = server.calls.find((c) => c.url.endsWith('/api/auth/owner'));
    assert.ok(owner, 'POST /api/auth/owner was not called');
    assert.equal(owner!.method, 'POST');
    assert.equal(owner!.headers.authorization, `Bearer ${ownerKeyFor(SECRET)}`);
    assert.equal(owner!.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(owner!.body!), { email: 'me@example.com', link: true });

    assert.equal(result.status, 'signed-in');
    assert.equal(result.url, `${ORIGIN}/api/auth/link/tok123`);
  });

  test('defaults the identity to the stack owner address', async () => {
    const server = fakeServer({ me: { user: null }, owner: { body: { ok: true, url: `${ORIGIN}/api/auth/link/t` } } });
    const result = await ensureDesktopSession({ webUrl: ORIGIN, sessionSecret: SECRET, fetchImpl: server.fetchImpl });
    assert.equal(result.email, DEFAULT_OWNER_EMAIL);
    assert.equal(DEFAULT_OWNER_EMAIL, 'owner@orbit.local');
    assert.match(server.calls.find((c) => c.url.endsWith('/api/auth/owner'))!.body!, /owner@orbit\.local/);
  });

  test('rewrites a link built from a stale APP_URL onto the port we actually bound', async () => {
    const server = fakeServer({
      me: { user: null },
      // The server builds links from APP_URL, which the example file pins to 8787.
      owner: { body: { ok: true, url: `http://127.0.0.1:8787/api/auth/link/tok?x=1` } },
    });
    const result = await ensureDesktopSession({
      webUrl: ORIGIN,
      sessionSecret: SECRET,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(result.url, `${ORIGIN}/api/auth/link/tok?x=1`);
  });

  test('a rejected owner key is reported, not thrown', async () => {
    const server = fakeServer({ me: { user: null }, owner: { status: 403, body: { error: 'forbidden' } } });
    const result = await ensureDesktopSession({
      webUrl: ORIGIN,
      sessionSecret: 'wrong',
      fetchImpl: server.fetchImpl,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /HTTP 403: forbidden/);
    assert.equal(result.url, ORIGIN);
  });

  test('says so when the stack has no SESSION_SECRET', async () => {
    const server = fakeServer({ me: { user: null } });
    const result = await ensureDesktopSession({ webUrl: ORIGIN, sessionSecret: null, fetchImpl: server.fetchImpl });
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /SESSION_SECRET/);
    assert.equal(server.calls.filter((c) => c.url.endsWith('/api/auth/owner')).length, 0);
  });

  test('an unreachable /api/auth/me still tries the owner endpoint', async () => {
    const server = fakeServer({ throwOn: 'me', owner: { body: { ok: true, url: `${ORIGIN}/api/auth/link/t` } } });
    const result = await ensureDesktopSession({ webUrl: ORIGIN, sessionSecret: SECRET, fetchImpl: server.fetchImpl });
    assert.equal(result.status, 'signed-in');
  });

  test('a network failure is a status, not an exception', async () => {
    const server = fakeServer({ me: { user: null }, throwOn: 'owner' });
    const result = await ensureDesktopSession({ webUrl: ORIGIN, sessionSecret: SECRET, fetchImpl: server.fetchImpl });
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /ECONNRESET/);
  });

  test('a non-URL is refused before any request', async () => {
    const server = fakeServer({});
    const result = await ensureDesktopSession({ webUrl: 'not a url', sessionSecret: SECRET, fetchImpl: server.fetchImpl });
    assert.equal(result.status, 'failed');
    assert.equal(server.calls.length, 0);
  });
});

describe('linkOnOrigin', () => {
  test('keeps the path and query, takes the given origin', () => {
    assert.equal(linkOnOrigin('http://127.0.0.1:8787/api/auth/link/abc', ORIGIN), `${ORIGIN}/api/auth/link/abc`);
  });

  test('returns null for something that is not a URL', () => {
    assert.equal(linkOnOrigin('not a url', ORIGIN), null);
  });
});

describe('sessionSecretFromEnvFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-desktop-session-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

  test('reads SESSION_SECRET out of the stack env', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'SESSION_SECRET=deadbeef\nSTACK_TOKEN=x\n');
    assert.equal(sessionSecretFromEnvFile(file), 'deadbeef');
  });

  test('is null for a missing file or an empty value', () => {
    assert.equal(sessionSecretFromEnvFile(path.join(dir, 'nope.env')), null);
    const file = path.join(dir, 'empty.env');
    fs.writeFileSync(file, 'SESSION_SECRET=\n');
    assert.equal(sessionSecretFromEnvFile(file), null);
  });
});
