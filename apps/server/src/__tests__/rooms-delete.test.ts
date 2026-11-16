// api-env must be the FIRST import: it points env.ts at a temp database and turns on dev sign-in.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { hub } = await import('../lib/hub.js');
const { appendRow } = await import('../store.js');
const { libraryRoot } = await import('../files.js');

const app = createApp();
after(() => cleanupTmpEnv());

type Json = Record<string, any>;

async function send(method: string, url: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
  const r = await send('POST', '/api/auth/dev', { email });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const me = (await (await send('GET', '/api/auth/me', undefined, cookie)).json()) as Json;
  return { cookie, userId: me.user.id };
}

async function roster(cookie: string): Promise<Json[]> {
  return ((await (await send('GET', '/api/bots', undefined, cookie)).json()) as Json).bots;
}

const rowCount = (botId: string) => (db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(botId) as { n: number }).n;

const owner = await signIn('room-owner@example.test');
const second = (await (await send('POST', '/api/bots', { name: 'Ruby', avatarShape: 'blob', avatarColor: 'pink' }, owner.cookie)).json()) as Json;
assert.ok(second.bot?.id, 'second bot created');
const agents = (await roster(owner.cookie)).filter((b) => b.kind !== 'room');

async function makeRoom(name: string): Promise<string> {
  const r = await send('POST', '/api/rooms', { name, botIds: agents.map((b) => b.id) }, owner.cookie);
  assert.equal(r.status, 200);
  return ((await r.json()) as Json).id;
}

test('the owner deleting a group removes it, its messages and its files, and tells every client', async () => {
  const room = await makeRoom('Brand Design');
  appendRow(room, 'message', { type: 'message', role: 'user', text: 'Kickoff' });
  appendRow(room, 'message', { type: 'message', role: 'assistant', text: 'On it', from: { kind: 'bot', id: agents[0].id, name: agents[0].name } });
  const attachments = path.join(libraryRoot(room), 'attachments');
  fs.mkdirSync(attachments, { recursive: true });
  fs.writeFileSync(path.join(attachments, 'brief.txt'), 'brand brief');
  assert.equal(rowCount(room), 2);

  const events: string[] = [];
  const unsubscribe = hub.subscribe(owner.userId, (ev) => events.push(ev.type));
  const r = await send('DELETE', `/api/rooms/${room}`, undefined, owner.cookie);
  unsubscribe();

  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const after = await roster(owner.cookie);
  assert.equal(after.some((b) => b.id === room), false, 'the group is gone from the roster');
  assert.deepEqual(after.map((b) => b.id).sort(), agents.map((b) => b.id).sort(), 'its member Bots stay');
  assert.equal(rowCount(room), 0, 'its messages are gone');
  assert.equal(fs.existsSync(libraryRoot(room)), false, 'its attached files are gone');
  assert.ok(events.includes('roster'), 'clients are told the roster changed');

  const again = await send('DELETE', `/api/rooms/${room}`, undefined, owner.cookie);
  assert.equal(again.status, 404, 'a deleted group stays deleted');
});

test('only the owner can delete a group, and a Bot is not a group', async () => {
  const room = await makeRoom('Launch Crew');
  const stranger = await signIn('stranger@example.test');

  assert.equal((await send('DELETE', `/api/rooms/${room}`, undefined, stranger.cookie)).status, 404);
  assert.equal((await send('DELETE', `/api/rooms/${agents[1].id}`, undefined, owner.cookie)).status, 404);
  assert.equal((await send('DELETE', `/api/rooms/${room}`)).status, 401);

  const ids = (await roster(owner.cookie)).map((b) => b.id);
  assert.ok(ids.includes(room), 'the group survives a stranger');
  assert.ok(ids.includes(agents[1].id), 'the Bot survives a group delete aimed at it');
});

test('Bot deletion still refuses a group chat', async () => {
  const room = await makeRoom('Ops');
  const r = await send('DELETE', `/api/bots/${room}`, undefined, owner.cookie);

  assert.equal(r.status, 400);
  assert.match(((await r.json()) as Json).error, /is a group chat, not a Bot/);
  assert.ok((await roster(owner.cookie)).some((b) => b.id === room));
});
