import type { ReviewPayload } from '@orbit/contracts';
import { emailReview } from './email.js';
import { eventReview } from './event.js';
import { ReviewEditError, type Applied, type ReviewAdapter } from './types.js';

export { ReviewEditError, type Applied, type PreStep, type ReviewAdapter } from './types.js';

/**
 * Review adapters: for one family of Gmail, Calendar, Sheets or Docs actions, how to show a pending
 * call on its approval card and how to apply the person's edits to it.
 *
 *   build  reads the bot's arguments (and, where the card shows "before", the current state through
 *          Composio) into the card's payload. A failure here is not fatal: the card falls back to
 *          the generic one, which still lets the person allow or deny.
 *   apply  validates the person's edits and returns the arguments that will actually run, any
 *          actions that must run first (sending a draft with edits updates the draft first), and
 *          plain sentences that tell the bot what changed.
 */

const ADAPTERS: ReviewAdapter[] = [emailReview, eventReview];

export const adapterFor = (slug: string): ReviewAdapter | undefined => {
  const s = slug.toUpperCase();
  return ADAPTERS.find((a) => a.slugs.includes(s));
};

/** The card payload for this call, or undefined when it has no custom card or cannot be read. */
export async function buildReview(userId: string, slug: string, args: Record<string, unknown>): Promise<ReviewPayload | undefined> {
  const adapter = adapterFor(slug);
  if (!adapter) return undefined;
  try {
    return await adapter.build(userId, slug.toUpperCase(), args);
  } catch (e) {
    console.warn(`[review] could not build the ${adapter.kind} card for ${slug}:`, (e as Error).message);
    return undefined;
  }
}

/** Check edits when the person answers, before anything is decided. Throws ReviewEditError. */
export function checkReviewEdits(slug: string, review: ReviewPayload | undefined, edits: unknown): void {
  if (edits === undefined || edits === null) return;
  const adapter = adapterFor(slug);
  if (!adapter || !review) throw new ReviewEditError('This action cannot be edited here.');
  if (!review.editable) throw new ReviewEditError('This card is read-only.');
  adapter.validate(review, edits);
}

/** What runs once the person allowed this call with these edits. Throws ReviewEditError when they cannot be applied. */
export async function applyReviewEdits(userId: string, slug: string, args: Record<string, unknown>, review: ReviewPayload | undefined, edits: unknown): Promise<Applied> {
  const unchanged: Applied = { args, before: [], changes: [] };
  const adapter = adapterFor(slug);
  const none = edits === undefined || edits === null;
  if (none && !(adapter?.alwaysApply && review)) return unchanged;
  checkReviewEdits(slug, review, edits);
  return adapter!.apply(userId, slug.toUpperCase(), args, review!, none ? undefined : edits);
}
