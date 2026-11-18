// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EmailReview } from '@orbit/contracts';

process.env.COMPOSIO_API_KEY = '';

const { composioIO } = await import('../composio.js');
const { applyReviewEdits, buildReview, ReviewEditError } = await import('../review/index.js');
const { readDraft } = await import('../review/email.js');
const { innerOutcome } = await import('../agent/tools.js');

after(() => cleanupTmpEnv());

/**
 * The Email card's two halves against what Composio really sends and accepts: building the card
 * from a bot's call (and from a real GMAIL_GET_DRAFT response), and turning the person's edits into
 * arguments every one of which exists in that action's captured schema.
 */

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/composio');
const fixture = (rel: string) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
const schemaParams = (slug: string) => Object.keys(fixture(`schemas/${slug}.json`).input_parameters.properties);
const assertArgsFit = (slug: string, args: Record<string, unknown>) => {
  const known = schemaParams(slug);
  for (const k of Object.keys(args)) assert.ok(known.includes(k), `${slug} has no argument "${k}"`);
};

test('a send card shows every recipient, the subject and the body', async () => {
  const r = (await buildReview('u', 'GMAIL_SEND_EMAIL', { recipient_email: 'ada@x.test', extra_recipients: ['bob@x.test'], cc: ['cc@x.test'], subject: 'Hi', body: 'Hello' })) as EmailReview;
  assert.deepEqual([r.kind, r.action, r.to, r.cc, r.bcc, r.subject, r.body, r.editable], ['email', 'send', ['ada@x.test', 'bob@x.test'], ['cc@x.test'], [], 'Hi', 'Hello', true]);
});

test('a reply card reads message_body, and a forward is read-only', async () => {
  const reply = (await buildReview('u', 'GMAIL_REPLY_TO_THREAD', { thread_id: 't1', recipient_email: 'ada@x.test', message_body: 'Thanks' })) as EmailReview;
  assert.deepEqual([reply.action, reply.body, reply.threadId], ['reply', 'Thanks', 't1']);
  const fwd = (await buildReview('u', 'GMAIL_FORWARD_MESSAGE', { message_id: 'm' })) as EmailReview;
  assert.equal(fwd.editable, false);
});

test('a draft card is read from the real GMAIL_GET_DRAFT response', async () => {
  const draft = fixture('responses/gmail-get-draft.json').response.data;
  const real = composioIO.runAction;
  const asked: [string, Record<string, unknown>][] = [];
  composioIO.runAction = async (_u, slug, args) => { asked.push([slug, args]); return { successful: true, data: draft, error: null }; };
  try {
    const r = (await buildReview('u', 'GMAIL_SEND_DRAFT', { draft_id: 'd1' })) as EmailReview;
    assert.deepEqual(asked, [['GMAIL_GET_DRAFT', { draft_id: 'd1' }]]);
    assert.deepEqual([r.action, r.draftId, r.editable], ['send_draft', 'd1', true]);
    assert.deepEqual(r.to, [draft.message.to]);
    assert.equal(r.subject, draft.message.subject);
    assert.equal(r.body, 'First version of the draft.');
  } finally {
    composioIO.runAction = real;
  }
});

test('a draft that will not load gives a read-only card instead of no card', async () => {
  const real = composioIO.runAction;
  composioIO.runAction = async () => ({ successful: false, data: null, error: 'not found' });
  try {
    const r = (await buildReview('u', 'GMAIL_SEND_DRAFT', { draft_id: 'gone' })) as EmailReview;
    assert.deepEqual([r.kind, r.editable, r.draftId], ['email', false, 'gone']);
  } finally {
    composioIO.runAction = real;
  }
});

test('readDraft takes Cc and Bcc from the headers, keeping quoted names whole', () => {
  const r = readDraft({ message: { to: '"Lee, Ada" <ada@x.test>, bob@x.test', subject: 's', messageText: 'b\n', payload: { headers: [{ name: 'Cc', value: 'c@x.test' }, { name: 'Bcc', value: 'd@x.test' }] } } });
  assert.deepEqual([r.to, r.cc, r.bcc, r.body], [['"Lee, Ada" <ada@x.test>', 'bob@x.test'], ['c@x.test'], ['d@x.test'], 'b']);
});

test('edits to a send become the arguments that run, all of them real GMAIL_SEND_EMAIL arguments', async () => {
  const args = { recipient_email: 'ada@x.test', subject: 'Hi', body: 'Hello', is_html: false };
  const review = await buildReview('u', 'GMAIL_SEND_EMAIL', args);
  const a = applyReviewEdits('GMAIL_SEND_EMAIL', args, review, { to: ['sam@x.test', 'kim@x.test'], subject: 'Hi Sam', body: 'Hello Sam' });
  assert.deepEqual(a.before, []);
  assert.equal(a.args.recipient_email, 'sam@x.test');
  assert.deepEqual(a.args.extra_recipients, ['kim@x.test']);
  assert.equal(a.args.subject, 'Hi Sam');
  assert.equal(a.args.body, 'Hello Sam');
  assertArgsFit('GMAIL_SEND_EMAIL', a.args);
  assert.deepEqual(a.changes, ['recipients changed to sam@x.test, kim@x.test', 'subject changed to “Hi Sam”', 'body edited (sent as the user wrote it)']);
});

test('a reply keeps its subject and edits message_body', async () => {
  const args = { thread_id: 't', recipient_email: 'ada@x.test', message_body: 'Thanks' };
  const review = await buildReview('u', 'GMAIL_REPLY_TO_THREAD', args);
  const a = applyReviewEdits('GMAIL_REPLY_TO_THREAD', args, review, { subject: 'ignored', body: 'Thanks a lot' });
  assert.equal(a.args.message_body, 'Thanks a lot');
  assert.equal('subject' in a.args, false);
  assertArgsFit('GMAIL_REPLY_TO_THREAD', a.args);
  assert.deepEqual(a.changes, ['body edited (sent as the user wrote it)']);
});

test('edits to a draft are written into it first with GMAIL_UPDATE_DRAFT, then the draft is sent as is', () => {
  const review: EmailReview = { kind: 'email', action: 'send_draft', to: ['ada@x.test'], cc: [], bcc: [], subject: 'S', body: 'B', isHtml: false, draftId: 'd1', editable: true };
  const a = applyReviewEdits('GMAIL_SEND_DRAFT', { draft_id: 'd1' }, review, { subject: 'S2' });
  assert.deepEqual(a.args, { draft_id: 'd1' });
  assert.equal(a.before.length, 1);
  assert.equal(a.before[0].slug, 'GMAIL_UPDATE_DRAFT');
  assert.equal(a.before[0].args.draft_id, 'd1');
  assert.equal(a.before[0].args.subject, 'S2');
  assert.equal(a.before[0].args.recipient_email, 'ada@x.test');
  assertArgsFit('GMAIL_UPDATE_DRAFT', a.before[0].args);
});

test('no real change runs exactly what the bot sent', async () => {
  const args = { recipient_email: 'ada@x.test', subject: 'Hi', body: 'Hello' };
  const review = await buildReview('u', 'GMAIL_SEND_EMAIL', args);
  assert.deepEqual(applyReviewEdits('GMAIL_SEND_EMAIL', args, review, { subject: 'Hi' }), { args, before: [], changes: [] });
  assert.deepEqual(applyReviewEdits('GMAIL_SEND_EMAIL', args, review, undefined), { args, before: [], changes: [] });
});

test('edits that cannot run are refused with a reason the person can read', async () => {
  const args = { recipient_email: 'ada@x.test', subject: 'Hi', body: 'Hello' };
  const review = await buildReview('u', 'GMAIL_SEND_EMAIL', args);
  const refused = (edits: unknown) => assert.throws(() => applyReviewEdits('GMAIL_SEND_EMAIL', args, review, edits), ReviewEditError);
  refused({ to: [] });
  refused({ to: ['not an address'] });
  refused({ from: 'me@x.test' });
  refused({ subject: 'x'.repeat(999) });
  const fwd = await buildReview('u', 'GMAIL_FORWARD_MESSAGE', {});
  assert.throws(() => applyReviewEdits('GMAIL_FORWARD_MESSAGE', {}, fwd, { subject: 'x' }), /read-only/);
  assert.throws(() => applyReviewEdits('SLACK_SEND_MESSAGE', {}, undefined, { text: 'x' }), /cannot be edited/);
});

test('a batch whose actions all worked is done; one failure is partial; all failing is failed', () => {
  const routed = fixture('responses/router-multi-execute.json').response.data;
  assert.deepEqual(innerOutcome(routed), { total: 2, failed: 0 });
  const r = (ok: boolean) => ({ response: { successful: ok } });
  assert.deepEqual(innerOutcome({ results: [r(true), r(false)] }), { total: 2, failed: 1 });
  assert.deepEqual(innerOutcome({ results: [r(false)] }), { total: 1, failed: 1 });
  assert.deepEqual(innerOutcome({ something: 'else' }), { total: 0, failed: 0 });
});
