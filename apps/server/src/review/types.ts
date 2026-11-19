import type { ReviewKind, ReviewPayload } from '@orbit/contracts';

/** Shared shapes of the review adapters (see index.ts). */

export interface PreStep { slug: string; args: Record<string, unknown> }

export interface Applied {
  /** Run as this action instead of the one the bot named (a bot's GOOGLECALENDAR_UPDATE_EVENT runs as PATCH_EVENT). */
  slug?: string;
  args: Record<string, unknown>;
  /** Actions that must succeed first. */
  before: PreStep[];
  /** Actions that undo `before` if the action itself fails. */
  rollback?: PreStep[];
  /** Sentences that tell the bot what the person changed. */
  changes: string[];
}

export interface ReviewAdapter {
  kind: ReviewKind;
  /** Apply even when the person made no edits (the adapter rewrites some calls on its own). */
  alwaysApply?: boolean;
  build(userId: string, slug: string, args: Record<string, unknown>): Promise<ReviewPayload>;
  /** Throws ReviewEditError when these edits cannot be applied. Runs when the person answers. */
  validate(review: ReviewPayload, edits: unknown): void;
  apply(userId: string, slug: string, args: Record<string, unknown>, review: ReviewPayload, edits: unknown): Promise<Applied>;
}

/** Edits that cannot be applied. The message is shown to the person as is. */
export class ReviewEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewEditError';
  }
}
