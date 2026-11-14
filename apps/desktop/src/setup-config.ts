/**
 * Startup decisions: which server to open, and which Electron session partition to use
 * for it.
 *
 * URL normalization lives in `server-url.ts` (the setup renderer needs it too); this
 * module adds the parts that are main-process-only.
 */

import { createHash } from 'node:crypto';
import type { DesktopSetup } from './shared/api';
import { DEFAULT_LOCAL_WEB_URL, normalizeServerUrl } from './server-url';

export { DEFAULT_LOCAL_WEB_URL, normalizeServerUrl };

/** Env var that overrides both the saved setup and the default local server. */
export const WEB_URL_ENV = 'ORBIT_WEB_URL';

export type StartupTarget = { kind: 'setup' } | { kind: 'app'; url: string };

export interface ResolveStartupTargetInput {
  /** An explicitly passed URL (from the menu or `--server`), which beats the saved setup. */
  envUrl?: string;
  saved?: DesktopSetup | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * `ORBIT_WEB_URL` (or an explicit URL) wins, then the saved setup, then the setup window.
 *
 * A saved setup whose URL does not normalize is treated as no setup at all: better to
 * re-run first-run than to open a blank window at a nonsense address.
 */
export function resolveStartupTarget(input: ResolveStartupTargetInput = {}): StartupTarget {
  const explicit = normalizeServerUrl(input.envUrl ?? input.env?.[WEB_URL_ENV]);
  if (explicit) return { kind: 'app', url: explicit };

  const saved = input.saved ?? null;
  if (saved) {
    if (saved.mode === 'new') {
      return { kind: 'app', url: normalizeServerUrl(saved.serverUrl) ?? DEFAULT_LOCAL_WEB_URL };
    }
    const url = normalizeServerUrl(saved.serverUrl);
    if (url) return { kind: 'app', url };
  }

  return { kind: 'setup' };
}

/**
 * One persistent Electron partition per server origin, so two Orbit servers never share
 * cookies. Derived from the origin (not the full URL) so a path change cannot log the
 * user out, and stable across launches so it survives restarts.
 */
export function sessionPartitionForServerUrl(serverUrl: string): string {
  const origin = normalizeServerUrl(serverUrl) ?? String(serverUrl ?? '').trim().toLowerCase();
  const digest = createHash('sha256').update(origin).digest('hex');
  return `persist:orbit-${digest.slice(0, 24)}`;
}
