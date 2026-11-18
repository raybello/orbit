import crypto from 'node:crypto';
import { db } from './db.js';
import { env } from './env.js';

/**
 * One-time clean-up of the direct Google OAuth integration, which Composio replaced.
 *
 * Older servers stored Google tokens in `google_tokens` (AES-256-GCM under a key derived from
 * SESSION_SECRET) and pending sign-ins in `google_oauth_states`. On start, each stored grant is
 * revoked at Google once, best effort, and both tables are dropped. Dropping happens even when a
 * revoke fails (no network, a token Google already forgot): the server can no longer use the tokens
 * either way, and keeping them on disk is the larger risk. Safe to run on every start: with no
 * tables left it does nothing.
 */

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

interface TokenRow { user_id: string; access_token_enc: string; refresh_token_enc: string }

/** The retired module's sealing: `iv.ciphertext.tag` in hex, keyed by SESSION_SECRET. */
function openLegacy(stored: string): string {
  const [iv, enc, tag] = stored.split('.');
  if (!iv || !enc || !tag) return '';
  const key = crypto.createHash('sha256').update(`google-token-key:${env.sessionSecret}`).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(Buffer.from(enc, 'hex')).toString('utf8') + decipher.final('utf8');
}

const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export interface RetireResult { found: number; revoked: number; failed: number; dropped: boolean }

/** Revoke one stored grant. True when Google confirms it, or says it no longer knows the token. */
async function revokeRow(row: TokenRow, fetchImpl: typeof fetch): Promise<boolean> {
  let token = '';
  try { token = openLegacy(row.refresh_token_enc); } catch { /* fall back to the access token */ }
  if (!token) token = openLegacy(row.access_token_enc);
  if (!token) return false;
  // The token goes in the form body, never the URL, so no proxy or access log records it.
  const res = await fetchImpl(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return true;
  // Already revoked or expired is the goal; any other 400 (a malformed request) is not.
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return body.error === 'invalid_token';
  }
  return false;
}

export async function retireGoogleOAuth(fetchImpl: typeof fetch = fetch): Promise<RetireResult> {
  if (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_SECRET) {
    console.warn('[google-oauth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are no longer used: Gmail and Calendar connect through Composio (COMPOSIO_API_KEY). Remove them from .env.');
  }
  const hasTokens = tableExists('google_tokens');
  const hasStates = tableExists('google_oauth_states');
  if (!hasTokens && !hasStates) return { found: 0, revoked: 0, failed: 0, dropped: false };

  const rows = hasTokens ? (db.prepare('SELECT user_id, access_token_enc, refresh_token_enc FROM google_tokens').all() as TokenRow[]) : [];
  // In parallel, so the sealed tokens leave the disk within one timeout even when Google is unreachable.
  const outcomes = await Promise.allSettled(rows.map((row) => revokeRow(row, fetchImpl)));
  const revoked = outcomes.filter((o) => o.status === 'fulfilled' && o.value).length;
  const failed = rows.length - revoked;
  db.exec('DROP TABLE IF EXISTS google_tokens; DROP TABLE IF EXISTS google_oauth_states;');
  if (rows.length || hasStates) console.log(`[google-oauth] retired: ${revoked} grant(s) revoked, ${failed} could not be revoked, tables dropped`);
  return { found: rows.length, revoked, failed, dropped: true };
}
