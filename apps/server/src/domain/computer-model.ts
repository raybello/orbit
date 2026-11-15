/**
 * The shared computer, modelled as the small amount of state a screen allocator actually needs.
 *
 * Real life (computer.ts, computer-store.ts): one Orgo computer holds a handful of screens, one per
 * bot, and a bot keeps its screen across resumes. `ready.screens` is the live allocation table; a
 * screen is free when `botId` is null. Screens exist only on the `ready` variant — while the computer
 * is provisioning or suspended there is no display to attach a bot to, and the real code re-claims
 * the existing row on resume.
 *
 * All transitions return new objects: callers can keep the previous state (e.g. for a diff or to
 * compare-and-swap) without defensive copying.
 */

export type Screen = {
  screenId: string;
  botId: string | null;
  lastUsedAt: number;
};

export type ComputerStatus =
  | { status: 'absent' }
  | { status: 'provisioning'; orgoId: string; startedAt: number }
  | { status: 'ready'; orgoId: string; screens: Screen[] }
  | { status: 'suspended'; orgoId: string; suspendedAt: number; reason: string }
  | { status: 'error'; error: Error; failedAt: number };

/** The screens nobody is using right now. Empty unless the computer is ready. */
export function freeScreens(computer: ComputerStatus): Screen[] {
  if (computer.status !== 'ready') return [];
  return computer.screens.filter((s) => s.botId === null);
}

export function canAssignScreen(computer: ComputerStatus): boolean {
  return computer.status === 'ready' && computer.screens.some((s) => s.botId === null);
}

/**
 * Give `botId` a free screen. Throws when the computer is not ready or every screen is taken; the
 * caller decides whether that is fatal (real code falls back to another computer kind).
 *
 * Idempotent like computer-store's claimScreen: a bot that already holds a screen keeps it, even if
 * the computer is now full. Pass a clock in tests instead of sleeping on Date.now.
 */
export function assignScreen(computer: ComputerStatus, botId: string, now: () => number = Date.now): ComputerStatus {
  if (computer.status !== 'ready') {
    throw new Error(`computer is ${computer.status}, not ready: cannot assign a screen to ${botId}`);
  }
  if (computer.screens.some((s) => s.botId === botId)) return computer;

  const free = computer.screens.find((s) => s.botId === null);
  if (!free) {
    throw new Error(`no free screen on computer ${computer.orgoId}: all ${computer.screens.length} are assigned`);
  }

  const at = now();
  return {
    ...computer,
    screens: computer.screens.map((s) => (s.screenId === free.screenId ? { ...s, botId, lastUsedAt: at } : s)),
  };
}

/**
 * Free whatever screen `botId` holds and stamp it as used now, so the allocator can hand it to the
 * next bot. Releasing a bot that holds nothing (or releasing on a computer that is not ready) is a
 * no-op, which makes cleanup safe to call more than once.
 */
export function releaseScreen(computer: ComputerStatus, botId: string, now: () => number = Date.now): ComputerStatus {
  if (computer.status !== 'ready') return computer;
  if (!computer.screens.some((s) => s.botId === botId)) return computer;

  const at = now();
  return {
    ...computer,
    screens: computer.screens.map((s) => (s.botId === botId ? { ...s, botId: null, lastUsedAt: at } : s)),
  };
}
