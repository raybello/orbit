import type { ErrorResponse } from '@orbit/contracts';
import { getSessionToken } from './session';

/** Anything the server said "no" to, with the status so callers can tell 401 from 500. */
export class OrbitApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = 'OrbitApiError';
    this.status = status;
    this.body = body;
  }

  /** The session is gone or was never valid: the app should go back to sign-in. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface OrbitFetchOptions {
  /** Give up after this long. Defaults to 20s; health probes pass something shorter. */
  timeoutMs?: number;
  /** Send the session token. Off for public endpoints such as /api/health. */
  auth?: boolean;
  /** Caller-owned cancellation, e.g. a screen unmounting. */
  signal?: AbortSignal;
}

function errorMessage(body: unknown, status: number): string {
  const shaped = body as Partial<ErrorResponse> | null;
  if (shaped && typeof shaped.error === 'string' && shaped.error) return shaped.error;
  if (status === 401) return 'Your session expired. Sign in again.';
  if (status === 404) return 'Not found on that server.';
  return `The server refused that request (${status}).`;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The one way the app talks to an Orbit server: bearer auth, JSON in and out, a timeout that
 * actually fires, and every failure surfaced as an OrbitApiError with a sentence a person can read.
 */
export async function fetchOrbitJson<T>(
  url: string,
  init: RequestInit = {},
  opts: OrbitFetchOptions = {},
): Promise<T> {
  const { timeoutMs = 20_000, auth = true, signal } = opts;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort);

  const headers = new Headers(init.headers ?? {});
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  try {
    if (auth) {
      const token = await getSessionToken();
      if (token) headers.set('authorization', `Bearer ${token}`);
    }
    if (init.body !== undefined && init.body !== null && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    const text = await response.text();
    const body = parseBody(text);

    if (!response.ok) throw new OrbitApiError(errorMessage(body, response.status), response.status, body);
    return body as T;
  } catch (e) {
    if (e instanceof OrbitApiError) throw e;
    if (signal?.aborted && !timedOut) throw new OrbitApiError('Cancelled.', 0);
    if (timedOut) throw new OrbitApiError('The server took too long to answer.', 0);
    const detail = e instanceof Error ? e.message : String(e);
    throw new OrbitApiError(
      /network request failed|failed to fetch/i.test(detail) ? 'Could not reach the server.' : detail || 'Could not reach the server.',
      0,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

/** Convenience for the screens: a path on a chosen server, JSON in, typed JSON out. */
export function orbitGet<T>(apiBase: string, path: string, opts?: OrbitFetchOptions): Promise<T> {
  return fetchOrbitJson<T>(`${apiBase}${path}`, { method: 'GET' }, opts);
}

export function orbitPost<T>(
  apiBase: string,
  path: string,
  body?: unknown,
  opts?: OrbitFetchOptions,
): Promise<T> {
  return fetchOrbitJson<T>(
    `${apiBase}${path}`,
    { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    opts,
  );
}

export function orbitDelete<T>(apiBase: string, path: string, opts?: OrbitFetchOptions): Promise<T> {
  return fetchOrbitJson<T>(`${apiBase}${path}`, { method: 'DELETE' }, opts);
}
