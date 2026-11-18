// api-env must be the FIRST import: it points env.ts at a temp database before env.ts reads process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CardBody, EmailReview } from '@orbit/contracts';

process.env.COMPOSIO_API_KEY = '';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { mcpToken } = await import('../engine.js');
const { composioIO } = await import('../composio.js');

const app = createApp();
after(() => cleanupTmpEnv());

/**
 * Review cards end to end, with Composio replaced by a recorder: the bot calls a tool over MCP, the
 * card shows what the action will do, the person edits and answers over the approvals API, and the
 * arguments Composio receives are exactly the person's version.
 */

type Json = Record<string, any>;
type ApprovalCard = Extract<CardBody, { card: 'approval' }>;

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/composio');
const draftFixture = JSON.parse(fs.readFileSync(path.join(FIX, 'responses/gmail-get-draft.json'), 'utf8')).response.data;

/** Every call that reached Composio, in order. */
const reached: { kind: 'meta' | 'action'; name: string; args: Record<string, unknown> }[] = [];
let actionAnswer: (slug: string) => { successful: boolean; data: unknown; error: unknown } = () => ({ successful: true, data: {}, error: null });
composioIO.executeMeta = async (_u, name, args) => {
  reached.push({ kind: 'meta', name, args });
  return { resultType: 'completed', data: { results: [{ response: { successful: true, data: { ok: true } } }] } };
};
composioIO.runAction = async (_u, slug, args) => {
  reached.push({ kind: 'action', name: slug, args });
  return slug === 'GMAIL_GET_DRAFT' ? { successful: true, data: draftFixture, error: null } : actionAnswer(slug);
};

async function signIn(email: string) {
  const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const bots = ((await (await app.request('/api/bots', { headers: { cookie } })).json()) as Json).bots as Json[];
  return { cookie, botId: String(bots[0].id) };
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

async function waitForPending(botId: string, count = 1): Promise<ApprovalCard[]> {
  for (let i = 0; i < 300; i++) {
    const pending = cards(botId).filter((c) => c.status === 'pending');
    if (pending.length >= count) return pending;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`expected ${count} pending card(s)`);
}

const answer = (cookie: string, approvalId: string, body: Record<string, unknown>) =>
  app.request(`/api/approvals/${approvalId}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const metaCalls = () => reached.filter((r) => r.kind === 'meta');

test('review cards over MCP and the approvals API', async (t) => {
  const { cookie, botId } = await signIn('review@example.test');

  await t.test('the card shows the email, and what runs is the person\'s edited version', async () => {
    reached.length = 0;
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'ada@x.test', subject: 'Hi', body: 'Hello' } }] });
    const [card] = await waitForPending(botId);
    const review = card.review as EmailReview;
    assert.deepEqual([review.kind, review.to, review.subject, review.body, review.editable], ['email', ['ada@x.test'], 'Hi', 'Hello', true]);
    assert.equal((await answer(cookie, card.approvalId, { decision: 'allow', edits: { to: ['sam@x.test'], subject: 'Hi Sam' } })).status, 200);
    const out = await call;
    const [sent] = metaCalls();
    const item = (sent.args.tools as Json[])[0];
    assert.equal(item.tool_slug, 'GMAIL_SEND_EMAIL');
    assert.deepEqual([item.arguments.recipient_email, item.arguments.subject, item.arguments.body], ['sam@x.test', 'Hi Sam', 'Hello']);
    assert.match(out, /The user edited GMAIL_SEND_EMAIL before it ran: recipients changed to sam@x\.test; subject changed to “Hi Sam”\./);
    const decided = cards(botId).find((c) => c.approvalId === card.approvalId)!;
    assert.deepEqual([decided.status, decided.edited, (decided.review as EmailReview).subject], ['allowed', true, 'Hi Sam']);
  });

  await t.test('edits that cannot run are refused and the card stays open', async () => {
    reached.length = 0;
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'ada@x.test', subject: 'Hi', body: 'x' } }] });
    const [card] = await waitForPending(botId);
    const bad = await answer(cookie, card.approvalId, { decision: 'allow', edits: { to: [] } });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as Json).error, /at least one recipient/);
    assert.equal(cards(botId).find((c) => c.approvalId === card.approvalId)?.status, 'pending');
    await answer(cookie, card.approvalId, { decision: 'deny' });
    assert.match(await call, /declined/i);
    assert.equal(metaCalls().length, 0);
  });

  await t.test('a batch gets one card per action that asks, and only what was allowed runs', async () => {
    reached.length = 0;
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [
      { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'ada@x.test', subject: 'Hi', body: 'x' } },
      { tool_slug: 'GOOGLECALENDAR_CREATE_EVENT', tool_params: { summary: 'Sync' } },
      { tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} },
    ] });
    const pending = await waitForPending(botId, 2);
    const send = pending.find((c) => c.tool === 'GMAIL_SEND_EMAIL')!;
    const event = pending.find((c) => c.tool === 'GOOGLECALENDAR_CREATE_EVENT')!;
    assert.ok(send && event);
    await answer(cookie, send.approvalId, { decision: 'deny' });
    await answer(cookie, event.approvalId, { decision: 'allow' });
    const out = await call;
    const tools = metaCalls()[0].args.tools as Json[];
    assert.deepEqual(tools.map((x) => x.tool_slug), ['GOOGLECALENDAR_CREATE_EVENT', 'GMAIL_FETCH_EMAILS']);
    assert.deepEqual(tools[0].tool_params, { summary: 'Sync' }, 'the item keeps the argument key the bot used');
    assert.match(out, /Not run: GMAIL_SEND_EMAIL, because the user declined it/);
  });

  await t.test('declining every action that asks runs nothing', async () => {
    reached.length = 0;
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@x.test' } }, { tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }] });
    const [card] = await waitForPending(botId);
    await answer(cookie, card.approvalId, { decision: 'deny' });
    assert.match(await call, /declined/i);
    assert.equal(metaCalls().length, 0);
  });

  await t.test('sending a draft with edits writes them into the draft first', async () => {
    reached.length = 0;
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_DRAFT', arguments: { draft_id: 'd1' } }] });
    const [card] = await waitForPending(botId);
    const review = card.review as EmailReview;
    assert.deepEqual([review.action, review.draftId, review.body], ['send_draft', 'd1', 'First version of the draft.']);
    await answer(cookie, card.approvalId, { decision: 'allow', edits: { body: 'Final version.' } });
    await call;
    assert.deepEqual(reached.map((r) => r.name), ['GMAIL_GET_DRAFT', 'GMAIL_UPDATE_DRAFT', 'COMPOSIO_MULTI_EXECUTE_TOOL']);
    assert.equal(reached[1].args.body, 'Final version.');
    assert.equal(reached[1].args.draft_id, 'd1');
  });

  await t.test('if the draft cannot be updated, nothing is sent and the bot is told', async () => {
    reached.length = 0;
    actionAnswer = () => ({ successful: false, data: null, error: 'quota' });
    try {
      const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_DRAFT', arguments: { draft_id: 'd1' } }] });
      const [card] = await waitForPending(botId);
      await answer(cookie, card.approvalId, { decision: 'allow', edits: { subject: 'New' } });
      assert.match(await call, /Could not apply the user's edits.*Nothing was sent/);
      assert.equal(metaCalls().length, 0);
    } finally {
      actionAnswer = () => ({ successful: true, data: {}, error: null });
    }
  });

  await t.test('editing keeps the card waiting; a decided card cannot be kept open', async () => {
    const call = callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@x.test', subject: 's', body: 'b' } }] });
    const [card] = await waitForPending(botId);
    const ping = () => app.request(`/api/approvals/${card.approvalId}/editing`, { method: 'POST', headers: { cookie } });
    assert.deepEqual(await (await ping()).json(), { ok: true });
    await answer(cookie, card.approvalId, { decision: 'deny' });
    await call;
    assert.deepEqual(await (await ping()).json(), { ok: false });
  });

  await t.test('a direct (non-batch) call is edited the same way', async () => {
    reached.length = 0;
    const call = callTool(botId, 'GMAIL_SEND_EMAIL', { recipient_email: 'a@x.test', subject: 'S', body: 'B' });
    const [card] = await waitForPending(botId);
    await answer(cookie, card.approvalId, { decision: 'allow', edits: { body: 'B2' } });
    await call;
    assert.deepEqual(metaCalls()[0], { kind: 'meta', name: 'GMAIL_SEND_EMAIL', args: { recipient_email: 'a@x.test', extra_recipients: [], cc: [], bcc: [], subject: 'S', body: 'B2' } });
  });
});
