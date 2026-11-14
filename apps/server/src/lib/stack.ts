import crypto from 'node:crypto';
import { env } from '../env.js';

/**
 * The shared secret a desktop app's local stack controller writes into its stack `.env` as
 * STACK_TOKEN. Sending it back in `x-orbit-stack-token` is the only proof that a caller is *that*
 * stack's controller, so compare in constant time and never let an unset secret match anything.
 */
export function stackTokenMatches(given: string | undefined | null): boolean {
  if (!env.stackToken || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.stackToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
