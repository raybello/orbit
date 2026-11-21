import type { DesktopPhoneAccess } from '@orbit/contracts';

/**
 * Where a phone should connect, from this page's origin and the desktop app's phone switch.
 * 'switch-off': the desktop app runs this server and the person has not allowed phones yet.
 * 'loopback': a browser on this computer's own address, which no phone can reach.
 */
export type PhoneServer =
  | { kind: 'ready'; url: string }
  | { kind: 'switch-off' }
  | { kind: 'no-network' }
  | { kind: 'error'; error: string }
  | { kind: 'loopback' };

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[^.]+\.localhost)$/i;

export function phoneServer(origin: string, access: DesktopPhoneAccess | null): PhoneServer {
  switch (access?.phase) {
    case 'on': return { kind: 'ready', url: access.url };
    case 'off': return { kind: 'switch-off' };
    case 'no-network': return { kind: 'no-network' };
    case 'error': return { kind: 'error', error: access.error };
    default: {
      const { hostname } = new URL(origin);
      return LOOPBACK.test(hostname) ? { kind: 'loopback' } : { kind: 'ready', url: origin };
    }
  }
}

/** How long before a code expires the card swaps in a fresh one, so a scan never lands on a dead code. */
export const PAIR_REFRESH_LEAD_MS = 60_000;
