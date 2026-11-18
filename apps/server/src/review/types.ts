import type { ReviewKind, ReviewPayload } from '@orbit/contracts';

/** Shared shapes of the review adapters (see index.ts). */

export interface PreStep { slug: string; args: Record<string, unknown> }

export interface Applied {
  args: Record<string, unknown>;
  before: PreStep[];
  changes: string[];
}

export interface ReviewAdapter {
  kind: ReviewKind;
  slugs: readonly string[];
  build(userId: string, slug: string, args: Record<string, unknown>): Promise<ReviewPayload>;
  apply(slug: string, args: Record<string, unknown>, review: ReviewPayload, edits: unknown): Applied;
}

/** Edits that cannot be applied. The message is shown to the person as is. */
export class ReviewEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewEditError';
  }
}
