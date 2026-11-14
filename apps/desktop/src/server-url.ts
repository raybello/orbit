/**
 * Turning what a person typed into a server origin.
 *
 * Split out from `setup-config.ts` because the setup window (a browser bundle) needs this
 * function too, and it must not drag `node:crypto` into the renderer.
 */

/** The URL the Docker stack publishes by default (see infra/compose/.env.example). */
export const DEFAULT_LOCAL_WEB_URL = 'http://127.0.0.1:8787';

function looksLocal(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost')
  );
}

/**
 * `localhost:8787` -> `http://localhost:8787`
 * `orbit.example.com` -> `https://orbit.example.com`
 * `https://orbit.example.com/app?x=1` -> `https://orbit.example.com`
 *
 * Returns null for anything that is not an http(s) URL with a hostname, so callers can
 * keep Continue disabled instead of guessing at a typo.
 */
export function normalizeServerUrl(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;
  // People paste URLs out of chat apps, with angle brackets and trailing punctuation.
  raw = raw.replace(/^[<("'\s]+|[>)"'\s]+$/g, '');
  if (!raw) return null;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // No scheme: assume https everywhere except loopback and mDNS names, where plain
    // HTTP is the common case for a self-hosted server.
    const hostPart = raw.split('/')[0].split(':')[0].toLowerCase();
    raw = `${looksLocal(hostPart) ? 'http' : 'https'}://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.hostname === '.') return null;
  // Credentials in the URL would only end up in the setup file; drop them.
  url.username = '';
  url.password = '';
  return url.origin;
}
