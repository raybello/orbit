import { parseOrbitDeepLink, type DeepLink } from '@orbit/contracts';

/**
 * `orbit://` links reach main three ways: macOS `open-url`, and on Windows and Linux an argument of
 * the first launch or of a `second-instance`. Whichever way, the newest one waits here until the app
 * window's page takes it, so a link that arrives during boot or sign-in is not lost, and a page that
 * subscribes twice cannot open it twice.
 */

/** The first argument that is an Orbit link. */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | null {
  for (const arg of argv) {
    const link = parseOrbitDeepLink(arg);
    if (link) return link;
  }
  return null;
}

export interface DeepLinkInbox {
  /** Keeps `link` as the one waiting (a newer link replaces an untaken one). */
  put(link: DeepLink): void;
  /** The waiting link, once. */
  take(): DeepLink | null;
}

export function createDeepLinkInbox(): DeepLinkInbox {
  let waiting: DeepLink | null = null;
  return {
    put(link) {
      waiting = link;
    },
    take() {
      const link = waiting;
      waiting = null;
      return link;
    },
  };
}
