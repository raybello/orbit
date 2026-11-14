/**
 * Signing the app in to its own bundled stack.
 *
 * A packaged desktop ships `.env.images.example` with `DEV_LOGIN=0` and no Composio key, so the
 * web app's sign-in screen has nothing that works: the Google button needs a Composio
 * connection, and the dev form is hidden. The server already has an answer for exactly this
 * case — the owner key (`apps/server/src/lib/auth.ts` `isOwnerKey`, and
 * `scripts/sign-in-link.sh` for the shell equivalent): an HMAC of `owner-login` keyed by
 * SESSION_SECRET, minted on the machine that holds that secret. `POST /api/auth/owner` with
 * `{ link: true }` then answers with a one-time URL that sets the session cookie for the
 * stack's origin.
 *
 * This module is the whole of that decision and no more, so it holds no Electron imports: the
 * main process asks it what URL to load, and the tests can drive it against a fake server.
 */

import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { ORBIT_HEADERS } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import { envValue } from './env-file';
import { normalizeServerUrl } from './setup-config';

const log = createLogger({ scope: 'session' });

/** The identity a bundled stack signs in as until the user says otherwise. */
export const DEFAULT_OWNER_EMAIL = 'owner@orbit.local';

export type DesktopSessionStatus = 'existing' | 'signed-in' | 'failed';

export interface EnsureDesktopSessionOptions {
  /** Where the stack answers, e.g. `http://127.0.0.1:8787`. */
  webUrl: string;
  /** The SESSION_SECRET the controller generated for this stack; the owner key derives from it. */
  sessionSecret?: string | null;
  email?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DesktopSessionResult {
  /** `existing` when a session cookie already worked; `signed-in` when a link was minted. */
  status: DesktopSessionStatus;
  /** Always the stack origin, or the one-time link (same origin) the window should load. */
  url: string;
  email: string;
  user?: { id?: string; email?: string; name?: string } | null;
  error?: string;
}

/** The bearer the server's `isOwnerKey` accepts: HMAC-SHA256(SESSION_SECRET, 'owner-login'). */
export function ownerKeyFor(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('owner-login').digest('hex');
}

/** SESSION_SECRET out of a stack `.env`, or null when it is missing/unreadable. */
export function sessionSecretFromEnvFile(envPath: string): string | null {
  try {
    return envValue(fs.readFileSync(envPath, 'utf8'), 'SESSION_SECRET');
  } catch {
    return null;
  }
}

/**
 * The server builds the link from APP_URL, which can be stale when the controller bound a
 * different loopback port than the example file pinned. The path is what carries the one-time
 * token, so keep it and take the origin from the URL we actually reach.
 */
export function linkOnOrigin(link: string, origin: string): string | null {
  try {
    const parsed = new URL(link);
    if (!parsed.pathname) return null;
    return `${origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Make sure the window will load as a signed-in user.
 *
 * Only mints a link when `/api/auth/me` has no session, so a normal launch reuses the cookie
 * already in the window's partition instead of churning a new session (and a new user row)
 * on every start.
 */
export async function ensureDesktopSession(
  options: EnsureDesktopSessionOptions,
): Promise<DesktopSessionResult> {
  const origin = normalizeServerUrl(options.webUrl);
  const email = options.email?.trim() || DEFAULT_OWNER_EMAIL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  if (!origin) {
    return {
      status: 'failed',
      url: String(options.webUrl ?? ''),
      email,
      error: `not an http(s) URL: ${options.webUrl}`,
    };
  }

  try {
    const res = await fetchImpl(`${origin}/api/auth/me`, {
      headers: { [ORBIT_HEADERS.desktop]: '1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { user?: { id?: string; email?: string } | null };
      if (body?.user) {
        log.info(`already signed in as ${body.user.email ?? email}`);
        return { status: 'existing', url: origin, email, user: body.user };
      }
    }
  } catch (err) {
    // An unreachable /api/auth/me is not fatal: the owner endpoint below gives the real answer.
    log.warn('could not read /api/auth/me', err);
  }

  const secret = options.sessionSecret?.trim();
  if (!secret) {
    return {
      status: 'failed',
      url: origin,
      email,
      error: 'the stack has no SESSION_SECRET, so no owner key can be minted',
    };
  }

  try {
    const res = await fetchImpl(`${origin}/api/auth/owner`, {
      method: 'POST',
      headers: {
        [ORBIT_HEADERS.desktop]: '1',
        authorization: `Bearer ${ownerKeyFor(secret)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, link: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      url?: string;
      error?: string;
      user?: { id?: string; email?: string } | null;
    };
    if (!res.ok) {
      return {
        status: 'failed',
        url: origin,
        email,
        error: `POST /api/auth/owner answered HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`,
      };
    }
    const link = typeof body?.url === 'string' ? linkOnOrigin(body.url, origin) : null;
    if (!link) {
      return { status: 'failed', url: origin, email, error: 'POST /api/auth/owner returned no sign-in link' };
    }
    log.info(`minted a one-time sign-in link for ${email}`);
    return { status: 'signed-in', url: link, email, user: body?.user ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', url: origin, email, error: `could not reach ${origin}: ${message}` };
  }
}
