import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { BotAdminError } from '../bot-admin.js';
import { CalendarActionError } from '../calendar/actions.js';
import { IllegalCardMoveError } from '../core/card-service.js';
import { TeamFullError } from '../core/bot-service.js';
import { DraftActionError } from '../review/drafts.js';
import { ReviewEditError } from '../review/types.js';

/** A failure the person can act on: the status it answers with and the message they see. */
export class ApiError extends Error {
  constructor(readonly status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type Mapping = [new (...args: never[]) => Error, (e: never) => ContentfulStatusCode];

/** Domain errors whose message is written for the person, with the status each answers with. */
const MAPPED: Mapping[] = [
  [ApiError, (e: ApiError) => e.status],
  [BotAdminError, (e: BotAdminError) => e.status],
  [CalendarActionError, (e: CalendarActionError) => e.status],
  [DraftActionError, (e: DraftActionError) => e.status],
  [TeamFullError, () => 409],
  [ReviewEditError, () => 400],
  [IllegalCardMoveError, () => 400],
];

/** The status and message for an error the person may see, or null for a bug (answered as a hidden 500). */
export function userFailure(e: unknown): { status: ContentfulStatusCode; message: string } | null {
  for (const [type, status] of MAPPED) if (e instanceof type) return { status: status(e as never), message: e.message };
  return null;
}
