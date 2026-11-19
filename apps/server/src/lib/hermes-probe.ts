import { primaryEngineUrl } from '../engine.js';

/**
 * Is the primary agent's API answering? Asked by the desktop app's stack probe, so it must never
 * throw and must not make the probe wait long: the answer is cached for ten seconds and a probe
 * already in flight is shared.
 */
const CACHE_MS = 10_000;
const TIMEOUT_MS = 1500;

let cached: { at: number; up: boolean } | null = null;
let inflight: Promise<boolean> | null = null;

async function reachable(): Promise<boolean> {
  const url = primaryEngineUrl();
  if (!url) return false;
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
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
