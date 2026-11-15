/**
 * Cards are the points where a bot stops and asks a person something. The shapes here mirror the real
 * `CardBody` union in packages/contracts/src/index.ts and the statuses the server actually writes
 * (agent/loop.ts for approvals and expiry, routes.ts for answers and dismissals).
 *
 * Two things worth knowing before reading the table:
 *
 *  - An approval ends in `allowed` or `always` (the "allow always" decision), not `approved`.
 *  - A draft ends in `sent` or `discarded`, not `dismissed`. routes.ts stores `dismissed` on every
 *    non-connect card it dismisses, which is not a legal draft status in the contract; this module
 *    maps dismissing a draft to `discarded` so the state it produces is always a real CardBody status.
 *
 * Every card-specific status set lives in CARD_STATUSES, and every legal move lives in LEGAL_EVENTS.
 * transitionCard is written per card — so the compiler sees exactly which statuses each card can
 * reach — and a test pins it to LEGAL_EVENTS, so the two cannot drift.
 */

export type CardKind = 'approval' | 'question' | 'connect' | 'draft';

export type CardStatus =
  | 'pending'
  // approval
  | 'allowed'
  | 'always'
  | 'denied'
  | 'expired'
  // question
  | 'answered'
  | 'dismissed'
  // connect
  | 'connected'
  | 'skipped'
  // draft
  | 'sent'
  | 'discarded';

/** The statuses each card really has. This is the one place the per-card sets are written down. */
export const CARD_STATUSES = {
  approval: ['pending', 'allowed', 'always', 'denied', 'expired'],
  question: ['pending', 'answered', 'dismissed'],
  connect: ['pending', 'connected', 'skipped'],
  draft: ['pending', 'sent', 'discarded'],
} as const satisfies Record<CardKind, readonly CardStatus[]>;

/** Both question and draft can be dismissed; the event type is shared, the result is not. */
const LEGAL_EVENTS: Record<CardKind, readonly CardEvent['type'][]> = {
  approval: ['approve', 'deny', 'expire'],
  question: ['answer', 'dismiss'],
  connect: ['connect', 'skip'],
  draft: ['send', 'dismiss'],
};

export type CardEvent =
  /** `always` is the UI's "always allow" decision, which the loop stores as its own status. */
  | { type: 'approve'; userId: string; at: number; always?: boolean }
  | { type: 'deny'; userId: string; at: number; reason?: string }
  | { type: 'answer'; userId: string; at: number; answer: string }
  | { type: 'dismiss'; userId: string; at: number }
  | { type: 'connect'; userId: string; at: number }
  | { type: 'skip'; userId: string; at: number }
  | { type: 'send'; userId: string; at: number }
  /** Expiry is the server giving up waiting for a person, so it has no user. */
  | { type: 'expire'; at: number };

interface PendingCard {
  status: 'pending';
  cardId: string;
}

/** Fields carried by a decided card, whichever card it was. */
interface DecidedCard {
  cardId: string;
  decidedAt: number;
  decidedBy: string;
}

export type CardState =
  | (PendingCard & {
      card: 'approval';
      approvalId: string;
      title: string;
      tool: string;
      toolkit?: string;
      toolkitName?: string;
      logo?: string;
      args: unknown;
    })
  | (PendingCard & {
      card: 'question';
      question: string;
      options: string[];
    })
  | (PendingCard & {
      card: 'connect';
      toolkit: string;
      toolkitName: string;
      logo?: string;
      reason: string;
    })
  | (PendingCard & {
      card: 'draft';
      channel: 'email' | 'slack' | 'message';
      to: string;
      subject?: string;
      text: string;
      approvalId: string;
    })
  | (DecidedCard & { status: 'allowed'; card: 'approval' })
  | (DecidedCard & { status: 'always'; card: 'approval' })
  | (DecidedCard & { status: 'denied'; card: 'approval'; reason?: string })
  | { status: 'expired'; card: 'approval'; cardId: string; decidedAt: number }
  | (DecidedCard & { status: 'answered'; card: 'question'; answer: string })
  | (DecidedCard & { status: 'dismissed'; card: 'question' })
  | (DecidedCard & { status: 'connected'; card: 'connect' })
  | (DecidedCard & { status: 'skipped'; card: 'connect' })
  | (DecidedCard & { status: 'sent'; card: 'draft' })
  | (DecidedCard & { status: 'discarded'; card: 'draft' });

export function isTerminal(state: CardState): state is Exclude<CardState, { status: 'pending' }> {
  return state.status !== 'pending';
}

/**
 * What a UI may offer for this state. Takes the state rather than a bare status because `pending` is
 * shared by all four cards and the legal set depends on the card; every terminal status is card-specific.
 * transitionCard is pinned to this table by a test, so the offer and the machine cannot drift.
 */
export function legalEvents(state: Pick<CardState, 'card' | 'status'>): CardEvent['type'][] {
  if (state.status !== 'pending') return [];
  return [...LEGAL_EVENTS[state.card]];
}

/** Terminal states never move; illegal moves from pending are also a no-op (same object returned). */
export function transitionCard(state: CardState, event: CardEvent): CardState {
  if (state.status !== 'pending') return state;

  // Switched by card first so the compiler knows exactly which statuses this card can reach.
  switch (state.card) {
    case 'approval': {
      const base = { card: 'approval', cardId: state.cardId, decidedAt: event.at } as const;
      switch (event.type) {
        case 'approve':
          return event.always
            ? { ...base, status: 'always', decidedBy: event.userId }
            : { ...base, status: 'allowed', decidedBy: event.userId };
        case 'deny':
          return event.reason
            ? { ...base, status: 'denied', decidedBy: event.userId, reason: event.reason }
            : { ...base, status: 'denied', decidedBy: event.userId };
        case 'expire':
          return { ...base, status: 'expired' };
        default:
          return state;
      }
    }
    case 'question': {
      const base = { card: 'question', cardId: state.cardId, decidedAt: event.at } as const;
      switch (event.type) {
        case 'answer':
          return { ...base, status: 'answered', decidedBy: event.userId, answer: event.answer };
        case 'dismiss':
          return { ...base, status: 'dismissed', decidedBy: event.userId };
        default:
          return state;
      }
    }
    case 'connect': {
      const base = { card: 'connect', cardId: state.cardId, decidedAt: event.at } as const;
      switch (event.type) {
        case 'connect':
          return { ...base, status: 'connected', decidedBy: event.userId };
        case 'skip':
          return { ...base, status: 'skipped', decidedBy: event.userId };
        default:
          return state;
      }
    }
    case 'draft': {
      const base = { card: 'draft', cardId: state.cardId, decidedAt: event.at } as const;
      switch (event.type) {
        case 'send':
          return { ...base, status: 'sent', decidedBy: event.userId };
        case 'dismiss':
          // routes.ts stores 'dismissed' for non-connect cards; on a draft the contract's status is 'discarded'.
          return { ...base, status: 'discarded', decidedBy: event.userId };
        default:
          return state;
      }
    }
  }
}
