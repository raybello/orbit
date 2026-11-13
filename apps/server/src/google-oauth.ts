/**
 * Direct Google OAuth2 integration — no third-party service required.
 *
 * Users create their own Google Cloud project (free) and supply the OAuth2
 * client credentials via GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.  Tokens
 * are stored AES-256-GCM encrypted in the DB; the key is derived from
 * SESSION_SECRET so the tokens are worthless without the server secret.
 *
 * Flow: PKCE + state (prevents CSRF and authorization-code-interception attacks).
 *   1. generateAuthUrl(userId) → { url, state }
 *   2. User consents on Google's page, lands on /api/google/callback?code=…&state=…
 *   3. exchangeCode(state, code) stores encrypted tokens in DB
 *   4. getToken(userId) returns a fresh access token (auto-refreshes when expired)
 */

import crypto from 'node:crypto';
import { db, now } from './db.js';
import { env } from './env.js';

// ---------- helpers ----------

/** Derive a 32-byte AES key from SESSION_SECRET so tokens are unreadable without it. */
function aesKey(): Buffer {
  return crypto.createHash('sha256').update('google-token-key:' + env.sessionSecret).digest();
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${enc.toString('hex')}.${tag.toString('hex')}`;
}

function decrypt(stored: string): string {
  const [ivHex, encHex, tagHex] = stored.split('.');
  if (!ivHex || !encHex || !tagHex) throw new Error('malformed token');
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function codeChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// ---------- DB helpers ----------

export type GoogleTokenRow = {
  user_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: number;
  email: string | null;
  scopes: string | null;
  updated_at: number;
};

function getRow(userId: string): GoogleTokenRow | null {
  return (db.prepare('SELECT * FROM google_tokens WHERE user_id=?').get(userId) as GoogleTokenRow) ?? null;
}

// ---------- public API ----------

/** True when the user has valid Google credentials stored. */
export function hasGoogleAccess(userId: string): boolean {
  return getRow(userId) !== null;
}

/** Returns the email of the connected Google account, or null. */
export function googleEmail(userId: string): string | null {
  return getRow(userId)?.email ?? null;
}

/**
 * Build the Google consent URL.  State + code_verifier are stored in the DB
 * (expire after 10 min); the caller redirects the user's browser to the URL.
 */
export function generateAuthUrl(userId: string, callbackUrl: string): string {
  if (!env.googleClientId) throw new Error('GOOGLE_CLIENT_ID is not set');
  const state = crypto.randomBytes(24).toString('hex');
  const verifier = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR REPLACE INTO google_oauth_states(state, user_id, code_verifier, created_at) VALUES (?,?,?,?)').run(state, userId, verifier, now());

  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/** Exchange the authorization code for tokens and persist them encrypted. */
export async function exchangeCode(state: string, code: string, callbackUrl: string): Promise<void> {
  if (!env.googleClientId || !env.googleClientSecret) throw new Error('Google credentials not configured');
  const stateRow = db.prepare('SELECT * FROM google_oauth_states WHERE state=?').get(state) as any;
  if (!stateRow) throw new Error('Unknown or expired OAuth state');
  db.prepare('DELETE FROM google_oauth_states WHERE state=?').run(state);
  if (stateRow.created_at < now() - 10 * 60_000) throw new Error('OAuth state expired');

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
      code_verifier: stateRow.code_verifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data: any = await res.json();
  if (!data.access_token) throw new Error('Google returned no access_token');

  // Decode id_token to get email (without verifying signature — we trust Google's response over HTTPS).
  let email: string | null = null;
  if (data.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64').toString());
      email = payload.email ?? null;
    } catch { /* ignore */ }
  }

  const expiresAt = now() + (data.expires_in ?? 3600) * 1000 - 60_000;
  db.prepare(`
    INSERT OR REPLACE INTO google_tokens(user_id, access_token_enc, refresh_token_enc, expires_at, email, scopes, updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    stateRow.user_id,
    encrypt(data.access_token),
    data.refresh_token ? encrypt(data.refresh_token) : (getRow(stateRow.user_id)?.refresh_token_enc ?? encrypt('')),
    expiresAt,
    email,
    data.scope ?? null,
    now(),
  );
}

/** Returns a valid access token, refreshing if needed.  Throws if not connected. */
export async function getToken(userId: string): Promise<string> {
  const row = getRow(userId);
  if (!row) throw new Error('Google account not connected. Ask the user to connect Google in the app settings.');

  if (row.expires_at > now()) {
    return decrypt(row.access_token_enc);
  }

  // Refresh
  const refreshToken = decrypt(row.refresh_token_enc);
  if (!refreshToken) throw new Error('No refresh token available; the user must reconnect Google.');
  if (!env.googleClientId || !env.googleClientSecret) throw new Error('Google credentials not configured');

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401) {
      // Refresh token revoked; clear the stored credentials
      db.prepare('DELETE FROM google_tokens WHERE user_id=?').run(userId);
    }
    throw new Error(`Google token refresh failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data: any = await res.json();
  if (!data.access_token) throw new Error('Google token refresh returned no access_token');

  const expiresAt = now() + (data.expires_in ?? 3600) * 1000 - 60_000;
  db.prepare('UPDATE google_tokens SET access_token_enc=?, expires_at=?, updated_at=? WHERE user_id=?')
    .run(encrypt(data.access_token), expiresAt, now(), userId);

  return data.access_token;
}

/** Call a Google API endpoint with automatic token refresh. */
export async function googleFetch(userId: string, path: string, options: RequestInit = {}): Promise<any> {
  const token = await getToken(userId);
  const baseUrl = path.startsWith('http') ? path : `https://www.googleapis.com${path}`;
  const res = await fetch(baseUrl, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google API error ${res.status}: ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

/** Revoke and remove the user's Google tokens. */
export async function revokeGoogle(userId: string): Promise<void> {
  const row = getRow(userId);
  if (!row) return;
  try {
    const token = decrypt(row.refresh_token_enc) || decrypt(row.access_token_enc);
    if (token) {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    }
  } catch { /* best-effort revoke */ }
  db.prepare('DELETE FROM google_tokens WHERE user_id=?').run(userId);
}
