// api-env must be the FIRST import: it points env.ts at a temp database before env.ts reads process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { CardBody } from '@orbit/contracts';

// No Composio account: a call that is allowed fails at Composio, which these cases do not care about.
process.env.COMPOSIO_API_KEY = '';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { mcpToken } = await import('../engine.js');

const app = createApp();
after(() => cleanupTmpEnv());

/**
 * The Google approval decisions over the real routes: an engine calls a tool on /mcp/<bot>, the card
 * appears in the conversation, and the person answers on /api/approvals/:id.
 */

type Json = Record<string, any>;
type ApprovalCard = Extract<CardBody, { card: 'approval' }>;

async function signIn(email: string): Promise<{ cookie: string; botId: string; userId: string }> {
  const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const bots = ((await (await app.request('/api/bots', { headers: { cookie } })).json()) as Json).bots as Json[];
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string }).id;
  return { cookie, botId: String(bots[0].id), userId };
}

async function callTool(botId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await app.request(`/mcp/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(botId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await r.json()) as Json).result.content.map((c: { text: string }) => c.text).join('');
}

const cards = (botId: string): ApprovalCard[] =>
  (db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='card' ORDER BY seq").all(botId) as { body: string }[])
    .map((r) => JSON.parse(r.body) as CardBody)
    .filter((b): b is ApprovalCard => b.card === 'approval');

async function waitForPending(botId: string): Promise<ApprovalCard> {
  for (let i = 0; i < 200; i++) {
    const card = cards(botId).find((c) => c.status === 'pending');
    if (card) return card;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('no approval card appeared');
}

const decide = (cookie: string, approvalId: string, decision: string) =>
  app.request(`/api/approvals/${approvalId}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });

const multi = (tool_slug: string, args: Record<string, unknown>) => ({ tools: [{ tool_slug, arguments: args }] });
const policy = (userId: string, tool: string) => (db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, tool) as { mode: string } | undefined)?.mode;

test('Google approvals over MCP and the approvals API', async (t) => {
  const { cookie, botId, userId } = await signIn('google-approvals@example.test');

  await t.test('sending email asks, the card offers no "Always allow", and choosing it anyway allows once', async () => {
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi('GMAIL_SEND_DRAFT', { draft_id: 'd1' }));
    const card = await waitForPending(botId);
    assert.equal(card.tool, 'GMAIL_SEND_DRAFT');
    assert.equal(card.offerAlways, false);
    assert.equal((await decide(cookie, card.approvalId, 'always')).status, 200);
    await call;
    assert.equal(cards(botId).find((c) => c.approvalId === card.approvalId)?.status, 'allowed');
    assert.equal(policy(userId, 'GMAIL_SEND_DRAFT'), undefined, 'no standing permission was stored');
  });

  await t.test('a stored "Always allow" for sending (from before this change) still asks', async () => {
    db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, 'GMAIL_SEND_EMAIL');
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi('GMAIL_SEND_EMAIL', { subject: 'hi' }));
    const card = await waitForPending(botId);
    assert.equal(card.tool, 'GMAIL_SEND_EMAIL');
    await decide(cookie, card.approvalId, 'deny');
    assert.match(await call, /declined/i);
  });

  await t.test('a calendar change offers "Always allow" and stores it', async () => {
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi('GOOGLECALENDAR_CREATE_EVENT', { summary: 'Sync' }));
    const card = await waitForPending(botId);
    assert.equal(card.offerAlways, undefined);
    await decide(cookie, card.approvalId, 'always');
    await call;
    assert.equal(policy(userId, 'GOOGLECALENDAR_CREATE_EVENT'), 'always_allow');
  });

  await t.test('a new draft and a profile read run without a card', async () => {
    const before = cards(botId).length;
    await callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi('GMAIL_CREATE_EMAIL_DRAFT', { subject: 'x' }));
    await callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi('GMAIL_WHO_AM_I', {}));
    assert.equal(cards(botId).length, before);
  });
});

// ---------- per-bot "Always allow" ----------

const req = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const pendingCount = (botId: string) => cards(botId).filter((c) => c.status === 'pending').length;
const botPolicies = (botId: string) => (db.prepare('SELECT tool FROM bot_policies WHERE bot_id=? ORDER BY tool').all(botId) as { tool: string }[]).map((r) => r.tool);

/** A call that must run without a card: it reaches Composio (which fails here, having no key) and no card is left waiting. */
async function runsWithoutCard(botId: string, slug: string, args: Record<string, unknown>) {
  const before = pendingCount(botId);
  const text = await callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(slug, args));
  assert.match(text, /^Tool error/, `${slug} should have gone straight to the app`);
  assert.equal(pendingCount(botId), before);
}

/** A call that must ask: answer its card with `decision` and return the card. */
async function asksAndAnswer(botId: string, cookie: string, slug: string, args: Record<string, unknown>, decision: string): Promise<ApprovalCard> {
  const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(slug, args));
  const card = await waitForPending(botId);
  assert.equal(card.tool, slug);
  assert.equal((await decide(cookie, card.approvalId, decision)).status, 200);
  await call;
  return card;
}

test('per-bot "Always allow": off by default, kept for that bot only, and remembered on later calls', async (t) => {
  const { cookie, botId: ada, userId } = await signIn('per-bot@example.test');
  const created = await req(cookie, 'POST', '/api/bots', { name: 'Scout' });
  assert.equal(created.status, 200);
  const scout = String(((await created.json()) as Json).bot.id);
  const SEND = 'GMAIL_SEND_DRAFT';

  await t.test('every bot starts with the setting off', async () => {
    const bots = ((await (await req(cookie, 'GET', '/api/bots')).json()) as Json).bots as Json[];
    for (const b of bots.filter((x) => x.kind !== 'room')) assert.equal(b.alwaysAllow, false, String(b.name));
  });

  await t.test('while off, a send card offers no "Always allow" at all', async () => {
    const card = await asksAndAnswer(ada, cookie, SEND, { draft_id: 'd' }, 'deny');
    assert.equal(card.offerAlways, false);
    assert.equal(card.alwaysFor, undefined);
  });

  await t.test('turned on, the card offers "Always allow for <Bot>", sending included, and keeps it for that bot', async () => {
    const r = await req(cookie, 'PATCH', `/api/bots/${ada}`, { alwaysAllow: true });
    assert.equal(((await r.json()) as Json).bot.alwaysAllow, true);
    const card = await asksAndAnswer(ada, cookie, SEND, { draft_id: 'd' }, 'always');
    const name = (db.prepare('SELECT name FROM bots WHERE id=?').get(ada) as { name: string }).name;
    assert.deepEqual(card.alwaysFor, { botId: ada, botName: name });
    assert.notEqual(card.offerAlways, false, 'the button is offered');
    assert.equal(cards(ada).find((c) => c.approvalId === card.approvalId)?.status, 'always');
    assert.deepEqual(botPolicies(ada), [SEND]);
    assert.equal(policy(userId, SEND), undefined, 'nothing was stored for the person\'s other bots');
    const listed = ((await (await req(cookie, 'GET', `/api/bots/${ada}/policies`)).json()) as Json).policies as Json[];
    assert.deepEqual(listed.map((p) => p.tool), [SEND]);
  });

  await t.test('later calls by that bot run without asking, every time', async () => {
    await runsWithoutCard(ada, SEND, { draft_id: 'd2' });
    await runsWithoutCard(ada, SEND, { draft_id: 'd3' });
    // Written as tool_params and in another case, it is still the same action.
    const before = pendingCount(ada);
    const text = await callTool(ada, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'gmail_send_draft', tool_params: { draft_id: 'd4' } }] });
    assert.match(text, /^Tool error/);
    assert.equal(pendingCount(ada), before);
  });

  await t.test('another bot of the same person still asks', async () => {
    const card = await asksAndAnswer(scout, cookie, SEND, { draft_id: 'd' }, 'deny');
    assert.equal(card.offerAlways, false);
    assert.equal(card.alwaysFor, undefined);
  });

  await t.test('another action of the same bot still asks', async () => {
    await asksAndAnswer(ada, cookie, 'GMAIL_SEND_EMAIL', { subject: 'x' }, 'deny');
  });

  await t.test('turned off, the bot asks again and the list is kept; turned back on, it is used again', async () => {
    await req(cookie, 'PATCH', `/api/bots/${ada}`, { alwaysAllow: false });
    const card = await asksAndAnswer(ada, cookie, SEND, { draft_id: 'd' }, 'deny');
    assert.equal(card.alwaysFor, undefined);
    assert.deepEqual(botPolicies(ada), [SEND]);
    await req(cookie, 'PATCH', `/api/bots/${ada}`, { alwaysAllow: true });
    await runsWithoutCard(ada, SEND, { draft_id: 'd5' });
  });

  await t.test('a "Never" the person stored still blocks it', async () => {
    db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'blocked')").run(userId, SEND);
    assert.match(await callTool(ada, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(SEND, { draft_id: 'd' })), /declined/i);
    db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(userId, SEND);
  });

  await t.test('removing it from the list makes the bot ask again', async () => {
    assert.equal((await req(cookie, 'DELETE', `/api/bots/${ada}/policies/${SEND}`)).status, 200);
    assert.deepEqual(botPolicies(ada), []);
    await asksAndAnswer(ada, cookie, SEND, { draft_id: 'd' }, 'deny');
  });

  await t.test('removing the bot removes its list', async () => {
    db.prepare('INSERT INTO bot_policies(bot_id, tool, created_at) VALUES (?,?,?)').run(scout, SEND, Date.now());
    // The table cascades from bots; the delete route's own clean-up (engine, computer) is covered elsewhere.
    db.prepare('DELETE FROM bots WHERE id=?').run(scout);
    assert.deepEqual(botPolicies(scout), []);
  });

  await t.test('another person cannot read or change this bot\'s list', async () => {
    const other = await signIn('per-bot-other@example.test');
    assert.equal((await req(other.cookie, 'GET', `/api/bots/${ada}/policies`)).status, 404);
    assert.equal((await req(other.cookie, 'DELETE', `/api/bots/${ada}/policies/${SEND}`)).status, 404);
  });
});

