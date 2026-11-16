/**
 * `orbit://app/v1/prompt?id=<botId>&text=<url-encoded message>` opens a Bot with text waiting in its
 * composer. Desktop main, the web app and mobile all read links through this one parser, so a link
 * means the same thing on every client.
 *
 * Parsed by hand rather than with `URL`: React Native's URL polyfill has no `searchParams`, and engines
 * disagree on how a custom scheme's host and path split.
 */

import type { Bot } from './index.js';

export interface DeepLinkPrompt {
  kind: 'prompt';
  /** null opens the person's primary Bot. */
  botId: string | null;
  /** Fills the composer only while it is empty, and is never sent on its own. May be ''. */
  text: string;
}

export type DeepLink = DeepLinkPrompt;

export const DEEP_LINK_SCHEME = 'orbit';
export const MAX_DEEP_LINK_TEXT = 8_000;
const MAX_DEEP_LINK_LENGTH = 32_768;
const BOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/s;

/** The link, or null for anything that is not a well-formed `orbit://app/v1/prompt` link. */
export function parseOrbitDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== 'string' || raw.length > MAX_DEEP_LINK_LENGTH) return null;
  const match = SHAPE.exec(raw.trim());
  if (!match) return null;
  const [, scheme, host, path, query = ''] = match;
  if (scheme.toLowerCase() !== DEEP_LINK_SCHEME || host.toLowerCase() !== 'app') return null;
  if (path !== '/v1/prompt' && path !== '/v1/prompt/') return null;

  const params = parseQuery(query);
  if (!params) return null;
  const id = params.get('id') ?? '';
  if (id && !BOT_ID.test(id)) return null;
  const text = params.get('text') ?? '';
  if (text.length > MAX_DEEP_LINK_TEXT) return null;
  return { kind: 'prompt', botId: id || null, text };
}

/** The Bot a link opens: the one it names, else the primary (also when the named one is gone). */
export function deepLinkTarget(bots: readonly Pick<Bot, 'id' | 'isPrimary'>[], link: DeepLink): string | null {
  const named = link.botId ? bots.find((b) => b.id === link.botId) : undefined;
  return (named ?? bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
}

/** Form-encoded pairs. A repeated key is ambiguous, so it fails the whole link. */
function parseQuery(query: string): Map<string, string> | null {
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decode(eq === -1 ? pair : pair.slice(0, eq));
    const value = decode(eq === -1 ? '' : pair.slice(eq + 1));
    if (key === null || value === null || params.has(key)) return null;
    params.set(key, value);
  }
  return params;
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}
