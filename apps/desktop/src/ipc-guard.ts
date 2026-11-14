/**
 * Who is allowed to call the main process's mutating IPC handlers.
 *
 * The app window carries the full preload bridge — `installHermes`, `wireHermesMcp`,
 * `startStack`, `saveSetup` — and that window can be showing any server the user pointed
 * Orbit at ("existing instance"). An untrusted page must not be able to rewrite
 * `~/.hermes/config.yaml` or drive Docker just by being loaded in that window, so every
 * handler with a side effect checks its sender frame first.
 *
 * The rule is the frame's own URL, not the window: two windows in different partitions can
 * both have the preload attached, and only the setup window (a `file://` document we ship)
 * and the local stack's origin are ours. Pure string logic with no Electron import, so it
 * can be tested directly.
 */

import { normalizeServerUrl } from './setup-config';

export interface SenderFrame {
  url?: string;
}

export interface TrustedPageInput {
  /** `event.senderFrame?.url`. */
  pageUrl?: string | null;
  /** The local stack's web origin (`stack.webUrl()`), while it is the one we are running. */
  stackWebUrl?: string | null;
  /** `pathToFileURL(setup.html).href` — the setup window's own document. */
  setupFileUrl?: string | null;
}

function stripFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** True when the page is the setup window's own file, ignoring a `#fragment`. */
export function isSetupWindowPage(pageUrl: string, setupFileUrl: string): boolean {
  return stripFragment(pageUrl) === stripFragment(setupFileUrl);
}

/** True only for the setup window document or the local stack's own origin. */
export function isTrustedPage(input: TrustedPageInput): boolean {
  const pageUrl = typeof input.pageUrl === 'string' ? input.pageUrl.trim() : '';
  if (!pageUrl) return false;

  const setupFileUrl = typeof input.setupFileUrl === 'string' ? input.setupFileUrl.trim() : '';
  if (setupFileUrl && isSetupWindowPage(pageUrl, setupFileUrl)) return true;

  const page = normalizeServerUrl(pageUrl);
  const stack = normalizeServerUrl(input.stackWebUrl ?? null);
  return Boolean(page && stack && page === stack);
}

/**
 * Log-safe description of a frame's origin: a full file path says nothing useful about who
 * called us, and a query string can carry a token.
 */
export function describeSender(url: string | null | undefined, stackWebUrl: string | null | undefined): string {
  const origin = normalizeServerUrl(url ?? null);
  if (origin) return origin === normalizeServerUrl(stackWebUrl ?? null) ? `${origin} (the local stack)` : origin;
  const bare = String(url ?? '').split(/[?#]/)[0].slice(0, 120);
  return bare || '(no sender frame)';
}
