// api-env must be the FIRST import: it isolates the database and sets the values env.ts snapshots.
import { cleanupTmpEnv, tmpRoot } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

// A stand-in for Hermes: it says what it was run with, echoes one line typed into it, and exits.
const fakeHermes = path.join(tmpRoot, 'fake-hermes.sh');
fs.writeFileSync(fakeHermes, '#!/bin/sh\necho "args=$*"\necho "home=$HERMES_HOME"\nread line\necho "got=$line"\n', { mode: 0o755 });
process.env.HERMES_BIN = fakeHermes;

const { serve } = await import('@hono/node-server');
const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { attachEngineTerminal } = await import('../engine-terminal.js');
const { signInArgs, terminalSpawn } = await import('../domain/engine-signin.js');
(await import('../agent/subagents.js')).initSubagents();
(await import('../agent/rooms.js')).initRooms();

describe('the sign-in command', () => {
  test('is Hermes sign-in for a provider, OAuth for Claude, or the model chooser; never anything else', () => {
    assert.deepEqual(signInArgs(), ['model']);
    assert.deepEqual(signInArgs('openai-codex'), ['auth', 'add', 'openai-codex']);
    assert.deepEqual(signInArgs('anthropic'), ['auth', 'add', 'anthropic', '--type', 'oauth']);
    for (const bad of ['x; rm -rf /', '$(id)', '../etc', 'A', '-flag']) assert.equal(signInArgs(bad), null, bad);
  });

  test('runs in a sized terminal, with every argument quoted', () => {
    const { file, args } = terminalSpawn(['/opt/hermes/bin/hermes', 'auth', 'add', "it's"]);
    assert.equal(file, 'python3');
    assert.deepEqual(args.slice(2), ['sh', '-c', `stty cols 100 rows 30; exec '/opt/hermes/bin/hermes' 'auth' 'add' 'it'\\''s'`]);
  });
});

const app = createApp();
const server = serve({ fetch: app.fetch, port: 0 });
attachEngineTerminal(server as unknown as import('node:http').Server);
await new Promise((r) => server.once('listening', r));
const port = (server.address() as AddressInfo).port;
after(() => { server.close(); cleanupTmpEnv(); });

async function signIn(email: string) {
  const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string }).id;
  return { cookie, userId };
}
const owner = await signIn('owner@example.com');
const other = await signIn('other@example.com');
db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('bot_eng', owner.userId, 'Ada', 'managed', Date.now(), Date.now());

const url = (q = '') => `ws://127.0.0.1:${port}/api/bots/bot_eng/engine/terminal${q}`;
const open = (q: string, cookie: string) => new WebSocket(url(q), { headers: { cookie } });
const status = (ws: WebSocket) => new Promise<number>((resolve) => {
  ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
  ws.once('open', () => resolve(101));
});

describe('the terminal', () => {
  test("runs Hermes' sign-in for that agent's home, and relays what is typed", async () => {
    const ws = open('?provider=anthropic', owner.cookie);
    let out = '';
    ws.on('message', (d) => { out += d.toString(); });
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => setTimeout(r, 400));
    ws.send('hello-terminal\r');
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    assert.equal(code, 1000);
    assert.match(out, /args=auth add anthropic --type oauth/);
    assert.match(out, new RegExp(`home=.*${path.sep}bot_eng`));
    assert.match(out, /got=hello-terminal/);
    assert.match(out, /Finished\./);
  });

  test('only the owner gets in, and only with a plain provider name', async () => {
    assert.equal(await status(open('', other.cookie)), 401);
    assert.equal(await status(open('?provider=x%3Brm', owner.cookie)), 400);
  });

  test('one sign-in per agent at a time', async () => {
    const first = open('', owner.cookie);
    await new Promise((r) => first.once('open', r));
    assert.equal(await status(open('', owner.cookie)), 409);
    first.close();
    await new Promise((r) => first.once('close', r));
  });
});
