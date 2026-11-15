import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CardBody } from '@orbit/contracts';
import { CARD_STATUSES, type CardEvent, type CardKind, type CardStatus } from '../domain/card-workflow.js';
import { cardStateOf, decideCard, IllegalCardMoveError, UnknownCardError } from '../core/card-service.js';

/**
 * The adapter from a persisted CardBody to the pure card machine.
 *
 * The interesting assertions are cross-products, written out here independently of the module's own
 * tables: every card accepts exactly its own events, every other event throws, and every terminal
 * card rejects everything. A wrong status would also fail the contract-values check.
 */

type EventType = CardEvent['type'];

const userId = 'usr_1';
const at = 1_700_000_000_000;
const cardId = '42';

const approval: CardBody = {
  type: 'card', card: 'approval', approvalId: 'apr_1', title: 'Allow Quinn to send an email?',
  detail: 'to: alex@example.com\ntool: GMAIL_SEND_EMAIL', tool: 'GMAIL_SEND_EMAIL',
  toolkit: 'gmail', toolkitName: 'Gmail', logo: 'https://logo.example/gmail.png',
  args: { to: 'alex@example.com' }, status: 'pending',
};
const question: CardBody = {
  type: 'card', card: 'question', question: 'Which inbox should I watch?', options: ['Work', 'Personal'], status: 'pending',
};
const connect: CardBody = {
  type: 'card', card: 'connect', toolkit: 'slack', toolkitName: 'Slack', logo: 'https://logo.example/slack.png',
  reason: 'I need Slack to post the digest.', status: 'pending',
};
const draft: CardBody = {
  type: 'card', card: 'draft', channel: 'email', to: 'alex@example.com', subject: 'Seat cap',
  text: 'Any plans to support more seats?', approvalId: 'apr_2', status: 'pending',
};

const pending: Record<CardKind, CardBody> = { approval, question, connect, draft };

/** The events each card accepts, and the contract status each one produces. */
const LEGAL: Record<CardKind, Partial<Record<EventType, CardStatus>>> = {
  approval: { approve: 'allowed', deny: 'denied', expire: 'expired' },
  question: { answer: 'answered', dismiss: 'dismissed' },
  connect: { connect: 'connected', skip: 'skipped' },
  draft: { send: 'sent', dismiss: 'discarded' },
};

/** Every terminal status of each card, written out rather than derived from the machine. */
const TERMINAL: Record<CardKind, CardStatus[]> = {
  approval: ['allowed', 'always', 'denied', 'expired'],
  question: ['answered', 'dismissed'],
  connect: ['connected', 'skipped'],
  draft: ['sent', 'discarded'],
};

const ALL_EVENTS: EventType[] = ['approve', 'deny', 'answer', 'dismiss', 'connect', 'skip', 'send', 'expire'];

function event(type: EventType): CardEvent {
  const base = { userId, at };
  switch (type) {
    case 'approve': return { type, ...base };
    case 'deny': return { type, ...base };
    case 'answer': return { type, ...base, answer: 'Work' };
    case 'dismiss': return { type, ...base };
    case 'connect': return { type, ...base };
    case 'skip': return { type, ...base };
    case 'send': return { type, ...base };
    case 'expire': return { type, at };
  }
}

function terminalBody(card: CardKind, status: CardStatus): CardBody {
  return { ...pending[card], status } as CardBody;
}

const statusOf = (body: CardBody): CardStatus => body.status;

describe('decideCard — every card, every event', () => {
  for (const card of Object.keys(pending) as CardKind[]) {
    test(`${card}: legal events produce the contract status, every other event throws`, () => {
      for (const type of ALL_EVENTS) {
        const expected = LEGAL[card][type];
        if (expected) {
          const next = decideCard(pending[card], event(type), cardId);
          assert.equal(statusOf(next), expected, `${card} + ${type}`);
          // A produced status is always a status the contract allows for that card.
          assert.ok((CARD_STATUSES[card] as readonly CardStatus[]).includes(next.status), `${card} has no status ${next.status}`);
        } else {
          assert.throws(() => decideCard(pending[card], event(type), cardId), IllegalCardMoveError, `${card} should reject ${type}`);
        }
      }
    });
  }

  test('an illegal event throws before anything is written: the body is untouched', () => {
    for (const card of Object.keys(pending) as CardKind[]) {
      const before = structuredClone(pending[card]);
      for (const type of ALL_EVENTS) {
        if (LEGAL[card][type]) continue;
        assert.throws(() => decideCard(pending[card], event(type), cardId), IllegalCardMoveError);
        assert.deepEqual(pending[card], before, `${card} was mutated by a rejected ${type}`);
      }
    }
  });

  test('the error names the card, its status and the event', () => {
    const err = (() => {
      try {
        decideCard(approval, event('dismiss'), cardId);
      } catch (e) {
        return e as IllegalCardMoveError;
      }
      throw new Error('expected a throw');
    })();
    assert.ok(err instanceof IllegalCardMoveError);
    assert.equal(err.card, 'approval');
    assert.equal(err.status, 'pending');
    assert.equal(err.eventType, 'dismiss');
    assert.match(err.message, /approval card in status 'pending'/);
    assert.match(err.message, /dismiss/);
  });
});

describe('decideCard — decided cards', () => {
  test('a terminal card rejects every event', () => {
    for (const card of Object.keys(pending) as CardKind[]) {
      for (const status of TERMINAL[card]) {
        for (const type of ALL_EVENTS) {
          assert.throws(
            () => decideCard(terminalBody(card, status), event(type), cardId),
            IllegalCardMoveError,
            `${status} ${card} accepted ${type}`,
          );
        }
      }
    }
  });

  test('"always" is the allow-always status, not "approved"', () => {
    const next = decideCard(approval, { type: 'approve', userId, at, always: true }, cardId);
    assert.equal(next.status, 'always');
    assert.equal(next.card, 'approval');
  });
});

describe('decideCard — the rebuilt body', () => {
  test('a dismissed draft is "discarded" (a real draft status) and keeps all of its content', () => {
    const next = decideCard(draft, event('dismiss'), cardId) as Extract<CardBody, { card: 'draft' }>;
    assert.equal(next.status, 'discarded');
    assert.equal(next.type, 'card');
    assert.equal(next.card, 'draft');
    assert.equal(next.channel, 'email');
    assert.equal(next.to, 'alex@example.com');
    assert.equal(next.subject, 'Seat cap');
    assert.equal(next.text, 'Any plans to support more seats?');
    assert.equal(next.approvalId, 'apr_2');
  });

  test('an answered question keeps its question and options, and gains the answer', () => {
    const next = decideCard(question, { type: 'answer', userId, at, answer: 'Personal' }, cardId) as Extract<CardBody, { card: 'question' }>;
    assert.equal(next.status, 'answered');
    assert.equal(next.question, 'Which inbox should I watch?');
    assert.deepEqual(next.options, ['Work', 'Personal']);
    assert.equal(next.answer, 'Personal');
  });

  test('answering does not leak an answer onto any other card kind', () => {
    // 'answer' is illegal everywhere else, so the only road to an answer field is a question.
    for (const card of ['approval', 'connect', 'draft'] as CardKind[]) {
      assert.throws(() => decideCard(pending[card], event('answer'), cardId), IllegalCardMoveError);
    }
  });

  test('approval, connect and question decisions keep their own fields', () => {
    const allowed = decideCard(approval, event('approve'), cardId) as Extract<CardBody, { card: 'approval' }>;
    assert.deepEqual(
      { status: allowed.status, title: allowed.title, tool: allowed.tool, toolkit: allowed.toolkit, detail: allowed.detail, args: allowed.args },
      { status: 'allowed', title: approval.card === 'approval' ? approval.title : '', tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', detail: approval.card === 'approval' ? approval.detail : '', args: { to: 'alex@example.com' } },
    );

    const connected = decideCard(connect, event('connect'), cardId) as Extract<CardBody, { card: 'connect' }>;
    assert.equal(connected.status, 'connected');
    assert.equal(connected.toolkitName, 'Slack');
    assert.equal(connected.logo, 'https://logo.example/slack.png');

    const skipped = decideCard(connect, event('skip'), cardId) as Extract<CardBody, { card: 'connect' }>;
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'I need Slack to post the digest.');
  });

  test('the input body is not mutated by a legal move', () => {
    const before = structuredClone(approval);
    decideCard(approval, event('expire'), cardId);
    assert.deepEqual(approval, before);
  });
});

describe('cardStateOf', () => {
  test('a pending card carries the fields the machine needs, per kind', () => {
    assert.deepEqual(cardStateOf(approval, '7'), {
      status: 'pending', card: 'approval', cardId: '7', approvalId: 'apr_1', title: 'Allow Quinn to send an email?',
      tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', toolkitName: 'Gmail', logo: 'https://logo.example/gmail.png',
      args: { to: 'alex@example.com' },
    });
    assert.deepEqual(cardStateOf(question, '7'), { status: 'pending', card: 'question', cardId: '7', question: 'Which inbox should I watch?', options: ['Work', 'Personal'] });
    assert.deepEqual(cardStateOf(connect, '7'), { status: 'pending', card: 'connect', cardId: '7', toolkit: 'slack', toolkitName: 'Slack', logo: 'https://logo.example/slack.png', reason: 'I need Slack to post the digest.' });
    assert.equal(cardStateOf(draft, '7').status, 'pending');
  });

  test('a decided card is read back as its real terminal status', () => {
    for (const card of Object.keys(pending) as CardKind[]) {
      for (const status of TERMINAL[card]) {
        const state = cardStateOf(terminalBody(card, status), cardId);
        assert.equal(state.status, status);
        assert.equal(state.card, card);
      }
    }
    const answered = cardStateOf({ ...question, status: 'answered', answer: 'Work' } as CardBody, cardId);
    assert.equal(answered.status, 'answered');
    assert.equal((answered as Extract<typeof answered, { status: 'answered' }>).answer, 'Work');
  });

  test('an unknown card kind throws', () => {
    const bogus = { type: 'card', card: 'invoice', status: 'pending' } as unknown as CardBody;
    assert.throws(() => cardStateOf(bogus, cardId), UnknownCardError);
  });

  test('an unknown status on a known card throws', () => {
    const bogus = { ...approval, status: 'maybe' } as unknown as CardBody;
    assert.throws(() => cardStateOf(bogus, cardId), UnknownCardError);
  });
});
