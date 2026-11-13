import { env } from '../env.js';

/**
 * Is the primary Hermes API answering? Asked by the desktop app's stack probe, so it must never
 * throw and must not make the probe wait long: the answer is cached for ten seconds and a probe
 * already in flight is shared.
 */
const CACHE_MS = 10_000;
const TIMEOUT_MS = 1500;

let cached: { at: number; up: boolean } | null = null;
let inflight: Promise<boolean> | null = null;

async function reachable(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${env.hermesUrl}/`, {
      signal: ctrl.signal,
      headers: env.hermesKey ? { authorization: `Bearer ${env.hermesKey}` } : {},
    });
    // Any answer below 500 means the API server is there; "/" may simply want a different path.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function hermesConnected(): Promise<boolean> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.up);
  if (!inflight) {
    inflight = reachable()
      .then((up) => {
        cached = { at: Date.now(), up };
        return up;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
