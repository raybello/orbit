// api-env must be the FIRST import: it points env.ts at a temp database before env.ts reads process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

process.env.COMPOSIO_API_KEY = '';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { mcpToken } = await import('../engine.js');
const { composioIO } = await import('../composio.js');
const { appOfSlug } = await import('../domain/app-access.js');

const app = createApp();
after(() => cleanupTmpEnv());

/**
 * Per-bot app access: every bot shares the person's connections, and the person can turn one app off
 * for one bot. That bot must not reach the app by any route; every other bot keeps it.
 */

type Json = Record<string, any>;

const reached: { name: string; args: Json; disabled: readonly string[] }[] = [];
composioIO.executeMeta = async (_u, name, args, disabled = []) => {
  reached.push({ name, args, disabled });
  const tools = (args.tools ?? []) as { tool_slug: string }[];
  return { resultType: 'completed', data: { results: tools.map((t, index) => ({ tool_slug: t.tool_slug, index, response: { successful: true, data: { ok: true } } })) } };
};

async function signIn(email: string) {
  const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const bots = ((await (await app.request('/api/bots', { headers: { cookie } })).json()) as Json).bots as Json[];
  return { cookie, botId: String(bots[0].id) };
}

/** A second bot of the same person, written straight to the table (no engine is started). */
function addBot(userId: string, id: string) {
  const t = Date.now();
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, userId, id, 'managed', t, t);
  return id;
}

async function callTool(botId: string, name: string, args: Json): Promise<string> {
  const r = await app.request(`/mcp/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(botId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await r.json()) as Json).result.content.map((c: { text: string }) => c.text).join('');
}

const setAccess = (cookie: string, slug: string, botId: string, allowed: boolean) =>
  app.request(`/api/apps/${slug}/access/${botId}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ allowed }) });

const read = (slug: string) => ({ tools: [{ tool_slug: slug, arguments: { document_id: 'd1', max_results: 1 } }] });

test('a slug is matched to its own app, never to a shorter one that merely shares a prefix', () => {
  assert.equal(appOfSlug('GMAIL_SEND_EMAIL', ['gmail', 'googledocs']), 'gmail');
  assert.equal(appOfSlug('GOOGLEDOCS_GET_DOCUMENT_BY_ID', ['gmail']), null);
  assert.equal(appOfSlug('googledocs', ['googledocs']), 'googledocs');
  assert.equal(appOfSlug('GOOGLE_MAPS_SEARCH', ['google', 'google_maps']), 'google_maps');
  assert.equal(appOfSlug('GMAILX_SEND', ['gmail']), null);
});

test('an app turned off for one bot is refused to it and only it, by every route, until it is allowed again', async () => {
  const { cookie, botId: quill } = await signIn('access@test.local');
  const userId = (db.prepare('SELECT user_id FROM bots WHERE id=?').get(quill) as { user_id: string }).user_id;
  const atlas = addBot(userId, 'bot_access_atlas');

  assert.equal((await setAccess(cookie, 'GMail', quill, false)).status, 200);
  const listing = (await (await app.request('/api/apps', { headers: { cookie } })).json()) as Json;
  assert.deepEqual(listing.revoked, { [quill]: ['gmail'] });

  reached.length = 0;
  const refused = await callTool(quill, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [read('GOOGLEDOCS_GET_DOCUMENT_BY_ID').tools[0], read('GMAIL_FETCH_EMAILS').tools[0]] });
  assert.match(refused, /gmail is turned off for you/);
  assert.equal(reached.length, 0, 'a batch holding a turned-off app must not reach Composio at all');
  assert.match(await callTool(quill, 'GMAIL_SEND_EMAIL', { recipient_email: 'a@b.c', subject: 's', body: 'b' }), /turned off for you/);
  assert.match(await callTool(quill, 'request_app_connection', { toolkit: 'gmail', reason: 'read mail' }), /turned off for you/);
  assert.match(await callTool(quill, 'create_event_routine', { name: 'x', prompt: 'y', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' }), /turned off for you/);
  assert.equal(reached.length, 0);
  const connectCards = db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND body LIKE '%\"card\":\"connect\"%'").get(quill) as { n: number };
  assert.equal(connectCards.n, 0, 'no connect card for an app the person turned off');

  await callTool(quill, 'COMPOSIO_MULTI_EXECUTE_TOOL', read('GOOGLEDOCS_GET_DOCUMENT_BY_ID'));
  assert.equal(reached.length, 1, 'the apps still allowed keep working');
  assert.deepEqual(reached[0].disabled, ['gmail'], "the bot's Composio session has the app disabled as well");

  await callTool(atlas, 'COMPOSIO_MULTI_EXECUTE_TOOL', read('GMAIL_FETCH_EMAILS'));
  assert.equal(reached.length, 2, 'another bot keeps the app');
  assert.deepEqual(reached[1].disabled, []);

  assert.equal((await setAccess(cookie, 'gmail', quill, true)).status, 200);
  await callTool(quill, 'COMPOSIO_MULTI_EXECUTE_TOOL', read('GMAIL_FETCH_EMAILS'));
  assert.equal(reached.length, 3, 'allowed again, the call goes through');
  assert.deepEqual(reached[2].disabled, []);
});

test("only the bot's owner can change its app access", async () => {
  const { botId: mine } = await signIn('access@test.local');
  const { cookie: theirs } = await signIn('owner-b@test.local');
  assert.equal((await setAccess(theirs, 'gmail', mine, false)).status, 404);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM bot_app_revocations WHERE bot_id=?').get(mine) as { n: number }).n, 0);
});
