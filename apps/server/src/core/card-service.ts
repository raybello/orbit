import type { CardBody } from '@orbit/contracts';
import { type CardEvent, type CardState, transitionCard } from '../domain/card-workflow.js';

/**
 * The seam between a persisted card row and the pure card machine.
 *
 * `CardBody` (packages/contracts) is the wire shape: it keeps every card-specific field at every
 * status. `CardState` (domain/card-workflow) is the machine: a decided card deliberately drops the
 * content, which is why the terminal variants only carry `cardId`, `decidedAt` and `decidedBy`.
 *
 * So this adapter does two jobs:
 *  - `cardStateOf` derives a CardState from a stored body, so legality can be asked of a real row;
 *  - `decideCard` runs the transition and rebuilds the row by spreading the original body and
 *    applying only the new status (plus the answer, or whether a secure form was kept, when the new
 *    state carries one). Nothing the card said is lost, and no field is invented.
 *
 * It also fixes one real bug: routes.ts wrote `dismissed` on every non-connect card it dismissed,
 * which is not a legal draft status. A dismissed draft is `discarded` here; the UI treats any
 * non-pending card as done, so nothing changes for the user.
 */

type ApprovalBody = Extract<CardBody, { card: 'approval' }>;
type QuestionBody = Extract<CardBody, { card: 'question' }>;
type ConnectBody = Extract<CardBody, { card: 'connect' }>;
type DraftBody = Extract<CardBody, { card: 'draft' }>;
type SecureFormBody = Extract<CardBody, { card: 'secure-form' }>;

/**
 * A decided card's timestamps and author are not part of CardBody, so a state derived from a stored
 * row cannot know them. They are placeholders for legality questions only — decideCard never writes
 * them back, because the rebuilt body is the stored body with a new status.
 */
const DECIDED_AT_UNKNOWN = 0;
const DECIDED_BY_UNKNOWN = '';

/** An event the card, or its current status, does not allow. Nothing has been written when this is thrown. */
export class IllegalCardMoveError extends Error {
  readonly card: string;
  readonly status: string;
  readonly eventType: string;

  constructor(card: string, status: string, eventType: string) {
    super(`${card} card in status '${status}' does not allow '${eventType}'`);
    this.name = 'IllegalCardMoveError';
    this.card = card;
    this.status = status;
    this.eventType = eventType;
  }
}

/** A body whose `card` is not a kind this module knows (a corrupted row, or a new kind it predates). */
export class UnknownCardError extends Error {
  readonly card: unknown;

  constructor(card: unknown) {
    super(`unknown card kind: ${String(card)}`);
    this.name = 'UnknownCardError';
    this.card = card;
  }
}

/**
 * Read a stored card as machine state. Pending cards carry their content; decided cards carry only
 * their status, which is all legality needs. Throws UnknownCardError for a card kind the machine does
 * not know.
 */
export function cardStateOf(body: CardBody, cardId: string): CardState {
  switch (body.card) {
    case 'approval': {
      const content = {
        card: 'approval' as const,
        cardId,
        approvalId: body.approvalId,
        title: body.title,
        tool: body.tool,
        toolkit: body.toolkit,
        toolkitName: body.toolkitName,
        logo: body.logo,
        args: body.args,
      };
      switch (body.status) {
        case 'pending':
          return { status: 'pending', ...content };
        case 'allowed':
          return { ...content, status: 'allowed', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        case 'always':
          return { ...content, status: 'always', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        case 'denied':
          return { ...content, status: 'denied', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        case 'expired':
          // Expiry is the server giving up, so it has no deciding user.
          return { status: 'expired', card: 'approval', cardId, decidedAt: DECIDED_AT_UNKNOWN };
        default:
          throw new UnknownCardError(`approval/${(body as { status?: unknown }).status}`);
      }
    }

    case 'question': {
      const content = { card: 'question' as const, cardId, question: body.question, options: body.options };
      switch (body.status) {
        case 'pending':
          return { status: 'pending', ...content };
        case 'answered':
          return { ...content, status: 'answered', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN, answer: body.answer ?? '' };
        case 'dismissed':
          return { ...content, status: 'dismissed', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        default:
          throw new UnknownCardError(`question/${(body as { status?: unknown }).status}`);
      }
    }

    case 'connect': {
      const content = {
        card: 'connect' as const,
        cardId,
        toolkit: body.toolkit,
        toolkitName: body.toolkitName,
        logo: body.logo,
        reason: body.reason,
      };
      switch (body.status) {
        case 'pending':
          return { status: 'pending', ...content };
        case 'connected':
          return { ...content, status: 'connected', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        case 'skipped':
          return { ...content, status: 'skipped', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        default:
          throw new UnknownCardError(`connect/${(body as { status?: unknown }).status}`);
      }
    }

    case 'draft': {
      const content = {
        card: 'draft' as const,
        cardId,
        channel: body.channel,
        to: body.to,
        subject: body.subject,
        text: body.text,
        approvalId: body.approvalId,
      };
      switch (body.status) {
        case 'pending':
          return { status: 'pending', ...content };
        case 'sent':
          return { ...content, status: 'sent', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        case 'discarded':
          return { ...content, status: 'discarded', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        default:
          throw new UnknownCardError(`draft/${(body as { status?: unknown }).status}`);
      }
    }

    case 'secure-form': {
      const content = {
        card: 'secure-form' as const,
        cardId,
        label: body.label,
        reason: body.reason,
        fields: body.fields,
        urlPattern: body.urlPattern,
      };
      switch (body.status) {
        case 'pending':
          return { status: 'pending', ...content };
        case 'submitted':
          return { ...content, status: 'submitted', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN, saved: body.saved ?? false };
        case 'dismissed':
          return { ...content, status: 'dismissed', decidedAt: DECIDED_AT_UNKNOWN, decidedBy: DECIDED_BY_UNKNOWN };
        default:
          throw new UnknownCardError(`secure-form/${(body as { status?: unknown }).status}`);
      }
    }

    default:
      // Only reachable at runtime: CardBody's union has no other member.
      throw new UnknownCardError((body as { card?: unknown }).card);
  }
}

/**
 * Apply `event` to a stored card and return the body to persist.
 *
 * Throws IllegalCardMoveError when the card's kind or current status does not allow the event — and
 * does so before returning, so a rejected call has nothing to write. Terminal cards reject every
 * event; that is the machine's rule, not a route-level check.
 */
export function decideCard(body: CardBody, event: CardEvent, cardId: string): CardBody {
  const state = cardStateOf(body, cardId);
  const next = transitionCard(state, event);
  // transitionCard answers an illegal move with the very state it was given.
  if (next === state) throw new IllegalCardMoveError(body.card, body.status, event.type);

  // The card discriminant cannot change, so the spread stays a CardBody of the same kind; the status
  // is a contract status because the machine only reaches contract statuses.
  if (next.card === 'question' && next.status === 'answered') {
    return { ...(body as QuestionBody), status: 'answered', answer: next.answer };
  }
  if (next.card === 'secure-form' && next.status === 'submitted') {
    return { ...(body as SecureFormBody), status: 'submitted', saved: next.saved };
  }
  const status: CardBody['status'] = next.status;
  return { ...body, status } as CardBody;
}
