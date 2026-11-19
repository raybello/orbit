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
fs.writeFileSync(path.join(root, 'report.md'), 'hello');
fs.writeFileSync(path.join(root, 'notes', 'todo.txt'), 'buy milk');

const get = (p: string, cookie = owner.cookie) => app.request(p, { headers: { cookie } });

/**
 * A bot's Library files as chat attachments read them (/api/bots/:id/files/raw): served from the
 * bot's own folder, never outside it, and only to the bot's owner. The file browser over the whole
 * data folder is /api/data (data-files.test.ts).
 */

test('a file inside the folder is served raw, and one outside is not', async () => {
  const ok = await get('/api/bots/bot_files/files/raw?path=notes%2Ftodo.txt');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'buy milk');

  const escape = await get('/api/bots/bot_files/files/raw?path=..%2F..%2Fetc%2Fpasswd');
  assert.equal(escape.status, 400);
});

test('another account cannot read it', async () => {
  assert.equal((await get('/api/bots/bot_files/files/raw?path=report.md', other.cookie)).status, 404);
});

