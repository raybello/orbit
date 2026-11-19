// api-env must be the FIRST import: it isolates the database and sets the values env.ts snapshots.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { env } = await import('../env.js');

const app = createApp();
after(cleanupTmpEnv);

/**
 * /api/data: the server's data folder as the file browser sees it. The owner walks the whole tree
 * from the root and lands in a bot's workspace; nothing leaves the folder (paths or links);
 * credentials and the live database are listed but never served; nobody else gets in.
 */

type Json = Record<string, any>;

async function signIn(email: string) {
  const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const bots = ((await (await app.request('/api/bots', { headers: { cookie } })).json()) as Json).bots as Json[];
  return { cookie, botId: String(bots[0].id) };
}

const owner = await signIn('data-owner@test.local');
const other = await signIn('data-other@test.local');
const get = (p: string, cookie = owner.cookie) => app.request(p, { headers: { cookie } });
const listing = async (p: string, cookie = owner.cookie) => (await (await get(p, cookie)).json()) as Json;

const root = env.dataDir;
const primary = db.prepare("SELECT id FROM bots WHERE engine='primary'").get() as { id: string };
fs.mkdirSync(path.join(root, 'engines', 'primary', 'workspace'), { recursive: true });
fs.writeFileSync(path.join(root, 'engines', 'primary', 'workspace', 'US_Military_Report.md'), '# Report\n\nThree sections.');
fs.writeFileSync(path.join(root, 'engines', 'primary', '.env'), 'ANTHROPIC_API_KEY=sk-secret');
fs.writeFileSync(path.join(root, 'engines', 'primary', 'auth.json'), '{"credential_pool":{}}');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-outside-'));
fs.writeFileSync(path.join(outside, 'passwd'), 'root:x:0:0');
fs.symlinkSync(outside, path.join(root, 'escape'));
fs.symlinkSync(path.join(root, 'engines', 'primary', '.env'), path.join(root, 'notes.txt'));
after(() => fs.rmSync(outside, { recursive: true, force: true }));

test("the owner lands in a bot's workspace and can walk up to the root", async () => {
  const atWork = await listing(`/api/data/files?bot=${primary.id}`);
  assert.equal(atWork.root, root);
  assert.equal(atWork.workspace, 'engines/primary/workspace');
  assert.equal(atWork.path, 'engines/primary/workspace');
  assert.deepEqual(atWork.files.map((f: Json) => f.name), ['US_Military_Report.md']);

  const top = await listing('/api/data/files?path=');
  const names = top.files.map((f: Json) => `${f.isDir ? 'd' : 'f'}:${f.name}`);
  assert.ok(names.includes('d:engines'), JSON.stringify(names));
  assert.ok(names.indexOf('d:engines') < names.findIndex((n: string) => n.startsWith('f:')), 'folders first');

  const engine = await listing('/api/data/files?path=engines/primary');
  assert.ok(engine.files.some((f: Json) => f.name === '.env'), 'a credential file is listed, so the tree is honest');
});

test("a Bot with no workspace yet gets one, and the listing opens there", async () => {
  const managed = 'bot_data_managed';
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(managed, (db.prepare('SELECT user_id FROM bots WHERE id=?').get(primary.id) as { user_id: string }).user_id, 'Quill', 'managed', Date.now(), Date.now());
  const r = await listing(`/api/data/files?bot=${managed}`);
  assert.equal(r.path, `engines/${managed}/workspace`);
  assert.deepEqual(r.files, []);
  assert.ok(fs.existsSync(path.join(root, 'engines', managed, 'workspace')));
});

test('a file is served to the viewers, with a policy that stops it running as a page', async () => {
  const r = await get('/api/data/raw?path=engines/primary/workspace/US_Military_Report.md');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '# Report\n\nThree sections.');
  assert.match(r.headers.get('content-type') ?? '', /^text\/markdown/);
  assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
});

test('credentials and the live database are never served, by name or through a link', async () => {
  for (const p of ['engines/primary/.env', 'engines/primary/auth.json', path.basename(env.dbPath)]) {
    const r = await get(`/api/data/raw?path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 403, p);
    assert.match(((await r.json()) as Json).error, /credentials|database/, p);
  }
  const linked = await get('/api/data/raw?path=notes.txt');
  assert.equal(linked.status, 403, 'a harmless-looking link to .env is refused for what it points at');
});

test('nothing outside the data folder is reachable, by path or by link', async () => {
  assert.equal((await get('/api/data/files?path=../')).status, 400);
  assert.equal((await get('/api/data/raw?path=..%2F..%2Fetc%2Fpasswd')).status, 400);
  assert.equal((await get('/api/data/files?path=escape')).status, 404, 'a link out of the folder is not followed');
  assert.equal((await get('/api/data/raw?path=escape/passwd')).status, 404);
});

test('only the owner of this computer browses it', async () => {
  assert.equal((await get('/api/data/files?path=', other.cookie)).status, 403);
  assert.equal((await get('/api/data/raw?path=engines/primary/workspace/US_Military_Report.md', other.cookie)).status, 403);
  assert.equal((await get(`/api/data/files?bot=${other.botId}`)).status, 404, "not someone else's Bot either");
});
