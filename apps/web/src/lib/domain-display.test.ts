import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityItem, CardBody } from '@orbit/contracts';
import { cardPreview } from '../domain/card-display.js';
import {
  ACTIVITY_LIMIT,
  PREVIEW_CHARS,
  SEEN_LIMIT,
  activityFromRow,
  activityKey,
  activityPreview,
  botNameFor,
  mergeActivity,
  pruneSeen,
} from '../domain/activity-feed.js';
import { displayName, sortedRows } from '../domain/transcript-utils.js';

// Behaviour of the pieces the store used to own: the strings people read in the feed,
// the keys that keep it deduped, and the labels shown beside a bot's name.

const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  botId: 'b1', botName: 'Ada', kind: 'message', preview: 'hi', at: 1_000, ...over,
});

// ---------------------------------------------------------------- cardPreview

test('a pending approval previews its title', () => {
  assert.equal(
    cardPreview({
      type: 'card', card: 'approval', approvalId: 'ap1', title: 'Send the email?', detail: 'To Sam',
      tool: 'gmail.send', args: null, status: 'pending',
    }),
    'Send the email?',
  );
});

test('a pending question previews the question', () => {
  assert.equal(
    cardPreview({ type: 'card', card: 'question', question: 'Which account?', options: ['work', 'home'], status: 'pending' }),
    'Which account?',
  );
});

test('a pending connect card names the toolkit it wants connected', () => {
  assert.equal(
    cardPreview({ type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'To read mail', status: 'pending' }),
    'Connect Gmail',
  );
});

test('a pending draft previews its subject, or the destination when there is none', () => {
  const draft = {
    type: 'card', card: 'draft', channel: 'email', to: 'sam@example.com', text: 'Hi Sam', approvalId: 'ap2',
  } as const;
  assert.equal(cardPreview({ ...draft, subject: 'Quarterly update', status: 'pending' }), 'Quarterly update');
  assert.equal(cardPreview({ ...draft, status: 'pending' }), 'Draft email message to sam@example.com');
  assert.equal(
    cardPreview({ ...draft, channel: 'slack', subject: '', status: 'pending' }),
    'Draft slack message to sam@example.com',
  );
});

test('a card that no longer needs anyone previews nothing', () => {
  const cards: CardBody[] = [
    { type: 'card', card: 'approval', approvalId: 'a', title: 'T', detail: 'D', tool: 't', args: null, status: 'allowed' },
    { type: 'card', card: 'approval', approvalId: 'a', title: 'T', detail: 'D', tool: 't', args: null, status: 'always' },
    { type: 'card', card: 'approval', approvalId: 'a', title: 'T', detail: 'D', tool: 't', args: null, status: 'denied' },
    { type: 'card', card: 'approval', approvalId: 'a', title: 'T', detail: 'D', tool: 't', args: null, status: 'expired' },
    { type: 'card', card: 'question', question: 'Q', options: [], status: 'answered' },
    { type: 'card', card: 'question', question: 'Q', options: [], status: 'dismissed' },
    { type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'r', status: 'connected' },
    { type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'r', status: 'skipped' },
    { type: 'card', card: 'draft', channel: 'email', to: 'sam@example.com', text: 'x', approvalId: 'a', status: 'sent' },
    { type: 'card', card: 'draft', channel: 'email', to: 'sam@example.com', text: 'x', approvalId: 'a', status: 'discarded' },
  ];
  for (const body of cards) {
    assert.equal(cardPreview(body), null, `${body.card}/${body.status} should not preview`);
  }
});

// ------------------------------------------------------------ activityPreview

test('the preview constants are the ones the feed was built around', () => {
  assert.equal(ACTIVITY_LIMIT, 200);
  assert.equal(PREVIEW_CHARS, 110);
  assert.equal(SEEN_LIMIT, 1000);
});

test('a preview collapses whitespace and trims the edges', () => {
  assert.equal(activityPreview('  Fixed\n\nthe   build\tand shipped it  '), 'Fixed the build and shipped it');
});

test('a preview of exactly the limit is left whole', () => {
  const exact = 'x'.repeat(PREVIEW_CHARS);
  assert.equal(activityPreview(exact), exact);
  assert.equal(activityPreview(exact).length, 110);
});

test('one character past the limit is cut at 110 with an ellipsis', () => {
  assert.equal(activityPreview(`${'x'.repeat(PREVIEW_CHARS)}y`), `${'x'.repeat(PREVIEW_CHARS)}…`);
});

test('the cut drops the trailing space before the ellipsis', () => {
  // 109 characters, then a space at position 110, then more text: the slice ends on the
  // space, which is trimmed before the ellipsis is appended.
  const text = `${'b'.repeat(PREVIEW_CHARS - 1)} tail words`;
  assert.equal(activityPreview(text), `${'b'.repeat(PREVIEW_CHARS - 1)}…`);
});

test('a caller can ask for a shorter line', () => {
  assert.equal(activityPreview('one two three four', 7), 'one two…');
  assert.equal(activityPreview('one two', 7), 'one two');
});

// -------------------------------------------------------------- activityKey

test('a row entry is keyed by bot and seq, a live one by bot, kind and time', () => {
  assert.equal(activityKey(item({ botId: 'b7', seq: 42 })), 'row:b7:42');
  assert.equal(activityKey(item({ botId: 'b7', kind: 'working', at: 1_700_000_000_000 })), 'live:b7:working:1700000000000');
  assert.equal(activityKey(item({ botId: 'b7', seq: 0 })), 'row:b7:0');
});

// ------------------------------------------------------------ mergeActivity

test('merging nothing leaves the same array in place', () => {
  const prev = [item({ seq: 1 })];
  assert.equal(mergeActivity(prev, []), prev);
});

test('a newer copy of a row replaces the old one instead of duplicating it', () => {
  const prev = [item({ seq: 1, preview: 'old text', at: 1_000 })];
  const next = mergeActivity(prev, [item({ seq: 1, preview: 'new text', at: 1_000 })]);
  assert.equal(next.length, 1);
  assert.equal(next[0].preview, 'new text');
});

test('a live entry dedupes on bot, kind and stamp', () => {
  const prev = [item({ kind: 'working', at: 5_000, preview: 'Thinking' })];
  const next = mergeActivity(prev, [item({ kind: 'working', at: 5_000, preview: 'Working on it' })]);
  assert.equal(next.length, 1);
  assert.equal(next[0].preview, 'Working on it');
});

test('the feed is newest first, with equal stamps broken by seq', () => {
  const merged = mergeActivity(
    [item({ seq: 1, at: 100 })],
    [item({ seq: 4, at: 300 }), item({ seq: 2, at: 200 }), item({ seq: 9, at: 200 })],
  );
  assert.deepEqual(merged.map((i) => i.at), [300, 200, 200, 100]);
  assert.deepEqual(merged.slice(1, 3).map((i) => i.seq), [9, 2]);
});

test('the feed is capped at the limit, keeping the newest', () => {
  const incoming = Array.from({ length: ACTIVITY_LIMIT + 5 }, (_, i) => item({ seq: i + 1, at: i + 1 }));
  const merged = mergeActivity([], incoming);
  assert.equal(merged.length, ACTIVITY_LIMIT);
  assert.equal(merged[0].at, ACTIVITY_LIMIT + 5);
  assert.equal(merged[merged.length - 1].at, 6);
});

test('a caller can cap the feed tighter', () => {
  const merged = mergeActivity([], [item({ at: 1 }), item({ at: 3 }), item({ at: 2 })], 2);
  assert.deepEqual(merged.map((i) => i.at), [3, 2]);
});

// ----------------------------------------------------------- feed plumbing

test('only finished assistant messages and pending cards reach the feed', () => {
  const base = { botId: 'b1', generation: 1, seq: 3, updatedSeq: 1, kind: 'message' as const, createdAt: 1_000 };
  assert.equal(activityFromRow({ ...base, body: { type: 'message', role: 'assistant', text: 'Done' } }, 'Ada')?.preview, 'Done');
  assert.equal(activityFromRow({ ...base, body: { type: 'message', role: 'assistant', text: 'Half', streaming: true } }, 'Ada'), null);
  assert.equal(activityFromRow({ ...base, body: { type: 'message', role: 'user', text: 'Hi' } }, 'Ada'), null);
  assert.equal(activityFromRow({ ...base, kind: 'tool-call', body: { type: 'tool-call', callId: 'c', name: 'x', label: 'x', status: 'done' } }, 'Ada'), null);
  const card = activityFromRow(
    { ...base, kind: 'card', body: { type: 'card', card: 'question', question: 'Which?', options: [], status: 'pending' } },
    'Ada',
  );
  assert.equal(card?.kind, 'card');
  assert.equal(card?.preview, 'Which?');
  assert.equal(card?.seq, 3);
});

test('a bot is named from the roster, falling back to its id', () => {
  const bots = [
    { id: 'b1', name: 'Ada', label: '' },
    { id: 'b2', name: 'Grace', label: 'Finance' },
  ] as Parameters<typeof botNameFor>[0];
  assert.equal(botNameFor(bots, 'b1'), 'Ada');
  assert.equal(botNameFor(bots, 'gone'), 'gone');
});

test('seen keys are only pruned once they run past the limit', () => {
  const small: Record<string, number> = { a: 1, b: 2 };
  assert.equal(pruneSeen(small), small);
  const big: Record<string, number> = {};
  for (let i = 0; i < SEEN_LIMIT + 10; i++) big[`k${i}`] = i;
  const pruned = pruneSeen(big);
  assert.equal(Object.keys(pruned).length, SEEN_LIMIT / 2);
  assert.equal(pruned.k0, undefined);
  assert.equal(pruned[`k${SEEN_LIMIT + 9}`], SEEN_LIMIT + 9);
});

// ------------------------------------------------------------- transcript

test('rows are ordered by seq and a missing transcript is empty', () => {
  const row = (seq: number) => ({
    botId: 'b1', generation: 1, seq, updatedSeq: 1, kind: 'message' as const,
    body: { type: 'message' as const, role: 'user' as const, text: `#${seq}` }, createdAt: seq,
  });
  const rows = sortedRows({ generation: 1, loaded: true, bySeq: { 3: row(3), 1: row(1), 2: row(2) } });
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(sortedRows(undefined), []);
});

test('a bot shows its name, plus its label when it has one', () => {
  assert.equal(displayName({ name: 'Ada', label: '' }), 'Ada');
  assert.equal(displayName({ name: 'Grace', label: 'Finance' }), 'Grace · Finance');
});
