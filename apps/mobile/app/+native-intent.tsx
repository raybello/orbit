import { parseOrbitDeepLink } from '@orbit/contracts';

const APP_LINK = /^orbit:\/\/app(?:[/?#]|$)/i;

/**
 * Expo Router hands every incoming URL (the one that launched the app, and each one after) to this
 * function before routing it. An `orbit://app/v1/prompt` link goes to the prompt screen, which picks
 * the Bot; a malformed `orbit://app` link goes home instead of to "unmatched route"; any other URL
 * routes as it always did. It must not throw: a throw here crashes the app.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const link = parseOrbitDeepLink(path);
    if (!link) return APP_LINK.test(path) ? '/' : path;
    const query = [
      link.botId ? `id=${encodeURIComponent(link.botId)}` : '',
      link.text ? `text=${encodeURIComponent(link.text)}` : '',
    ].filter(Boolean).join('&');
    return query ? `/prompt?${query}` : '/prompt';
  } catch {
    return '/';
  }
}
