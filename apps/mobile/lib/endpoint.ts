import Constants from 'expo-constants';
import type { HealthResponse } from '@orbit/contracts';
import { fetchOrbitJson } from './api';

/** Where an unconfigured install points: the dev server on the machine running Metro. */
export const DEFAULT_DEV_API_BASE = 'http://localhost:8787';

/** The URL baked into the build (or the dev default) — the starting point for the server screen. */
export function defaultApiBase(): string {
  const raw = bakedApiBase();
  const normalized = raw ? normalizeApiBase(raw) : null;
  return normalized?.ok ? normalized.url : DEFAULT_DEV_API_BASE;
}

/** The server named at build time, if any. Expo serialises a null extra as `{}`, so check the type. */
function bakedApiBase(): string | null {
  const extra = Constants.expoConfig?.extra as { apiUrl?: unknown } | undefined;
  const fromConfig = typeof extra?.apiUrl === 'string' ? extra.apiUrl : null;
  const fromEnv = typeof process.env.EXPO_PUBLIC_API_URL === 'string' ? process.env.EXPO_PUBLIC_API_URL : null;
  return fromConfig ?? fromEnv;
}

/** True when the build itself names a server, so first launch does not have to ask. */
export function hasBakedApiBase(): boolean {
  return Boolean(bakedApiBase());
}

export type NormalizedBase = { ok: true; url: string } | { ok: false; error: string };

/**
 * Talk the person out of typos: accept a bare host, add the scheme a dev box or a public host
 * expects, drop trailing slashes so `${base}/api/x` never doubles them.
 */
export function normalizeApiBase(raw: string): NormalizedBase {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Enter your server address.' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${looksLocal(trimmed) ? 'http' : 'https'}://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That does not look like a server address.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Use an http:// or https:// address.' };
  }
  if (!url.hostname) return { ok: false, error: 'That address is missing a host.' };
  if (url.search || url.hash) return { ok: false, error: 'Drop the query string from the address.' };

  const path_ = url.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${url.protocol}//${url.host}${path_}` };
}

function looksLocal(value: string): boolean {
  const host = value.split('/')[0].split(':')[0].toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '10.0.2.2' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export function isLoopbackBase(url: string): boolean {
  try {
    return looksLocal(new URL(url).host);
  } catch {
    return false;
  }
}

export interface ProbeResult {
  ok: boolean;
  version?: string;
  engine?: string;
  error?: string;
}

/** GET /api/health with a short timeout: "does this address speak Orbit?" */
export async function probeApiBase(url: string, timeoutMs = 5000): Promise<ProbeResult> {
  try {
    const health = await fetchOrbitJson<HealthResponse>(
      `${url}/api/health`,
      { method: 'GET' },
      { timeoutMs, auth: false },
    );
    if (!health || health.ok !== true) return { ok: false, error: 'That address did not answer like an Orbit server.' };
    return { ok: true, version: health.version, engine: health.engine };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach that server.' };
  }
}

/** A warning worth showing before someone types a session token into cleartext. */
export function apiBaseWarning(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return null;
    if (isLoopbackBase(url)) return null;
    return 'This server is not using HTTPS. Your sign-in token crosses the network unencrypted.';
  } catch {
    return null;
  }
}
