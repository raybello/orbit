import type { ReviewKind } from '@orbit/contracts';
import { GOOGLE_ACTIONS } from '../domain/google-actions.js';

/** Which review card each action that asks first gets, read from the catalogue's `card:` field. */
const INDEX: ReadonlyMap<string, ReviewKind> = new Map(
  [...GOOGLE_ACTIONS.values()].flatMap((a) => (a.kind === 'review' && a.card ? [[a.slug, a.card] as const] : [])),
);

export const reviewKindOf = (slug: string): ReviewKind | undefined => INDEX.get(slug.toUpperCase());

export const reviewSlugs = (kind: ReviewKind): string[] => [...INDEX].filter(([, k]) => k === kind).map(([s]) => s);
