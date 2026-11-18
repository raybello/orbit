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
