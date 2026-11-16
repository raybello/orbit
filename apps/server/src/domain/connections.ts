/**
 * What a user's connected-app accounts say about each app, and what to do about the ones whose
 * sign-in has expired. Pure: core/connection-watch.ts supplies the accounts and acts on the plan.
 */

/** One Composio connected account, in the fields this app reads. */
export interface ConnectionAccount {
  id: string;
  toolkit: string;
  /** Composio's status: ACTIVE, EXPIRED, INITIATED, INACTIVE, FAILED… */
  status: string;
}

export interface ConnectionHealth {
  connected: Set<string>;
  /** Apps whose sign-in expired and that no other account still covers: only reconnecting helps. */
  expired: Set<string>;
}

export function connectionHealth(accounts: readonly ConnectionAccount[]): ConnectionHealth {
  const toolkitsWith = (status: string) => new Set(accounts.filter((a) => a.status === status).map((a) => a.toolkit));
  const connected = toolkitsWith('ACTIVE');
  const expired = new Set([...toolkitsWith('EXPIRED')].filter((t) => !connected.has(t)));
  return { connected, expired };
}

/**
 * The difference between what is expired now and what the user has already been told about:
 * `alert` the newly expired, `forget` the ones that are healthy (or gone) again, so that a later
 * expiry of the same app is news once more.
 */
export function planReconnectAlerts(expired: ReadonlySet<string>, alerted: ReadonlySet<string>): { alert: string[]; forget: string[] } {
  return {
    alert: [...expired].filter((t) => !alerted.has(t)),
    forget: [...alerted].filter((t) => !expired.has(t)),
  };
}

/** Whether a connected-app tool slug belongs to a toolkit: GMAIL_SEND_EMAIL is gmail's, GMAILX_… is not. */
export const slugInToolkit = (slug: string, toolkit: string) => slug.toLowerCase().startsWith(`${toolkit.toLowerCase()}_`);
