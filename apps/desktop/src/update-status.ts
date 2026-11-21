/**
 * The update state machine Settings draws. Pure: `auto-update.ts` feeds it electron-updater's
 * events and the stack prefetch, and broadcasts whatever it returns.
 */

import type { DesktopUpdateStatus } from '@orbit/contracts';

export type UpdateEvent =
  | { type: 'check' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'prepared'; note?: string }
  | { type: 'error'; error: string };

/** A download or a prepared restart is the person's own action; a background check never undoes it. */
const COMMITTED: ReadonlyArray<DesktopUpdateStatus['phase']> = ['downloading', 'preparing', 'ready'];

export function nextUpdateStatus(status: DesktopUpdateStatus, event: UpdateEvent, now: number = Date.now()): DesktopUpdateStatus {
  const { current } = status;
  if (status.phase === 'unsupported') return status;
  const version = 'version' in status ? status.version : undefined;
  switch (event.type) {
    case 'check':
      return COMMITTED.includes(status.phase) ? status : { phase: 'checking', current };
    case 'available':
      return COMMITTED.includes(status.phase) ? status : { phase: 'available', current, version: event.version };
    case 'not-available':
      return COMMITTED.includes(status.phase) ? status : { phase: 'up-to-date', current, checkedAt: now };
    case 'progress':
      return version ? { phase: 'downloading', current, version, percent: Math.max(0, Math.min(100, Math.round(event.percent))) } : status;
    case 'downloaded':
      return version ? { phase: 'preparing', current, version, detail: 'Getting the new version of the Orbit server ready' } : status;
    case 'prepared':
      return version ? { phase: 'ready', current, version, note: event.note } : status;
    case 'error':
      // A failed background check while an update is ready changes nothing the person can act on.
      return status.phase === 'ready' ? status : { phase: 'error', current, version, error: event.error };
  }
}
