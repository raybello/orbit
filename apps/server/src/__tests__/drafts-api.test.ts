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
 * Draft-first email end to end, with Composio replaced by a recorder: a bot writes a Gmail draft over
 * MCP without being asked, the draft appears as an email card, and the person saves, sends or
 * discards it over the API. Gmail is only told what the person did.
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
  const tools = (args.tools ?? []) as { tool_slug: string; arguments?: Json }[];
  return { resultType: 'completed', data: { results: tools.map((t, index) => ({ tool_slug: t.tool_slug, index, response: { successful: true, data: t.tool_slug === 'GMAIL_CREATE_EMAIL_DRAFT' ? { id: 'r-draft-1', message: { id: 'm1', threadId: 't1' } } : t.tool_slug === 'GMAIL_UPDATE_DRAFT' ? { id: String(t.arguments?.draft_id), message: { id: 'm2', threadId: 't1' } } : { ok: true } } })) } };
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

type DraftCard = Extract<CardBody, { card: 'draft' }>;
const draftCards = (botId: string) =>
  (db.prepare("SELECT seq, body FROM rows WHERE bot_id=? AND kind='card' ORDER BY seq").all(botId) as { seq: number; body: string }[])
    .map((r) => ({ seq: r.seq, body: JSON.parse(r.body) as CardBody }))
    .filter((r): r is { seq: number; body: DraftCard } => r.body.card === 'draft');
const act = (cookie: string, botId: string, seq: number, body: Json) =>
  app.request(`/api/bots/${botId}/cards/${seq}/draft`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const actions = () => reached.filter((r) => r.kind === 'action').map((r) => r.name);
const write = (botId: string, slug: string, args: Json) => callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: slug, arguments: args }] });

test('draft-first email over MCP and the draft card API', async (t) => {
  const { cookie, botId } = await signIn('drafts@example.test');
  let seq = 0;

  await t.test('a bot writes a draft without a card asking, and the draft appears in full', async () => {
    reached.length = 0;
    const out = await write(botId, 'GMAIL_CREATE_EMAIL_DRAFT', { recipient_email: 'ada@x.test', extra_recipients: ['bob@x.test'], cc: ['c@x.test'], subject: 'Plan', body: 'First pass' });
    assert.equal(cards(botId).filter((c) => c.status === 'pending').length, 0, 'no approval was asked');
    assert.match(out, /in front of the user as an email card/);
    assert.match(out, /Do not send it yourself/);
    const [card] = draftCards(botId);
    seq = card.seq;
    assert.equal(card.body.status, 'pending');
    assert.deepEqual([card.body.email?.draftId, card.body.email?.to, card.body.email?.cc, card.body.email?.subject, card.body.email?.body, card.body.email?.threadId], ['r-draft-1', ['ada@x.test', 'bob@x.test'], ['c@x.test'], 'Plan', 'First pass', 't1']);
  });

  await t.test('the bot updating its draft updates the same card', async () => {
    await write(botId, 'GMAIL_UPDATE_DRAFT', { draft_id: 'r-draft-1', body: 'Second pass' });
    const all = draftCards(botId);
    assert.equal(all.length, 1);
    assert.deepEqual([all[0].body.email?.subject, all[0].body.email?.body], ['Plan', 'Second pass']);
  });

  await t.test('saving the person\'s edits writes them into the Gmail draft', async () => {
    reached.length = 0;
    const r = await act(cookie, botId, seq, { action: 'save', edits: { subject: 'Plan v2' } });
    assert.equal(r.status, 200);
    assert.deepEqual(actions(), ['GMAIL_UPDATE_DRAFT']);
    assert.equal(reached[0].args.subject, 'Plan v2');
    assert.equal(reached[0].args.draft_id, 'r-draft-1');
    assert.equal(draftCards(botId)[0].body.email?.subject, 'Plan v2');
    assert.equal(draftCards(botId)[0].body.status, 'pending');
  });

  await t.test('edits that cannot run are refused and nothing reaches Gmail', async () => {
    reached.length = 0;
    const r = await act(cookie, botId, seq, { action: 'send', edits: { to: ['nope'] } });
    assert.equal(r.status, 400);
    assert.deepEqual(actions(), []);
  });

  await t.test('if Gmail will not send, the card stays a draft and says why', async () => {
    reached.length = 0;
    actionAnswer = (slug) => (slug === 'GMAIL_SEND_DRAFT' ? { successful: false, data: null, error: 'rate limited' } : { successful: true, data: {}, error: null });
    try {
      const r = await act(cookie, botId, seq, { action: 'send' });
      assert.equal(r.status, 502);
      assert.match(((await r.json()) as Json).error, /did not send it/);
      assert.equal(draftCards(botId)[0].body.status, 'pending');
    } finally {
      actionAnswer = () => ({ successful: true, data: {}, error: null });
    }
  });

  await t.test('sending with edits updates the draft first, then sends it', async () => {
    reached.length = 0;
    const r = await act(cookie, botId, seq, { action: 'send', edits: { body: 'Final' } });
    assert.equal(r.status, 200);
    assert.deepEqual(actions(), ['GMAIL_UPDATE_DRAFT', 'GMAIL_SEND_DRAFT']);
    assert.equal(reached[0].args.body, 'Final');
    assert.deepEqual(reached[1].args, { draft_id: 'r-draft-1' });
    const [card] = draftCards(botId);
    assert.deepEqual([card.body.status, card.body.email?.body], ['sent', 'Final']);
  });

  await t.test('a sent draft cannot be sent or discarded again', async () => {
    assert.equal((await act(cookie, botId, seq, { action: 'send' })).status, 409);
    assert.equal((await act(cookie, botId, seq, { action: 'discard' })).status, 409);
  });

  await t.test('discarding deletes the draft from Gmail', async () => {
    await write(botId, 'GMAIL_CREATE_EMAIL_DRAFT', { recipient_email: 'ada@x.test', subject: 'Another', body: 'x' });
    const card = draftCards(botId).find((c) => c.body.status === 'pending')!;
    reached.length = 0;
    assert.equal((await act(cookie, botId, card.seq, { action: 'discard' })).status, 200);
    assert.deepEqual(actions(), ['GMAIL_DELETE_DRAFT']);
    assert.equal(draftCards(botId).find((c) => c.seq === card.seq)?.body.status, 'discarded');
  });

  await t.test('another person cannot act on these cards', async () => {
    const other = await signIn('drafts-other@example.test');
    assert.equal((await act(other.cookie, botId, seq, { action: 'send' })).status, 404);
  });

  await t.test('a draft the card does not know is read from Gmail when the bot updates it', async () => {
    reached.length = 0;
    await write(botId, 'GMAIL_UPDATE_DRAFT', { draft_id: 'older-draft', body: 'x' });
    assert.ok(actions().includes('GMAIL_GET_DRAFT'));
    const card = draftCards(botId).find((c) => c.body.email?.draftId === 'older-draft')!;
    assert.equal(card.body.email?.subject, draftFixture.message.subject);
  });
});
