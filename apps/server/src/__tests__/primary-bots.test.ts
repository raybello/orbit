// api-env first: it points env.ts at a temp DB before anything snapshots process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
// This suite creates a few extra bots on purpose; the api-env ceiling of 3 is for admission cases.
process.env.MAX_BOTS = '8';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { now } = await import('../db.js');
const { toolMap } = await import('../agent/tools.js');
const { planPrimaryChange, MAX_PRIMARY_BOTS } = await import('../domain/primary-bots.js');

const app = createApp();
const botCount = () => (db.prepare('SELECT COUNT(*) n FROM bots').get() as { n: number }).n;
const primaryNames = () =>
  (db.prepare('SELECT name FROM bots WHERE is_primary=1 ORDER BY created_at ASC').all() as { name: string }[]).map((b) => b.name);

type Json = Record<string, any>;

async function send(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function signIn(): Promise<string> {
  const r = await send('POST', '/api/auth/dev', { email: 'primary@example.test' });
  assert.equal(r.status, 200);
  return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const cookie = await signIn();

test.after(() => cleanupTmpEnv());

/** The tool context the app builds for one caller (mcp.ts / loop.ts shape). */
const ctx = (botId: string) => ({ userId: (db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string }).user_id, botId, enqueueBotMessage: () => {}, depth: 0 });

const tool = (name: string) => {
  const t = toolMap.get(name);
  assert.ok(t, `${name} is registered`);
  return t!;
};

// ---------- the pure rule ----------

test('the primary set caps at three and never empties', () => {
  const flags = (ids: string[], primary: string[]) => ids.map((id) => ({ id, isPrimary: primary.includes(id) }));
  const four = flags(['a', 'b', 'c', 'd'], ['a']);

  assert.deepEqual(planPrimaryChange(four, 'b', 'promote'), { ok: true, primaries: ['a', 'b'], changed: true });
  assert.equal(planPrimaryChange(four, 'a', 'promote').ok, true, 'promoting a primary is a no-op that succeeds');

  const full = flags(['a', 'b', 'c', 'd'], ['a', 'b', 'c']);
  const refused = planPrimaryChange(full, 'd', 'promote');
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.status, 400);
  assert.match(refused.ok === false ? refused.message : '', new RegExp(`${MAX_PRIMARY_BOTS}`));

  const last = planPrimaryChange(flags(['a', 'b'], ['a']), 'a', 'restore');
  assert.equal(last.ok, false);
  assert.match(last.ok === false ? last.message : '', /last primary/i);

  assert.deepEqual(planPrimaryChange(flags(['a', 'b'], ['a', 'b']), 'b', 'restore'), { ok: true, primaries: ['a'], changed: true });
  assert.equal(planPrimaryChange(flags(['a'], ['a']), 'zzz', 'promote').ok, false, 'unknown ids are refused');
});

// ---------- the HTTP surface ----------

test('a new install names its coordinator Atlas, not Doug', async () => {
  const bots = (await (await send('GET', '/api/bots', undefined, cookie)).json()) as { bots: Json[] };
  assert.equal(bots.bots.find((b) => b.isPrimary)?.name, 'Atlas');
  assert.equal(bots.bots.find((b) => b.isPrimary)?.label, 'Chief of Staff');
});

test('POST /primary adds a primary up to three, and restore refuses to leave none', async () => {
  const make = async (name: string) => {
    const r = await send('POST', '/api/bots', { name }, cookie);
    const body = (await r.json()) as { bot?: Json; error?: string };
    assert.equal(r.status, 200, body.error);
    return body.bot!.id as string;
  };
  const atlas = (db.prepare("SELECT id FROM bots WHERE name='Atlas'").get() as { id: string }).id;
  const scout = await make('Scout');
  const ada = await make('Ada');

  assert.equal((await send('POST', `/api/bots/${scout}/primary`, undefined, cookie)).status, 200);
  const third = await send('POST', `/api/bots/${ada}/primary`, undefined, cookie);
  assert.equal(third.status, 200, await third.text());
  assert.deepEqual(primaryNames().sort(), ['Ada', 'Atlas', 'Scout']);

  // Promoting an existing primary is an idempotent success; a fourth, distinct one is refused.
  const again = await send('POST', `/api/bots/${atlas}/primary`, undefined, cookie);
  assert.equal(again.status, 200, 'promoting an existing primary is idempotent');
  const user = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
  db.prepare("INSERT INTO bots(id,user_id,name,kind,is_primary,created_at,updated_at) VALUES (?,?,?,'agent',0,?,?)").run('bot_never_primary', user, 'Fourth', now(), now());
  const fourth = await send('POST', '/api/bots/bot_never_primary/primary', undefined, cookie);
  assert.equal(fourth.status, 400, await fourth.text());
  assert.equal((db.prepare("SELECT is_primary FROM bots WHERE id='bot_never_primary'").get() as { is_primary: number }).is_primary, 0);

  const restored = await send('POST', `/api/bots/${ada}/primary/restore`, undefined, cookie);
  assert.equal(restored.status, 200, await restored.text());
  assert.deepEqual(primaryNames().sort(), ['Atlas', 'Scout']);

  const atlasRestored = await send('POST', `/api/bots/${atlas}/primary/restore`, undefined, cookie);
  assert.equal(atlasRestored.status, 200);
  const lastRestore = await send('POST', `/api/bots/${scout}/primary/restore`, undefined, cookie);
  assert.equal(lastRestore.status, 400, 'the last primary cannot be restored');
  assert.deepEqual(primaryNames(), ['Scout']);
});

// ---------- the agent tools ----------

test('create_bot refuses a caller that is not primary, and creates when one is', async () => {
  const user = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
  // A fourth bot, seeded directly: the suite is at the capacity ceiling, and this case is about the
  // primary gate, not admission.
  db.prepare("INSERT INTO bots(id,user_id,name,kind,is_primary,created_at,updated_at) VALUES (?,?,?,'agent',0,?,?)").run('bot_plain_caller', user, 'Plain', now(), now());

  const before = botCount();
  const refused = await tool('create_bot').impl({ name: 'Should Not Exist' }, ctx('bot_plain_caller'));
  assert.match(refused.output, /Only a primary Bot/i);
  assert.equal(botCount(), before, 'a refused call writes nothing');

  const primary = (db.prepare('SELECT id FROM bots WHERE is_primary=1 LIMIT 1').get() as { id: string }).id;
  const made = await tool('create_bot').impl({ name: 'Researcher', label: 'Reads things' }, ctx(primary));
  const created = JSON.parse(made.output.split('\n').find((l) => l.includes('"ok"')) ?? '{}') as { ok?: boolean; bot?: { name: string } };
  assert.equal(created.ok, true, made.output);
  assert.equal(created.bot?.name, 'Researcher');
  const row = db.prepare("SELECT label FROM bots WHERE name='Researcher'").get() as { label: string } | undefined;
  assert.equal(row?.label, 'Reads things');

  const listed = await tool('list_bots').impl({}, ctx(primary));
  assert.match(listed.output, /"Researcher"/);
  assert.match(listed.output, /"primary":true/);
});

test('update_bot edits only through a primary caller, and delete_bot keeps a coordinator', async () => {
  const user = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
  db.prepare("INSERT INTO bots(id,user_id,name,kind,is_primary,created_at,updated_at) VALUES (?,?,?,'agent',1,?,?)").run('bot_extra_primary', user, 'Extra', now(), now() - 10);

  const refused = await tool('update_bot').impl({ bot_name: 'Extra', label: 'nope' }, ctx('bot_plain_caller'));
  assert.match(refused.output, /Only a primary Bot/i);

  const primary = 'bot_extra_primary';
  const edited = await tool('update_bot').impl({ bot_name: 'Extra', label: 'Deputy' }, ctx(primary));
  assert.match(edited.output, /"ok":true/, edited.output);
  assert.equal((db.prepare("SELECT label FROM bots WHERE id='bot_extra_primary'").get() as { label: string }).label, 'Deputy');

  const self = await tool('delete_bot').impl({ bot_name: 'Extra', confirm: true }, ctx(primary));
  assert.match(self.output, /cannot delete yourself/i);

  const guarded = await tool('delete_bot').impl({ bot_name: 'Plain' }, ctx(primary));
  assert.match(guarded.output, /confirm to true/i);
  assert.ok(db.prepare("SELECT 1 FROM bots WHERE name='Plain'").get(), 'a call without confirm removes nothing');

  const removed = await tool('delete_bot').impl({ bot_name: 'Plain', confirm: true }, ctx(primary));
  assert.match(removed.output, /Removed Plain/);
  assert.equal(db.prepare("SELECT 1 FROM bots WHERE name='Plain'").get(), undefined);
});

test('a group chat cannot be made primary', async () => {
  const user = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
  db.prepare("INSERT INTO bots(id,user_id,name,kind,is_primary,created_at,updated_at) VALUES (?,?,?,'room',0,?,?)").run('room_primary_test', user, 'Research Team', now(), now());
  const res = await send('POST', '/api/bots/room_primary_test/primary', undefined, cookie);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as Json).error, /group chat/i);
  assert.equal((db.prepare("SELECT is_primary FROM bots WHERE id='room_primary_test'").get() as { is_primary: number }).is_primary, 0);
});
