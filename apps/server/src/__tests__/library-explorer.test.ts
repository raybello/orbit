// api-env must be the FIRST import: it isolates the database and sets the values env.ts snapshots.
// HQ_LOCAL puts this server on the machine it serves, so the Library is ordinary files on its disk:
// the container branch needs a live Docker socket and is covered by the end-to-end run instead.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

process.env.HQ_LOCAL = '1';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { ensureComputerRow } = await import('../computer-store.js');
const { env } = await import('../env.js');

const app = createApp();
after(cleanupTmpEnv);

async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
  const r = await app.request('/api/auth/dev', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(r.status, 200, await r.text());
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.match(cookie, /^grokbot_session=/);
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string };
  return { cookie, userId: user.id };
}

function addBot(userId: string, id: string, name: string): void {
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, name, 'managed', Date.now(), Date.now());
}

const owner = await signIn('owner@example.com');
const other = await signIn('other@example.com');
addBot(owner.userId, 'bot_files', 'Ada');
addBot(other.userId, 'bot_other', 'Bob');

// The Library folder of Ada's bot, where a local server reads it.
const root = path.join(env.botDataDir, 'files', 'bot_files');
fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
fs.mkdirSync(path.join(root, '.config'));
fs.writeFileSync(path.join(root, 'report.md'), 'hello');
fs.writeFileSync(path.join(root, 'notes', 'todo.txt'), 'buy milk');

const get = (p: string, cookie = owner.cookie) => app.request(p, { headers: { cookie } });

/**
 * The Library tab is a directory explorer of the bot computer's filesystem. It used to point every
 * bot at the shared Orgo computer and answered "ORGO_COMPUTER_ID is not set" for a Docker install,
 * so these cases pin the walk, the traversal guard and the ownership to the bot that owns them.
 */
test('the Library listing walks the bot’s folder, folders first', async () => {
  const r = await get('/api/bots/bot_files/files');
  assert.equal(r.status, 200);
  const body = (await r.json()) as { status: string; root?: string; files: { name: string; isDir: boolean }[] };
  assert.equal(body.status, 'ok');
  assert.equal(body.root, root);
  assert.deepEqual(body.files.map((f) => [f.name, f.isDir]), [
    ['.config', true],
    ['notes', true],
    ['report.md', false],
  ]);
});

test('walking into a folder lists that folder only', async () => {
  const r = await get('/api/bots/bot_files/files?path=notes');
  assert.equal(r.status, 200);
  const body = (await r.json()) as { path: string; files: { name: string }[] };
  assert.equal(body.path, 'notes');
  assert.deepEqual(body.files.map((f) => f.name), ['todo.txt']);
});

test('a path that climbs out of the folder is refused', async () => {
  const r = await get('/api/bots/bot_files/files?path=../secrets');
  assert.equal(r.status, 400);
});

test('a file inside the folder is served raw, and one outside is not', async () => {
  const ok = await get('/api/bots/bot_files/files/raw?path=notes%2Ftodo.txt');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'buy milk');

  const escape = await get('/api/bots/bot_files/files/raw?path=..%2F..%2Fetc%2Fpasswd');
  assert.equal(escape.status, 400);
});

test('the download route hands back a URL this server serves', async () => {
  const r = await app.request('/api/bots/bot_files/files/download', {
    method: 'POST',
    headers: { cookie: owner.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'report.md' }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { url: string };
  assert.match(body.url, /^\/api\/bots\/bot_files\/files\/raw\?path=/);
});

test('another account cannot list or read it', async () => {
  assert.equal((await get('/api/bots/bot_files/files', other.cookie)).status, 404);
  assert.equal((await get('/api/bots/bot_files/files/raw?path=report.md', other.cookie)).status, 404);
});

test('a Docker bot with no container yet answers asleep, not an error', async () => {
  addBot(owner.userId, 'bot_docker', 'Ship');
  ensureComputerRow('bot_docker', 'docker');
  const r = await get('/api/bots/bot_docker/files');
  assert.equal(r.status, 200);
  const body = (await r.json()) as { status: string; root?: string; files: unknown[] };
  assert.equal(body.status, 'asleep');
  assert.equal(body.root, '/home/bot');
  assert.deepEqual(body.files, []);
});
