import { useCallback, useEffect, useState } from 'react';
import type { ComputerRuntimeInfo, ComputerRuntimeName, ComputerRuntimeOption } from '@orbit/contracts';
import { api } from './api';

/** The runtime that is active, and the one a person could switch to, from the server's own report. */
export function activeOption(info: ComputerRuntimeInfo | null): ComputerRuntimeOption | undefined {
  return info?.options.find((o) => o.name === info.active);
}

export function otherOption(info: ComputerRuntimeInfo | null): ComputerRuntimeOption | undefined {
  return info?.options.find((o) => o.name !== info.active);
}

/** Why Bots' computers cannot start on the active runtime, when that is the reason; else null. */
export function runtimeProblem(info: ComputerRuntimeInfo | null): string | null {
  const active = activeOption(info);
  return active && !active.available ? active.note : null;
}

export function useComputerRuntime(enabled = true) {
  const [info, setInfo] = useState<ComputerRuntimeInfo | null>(null);
  const [busy, setBusy] = useState<ComputerRuntimeName | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await api.computerRuntime());
    } catch {
      /* an older server has no such route: nothing to offer */
    }
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  const choose = useCallback(async (name: ComputerRuntimeName) => {
    setBusy(name);
    setError(null);
    try {
      setInfo(await api.setComputerRuntime(name));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const installApple = useCallback(async () => {
    const install = window.orbitDesktop?.computers?.installAppleRuntime;
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

  return { info, busy, error, refresh, choose, installApple };
}
