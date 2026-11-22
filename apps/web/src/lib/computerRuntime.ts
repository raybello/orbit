import { useCallback, useEffect, useState } from 'react';
import type { ComputerRuntimeInfo, ComputerRuntimeOption } from '@orbit/contracts';
import { api } from './api';

/** The runtime Bots' computers are on, from the server's own report. */
export function activeOption(info: ComputerRuntimeInfo | null): ComputerRuntimeOption | undefined {
  return info?.options.find((o) => o.name === info.active);
}

/** Why Bots' computers cannot start on the runtime in use, when that is the reason; else null. */
export function runtimeProblem(info: ComputerRuntimeInfo | null): string | null {
  const active = activeOption(info);
  return active && !active.available ? active.note : null;
}

/** What the desktop app can do about it: install Apple's runtime, or start over at the first-run choices. */
export function desktopRuntimeActions() {
  const bridge = typeof window !== 'undefined' ? window.orbitDesktop : undefined;
  return { canInstallApple: !!bridge?.computers, canResetSetup: !!bridge?.setup };
}

/**
 * Ask the desktop app to reset the setup. Resolves to a message when nothing happened (the page is
 * not allowed to), and to null when the app is on its way to the setup window.
 */
export async function resetDesktopSetup(): Promise<string | null> {
  const reset = typeof window !== 'undefined' ? window.orbitDesktop?.setup?.reset : undefined;
  if (!reset) return 'This is only available in the Orbit desktop app.';
  try {
    const r = await reset();
    return r.ok ? null : r.error ?? 'Could not reset the setup.';
  } catch (e) {
    return (e as Error).message;
  }
}

export function useComputerRuntime(enabled = true) {
  const [info, setInfo] = useState<ComputerRuntimeInfo | null>(null);
  const [busy, setBusy] = useState<'install' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await api.computerRuntime());
    } catch {
      /* an older server has no such route: nothing to explain */
    }
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  const installApple = useCallback(async () => {
    const install = typeof window !== 'undefined' ? window.orbitDesktop?.computers?.installAppleRuntime : undefined;
    if (!install) return false;
    setBusy('install');
    setError(null);
    try {
      const r = await install();
      if (!r.ok) setError(r.error ?? 'Apple’s container runtime could not be installed.');
      await refresh();
      return r.ok;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const resetSetup = useCallback(async () => {
    setBusy('reset');
    setError(null);
    const message = await resetDesktopSetup();
    if (message) setError(message);
    setBusy(null);
  }, []);

  return { info, busy, error, refresh, installApple, resetSetup };
}
