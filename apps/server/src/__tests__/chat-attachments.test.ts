// api-env must be the FIRST import: it isolates the database and sets the values env.ts snapshots.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// The desktop stack as it really runs: the server is not on the bots' computer (HQ_LOCAL=0), there
// is no shared Orgo computer, and every bot gets a Docker computer. The Library is this server's disk.
process.env.HQ_LOCAL = '0';
delete process.env.ORGO_COMPUTER_ID;
process.env.COMPUTER_KIND = 'docker';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { env } = await import('../env.js');
const { computerKindFor } = await import('../computer-provider-registry.js');

const app = createApp();
after(cleanupTmpEnv);

const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.com') as { id: string }).id;
db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('bot_atlas', userId, 'Atlas', 'managed', Date.now(), Date.now());

// Where image search saved the picture Atlas attached: its Library folder on the server, not its computer.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const rel = 'images/stanley-1-gallon-1-5hp-wet-dry-shop-vac--1.jpg';
fs.mkdirSync(path.join(env.botDataDir, 'files', 'bot_atlas', 'images'), { recursive: true });
fs.writeFileSync(path.join(env.botDataDir, 'files', 'bot_atlas', rel), JPEG);

test("a Docker bot's chat image is served from its Library, where image search saved it", async () => {
  assert.equal(computerKindFor('bot_atlas'), 'docker', 'the bot really has a Docker computer, with none running');
  const res = await app.request(`/api/bots/bot_atlas/files/raw?path=${encodeURIComponent(rel)}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('content-disposition') ?? '', /^inline;/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
});

test('a missing attachment is a 404, and a path out of the folder is refused', async () => {
  assert.equal((await app.request('/api/bots/bot_atlas/files/raw?path=images%2Fgone.jpg', { headers: { cookie } })).status, 404);
  assert.equal((await app.request('/api/bots/bot_atlas/files/raw?path=..%2F..%2Fetc%2Fpasswd', { headers: { cookie } })).status, 400);
});
