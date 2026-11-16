import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CARD_STATUSES,
  isTerminal,
  legalEvents,
  transitionCard,
  type CardEvent,
  type CardKind,
  type CardState,
  type CardStatus,
} from '../domain/card-workflow.js';

/**
 * Cards are tested per card kind, plus a cross-product pass proving that the only events a pending
 * card accepts are the ones its table offers and that a decided card never moves again.
 */

const userId = 'usr_1';
const at = 1_700_000_000_000;

const approvalPending: CardState = {
  status: 'pending',
  card: 'approval',
  cardId: 'card_ap',
  approvalId: 'ap_1',
  title: 'Allow Quinn to send an email?',
  tool: 'GMAIL_SEND_EMAIL',
  toolkit: 'gmail',
  toolkitName: 'Gmail',
  args: { to: 'alex@example.com' },
};
const questionPending: CardState = {
  status: 'pending',
  card: 'question',
  cardId: 'card_q',
  question: 'Which inbox should I watch?',
  options: ['Work', 'Personal'],
};
const connectPending: CardState = {
  status: 'pending',
  card: 'connect',
  cardId: 'card_cn',
  toolkit: 'slack',
  toolkitName: 'Slack',
  reason: 'I need Slack to post the digest.',
};
const draftPending: CardState = {
  status: 'pending',
  card: 'draft',
  cardId: 'card_dr',
  channel: 'email',
  to: 'alex@example.com',
  subject: 'Seat cap',
  text: 'Any plans to support more seats?',
  approvalId: 'ap_2',
};

const secureFormPending: CardState = {
  status: 'pending',
  card: 'secure-form',
  cardId: 'card_sf',
  label: 'AWS Console',
  reason: 'I need to sign in to read the bill.',
  fields: [{ key: 'username', label: 'Username' }, { key: 'secret', label: 'Password' }],
};

const pendingCards: CardState[] = [approvalPending, questionPending, connectPending, draftPending, secureFormPending];

const allEvents: CardEvent[] = [
  { type: 'approve', userId, at },
  { type: 'approve', userId, at, always: true },
  { type: 'deny', userId, at },
  { type: 'deny', userId, at, reason: 'Too risky' },
  { type: 'answer', userId, at, answer: 'Work' },
  { type: 'dismiss', userId, at },
  { type: 'connect', userId, at },
  { type: 'skip', userId, at },
  { type: 'send', userId, at },
  { type: 'submit', userId, at, saved: true },
  { type: 'submit', userId, at, saved: false },
  { type: 'expire', at },
];

const terminals: CardState[] = [
  { status: 'allowed', card: 'approval', cardId: 'card_ap', decidedAt: at, decidedBy: userId },
  { status: 'always', card: 'approval', cardId: 'card_ap', decidedAt: at, decidedBy: userId },
  { status: 'denied', card: 'approval', cardId: 'card_ap', decidedAt: at, decidedBy: userId },
  { status: 'denied', card: 'approval', cardId: 'card_ap', decidedAt: at, decidedBy: userId, reason: 'No' },
  { status: 'expired', card: 'approval', cardId: 'card_ap', decidedAt: at },
  { status: 'answered', card: 'question', cardId: 'card_q', decidedAt: at, decidedBy: userId, answer: 'Work' },
  { status: 'dismissed', card: 'question', cardId: 'card_q', decidedAt: at, decidedBy: userId },
  { status: 'connected', card: 'connect', cardId: 'card_cn', decidedAt: at, decidedBy: userId },
  { status: 'skipped', card: 'connect', cardId: 'card_cn', decidedAt: at, decidedBy: userId },
  { status: 'sent', card: 'draft', cardId: 'card_dr', decidedAt: at, decidedBy: userId },
  { status: 'discarded', card: 'draft', cardId: 'card_dr', decidedAt: at, decidedBy: userId },
  { status: 'submitted', card: 'secure-form', cardId: 'card_sf', decidedAt: at, decidedBy: userId, saved: true },
  { status: 'dismissed', card: 'secure-form', cardId: 'card_sf', decidedAt: at, decidedBy: userId },
];

function expectStatus<S extends CardStatus>(state: CardState, status: S): Extract<CardState, { status: S }> {
  if (state.status !== status) assert.fail(`expected ${status}, got ${state.status}`);
  return state as Extract<CardState, { status: S }>;
}

describe('card workflow: each card has its own decisions', () => {
  test('approving an approval allows it and records who decided and when', () => {
    const next = expectStatus(transitionCard(approvalPending, { type: 'approve', userId, at }), 'allowed');
    assert.equal(next.card, 'approval');
    assert.equal(next.cardId, 'card_ap');
    assert.equal(next.decidedAt, at);
    assert.equal(next.decidedBy, userId);
    assert.equal(isTerminal(next), true);
  });

  test('"always allow" is its own status, not a flag hidden in allowed', () => {
    const next = expectStatus(transitionCard(approvalPending, { type: 'approve', userId, at, always: true }), 'always');
    assert.equal(next.card, 'approval');
    assert.equal(next.decidedAt, at);
  });

  test('denying carries the reason when the UI gives one', () => {
    const withReason = expectStatus(transitionCard(approvalPending, { type: 'deny', userId, at, reason: 'Too risky' }), 'denied');
    assert.equal(withReason.reason, 'Too risky');
    const without = expectStatus(transitionCard(approvalPending, { type: 'deny', userId, at }), 'denied');
    assert.equal('reason' in without, false);
  });

  test('an approval can expire without a person deciding it', () => {
    const next = expectStatus(transitionCard(approvalPending, { type: 'expire', at }), 'expired');
    assert.equal(next.decidedAt, at);
    assert.equal('decidedBy' in next, false);
    assert.equal(next.cardId, 'card_ap');
  });

  test('a question is answered with its answer, or dismissed', () => {
    const answered = expectStatus(transitionCard(questionPending, { type: 'answer', userId, at, answer: 'Work' }), 'answered');
    assert.equal(answered.answer, 'Work');
    assert.equal(answered.decidedBy, userId);
    assert.equal(answered.card, 'question');

    const dismissed = expectStatus(transitionCard(questionPending, { type: 'dismiss', userId, at }), 'dismissed');
    assert.equal(dismissed.cardId, 'card_q');
    assert.equal(dismissed.decidedBy, userId);
  });

  test('a connect card connects or is skipped', () => {
    const connected = expectStatus(transitionCard(connectPending, { type: 'connect', userId, at }), 'connected');
    assert.equal(connected.cardId, 'card_cn');
    const skipped = expectStatus(transitionCard(connectPending, { type: 'skip', userId, at }), 'skipped');
    assert.equal(skipped.decidedAt, at);
  });

  test('a draft sends or is discarded — discarded, because that is the draft status the contract has', () => {
    const sent = expectStatus(transitionCard(draftPending, { type: 'send', userId, at }), 'sent');
    assert.equal(sent.cardId, 'card_dr');
    const discarded = expectStatus(transitionCard(draftPending, { type: 'dismiss', userId, at }), 'discarded');
    assert.equal(discarded.card, 'draft');
  });

  test('a secure form is submitted, kept or not, or dismissed, and never carries what was typed', () => {
    const kept = expectStatus(transitionCard(secureFormPending, { type: 'submit', userId, at, saved: true }), 'submitted');
    assert.deepEqual(kept, { status: 'submitted', card: 'secure-form', cardId: 'card_sf', decidedAt: at, decidedBy: userId, saved: true });
    const once = expectStatus(transitionCard(secureFormPending, { type: 'submit', userId, at, saved: false }), 'submitted');
    assert.equal(once.saved, false);
    const dismissed = expectStatus(transitionCard(secureFormPending, { type: 'dismiss', userId, at }), 'dismissed');
    assert.equal(dismissed.card, 'secure-form');
  });

  test('decisions stamp the event time and user, never a local clock', () => {
    for (const state of pendingCards) {
      for (const event of allEvents) {
        const next = transitionCard(state, event);
        if (isTerminal(next)) {
          assert.equal(next.decidedAt, event.at, `${state.card} + ${event.type} kept the wrong timestamp`);
          if (event.type !== 'expire') {
            assert.ok('decidedBy' in next, `${state.card} + ${event.type} lost the deciding user`);
            assert.equal(next.decidedBy, event.userId, `${state.card} + ${event.type} kept the wrong user`);
          }
        }
      }
    }
  });
});

describe('card workflow: illegal moves cannot produce a wrong status', () => {
  test('a question card can never become approved', () => {
    for (const event of allEvents.filter((e) => e.type === 'approve' || e.type === 'deny' || e.type === 'expire')) {
      assert.equal(transitionCard(questionPending, event), questionPending);
    }
  });

  test('an approval card can never become answered, connected, skipped, sent or discarded', () => {
    for (const event of allEvents.filter((e) => ['answer', 'connect', 'skip', 'send', 'dismiss'].includes(e.type))) {
      assert.equal(transitionCard(approvalPending, event), approvalPending);
    }
  });

  test('a connect card cannot be sent or answered, and a draft cannot be connected', () => {
    assert.equal(transitionCard(connectPending, { type: 'send', userId, at }), connectPending);
    assert.equal(transitionCard(connectPending, { type: 'answer', userId, at, answer: 'x' }), connectPending);
    assert.equal(transitionCard(draftPending, { type: 'connect', userId, at }), draftPending);
  });

  test('a pending card accepts exactly the events legalEvents offers for it', () => {
    for (const state of pendingCards) {
      const offered = legalEvents(state);
      for (const event of allEvents) {
        const moved = transitionCard(state, event) !== state;
        assert.equal(moved, offered.includes(event.type), `${state.card} + ${event.type}`);
      }
    }
  });

  test('every terminal state ignores every event', () => {
    for (const state of terminals) {
      for (const event of allEvents) {
        assert.equal(transitionCard(state, event), state, `${state.status} moved on ${event.type}`);
      }
    }
  });
});

describe('card workflow: the status table is the contract', () => {
  test('CARD_STATUSES matches the real CardBody statuses', () => {
    assert.deepEqual(CARD_STATUSES, {
      approval: ['pending', 'allowed', 'always', 'denied', 'expired'],
      question: ['pending', 'answered', 'dismissed'],
      connect: ['pending', 'connected', 'skipped'],
      draft: ['pending', 'sent', 'discarded'],
      'secure-form': ['pending', 'submitted', 'dismissed'],
    });
  });

  test('every legal event produces a status its card really has', () => {
    for (const state of pendingCards) {
      for (const type of legalEvents(state)) {
        const event = allEvents.find((e) => e.type === type && (e.type !== 'approve' || e.always !== true));
        assert.ok(event, `no sample event for ${type}`);
        const next = transitionCard(state, event);
        assert.notEqual(next, state, `${state.card} did not move on ${type}`);
        assert.ok(
          (CARD_STATUSES[state.card] as readonly CardStatus[]).includes(next.status),
          `${state.card} produced ${next.status}`,
        );
      }
    }
  });

  test('every status a card is allowed to end in is reachable, and nothing else is', () => {
    for (const card of Object.keys(CARD_STATUSES) as CardKind[]) {
      const state = pendingCards.find((s) => s.card === card);
      assert.ok(state);
      const produced = new Set<CardStatus>();
      for (const event of allEvents) {
        const next = transitionCard(state, event);
        if (isTerminal(next)) produced.add(next.status);
      }
      const expected = (CARD_STATUSES[card] as readonly CardStatus[]).filter((s) => s !== 'pending');
      assert.deepEqual([...produced].sort(), [...expected].sort(), card);
    }
  });

  test('legalEvents is empty once a card is decided', () => {
    for (const state of terminals) assert.deepEqual(legalEvents(state), []);
  });

  test('legalEvents names a card\'s own moves while pending', () => {
    assert.deepEqual(legalEvents(approvalPending), ['approve', 'deny', 'expire']);
    assert.deepEqual(legalEvents(questionPending), ['answer', 'dismiss']);
    assert.deepEqual(legalEvents(connectPending), ['connect', 'skip']);
    assert.deepEqual(legalEvents(draftPending), ['send', 'dismiss']);
    assert.deepEqual(legalEvents(secureFormPending), ['submit', 'dismiss']);
  });

  test('isTerminal is true exactly for decided cards', () => {
    for (const state of pendingCards) assert.equal(isTerminal(state), false);
    for (const state of terminals) assert.equal(isTerminal(state), true);
  });

  test('transitions are pure: the same input yields equal output and never mutates the card', () => {
    const before = structuredClone(questionPending);
    const first = transitionCard(questionPending, { type: 'answer', userId, at, answer: 'Work' });
    const second = transitionCard(questionPending, { type: 'answer', userId, at, answer: 'Work' });
    assert.deepEqual(first, second);
    assert.deepEqual(questionPending, before);
  });
});
