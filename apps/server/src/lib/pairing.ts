import crypto from 'node:crypto';
import type { PairCodeResponse } from '@orbit/contracts';

export const PAIR_CODE_TTL_MS = 5 * 60_000;
/** Wrong codes allowed per minute, across all callers: the phone listener's peers all arrive as loopback. */
export const PAIR_FAILURES_PER_MINUTE = 20;

export type PairRedeem = { ok: true; userId: string } | { ok: false; reason: 'invalid' | 'rate-limited' };

const digest = (code: string) => crypto.createHash('sha256').update(code).digest();

/**
 * Pairing codes for "Connect your phone": one live code per person, kept in memory (a restart drops
 * them, and the QR mints a fresh one). A code is 192 random bits, single use, and expires after
 * PAIR_CODE_TTL_MS. Only its SHA-256 is kept, and redeeming compares every live digest in constant time.
 */
export function createPairing(clock: () => number = Date.now) {
  const live = new Map<string, { digest: Buffer; expires: number }>();
  let failures: number[] = [];

  return {
    mint(userId: string): PairCodeResponse {
      const code = crypto.randomBytes(24).toString('base64url');
      const expiresAt = clock() + PAIR_CODE_TTL_MS;
      live.set(userId, { digest: digest(code), expires: expiresAt });
      return { code, expiresAt };
    },

    redeem(code: string): PairRedeem {
      const now = clock();
      failures = failures.filter((at) => now - at < 60_000);
      if (failures.length >= PAIR_FAILURES_PER_MINUTE) return { ok: false, reason: 'rate-limited' };
      const given = digest(code);
      let match: string | null = null;
      for (const [userId, entry] of live) {
        if (crypto.timingSafeEqual(given, entry.digest) && entry.expires > now) match = userId;
      }
      if (!match) {
        failures.push(now);
        return { ok: false, reason: 'invalid' };
      }
      live.delete(match);
      return { ok: true, userId: match };
    },
  };
}
