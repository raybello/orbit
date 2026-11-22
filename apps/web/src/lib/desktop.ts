import { useEffect, useState } from 'react';
import type { DeepLink, DesktopGpuVoice, DesktopUpdateStatus } from '@orbit/contracts';

/**
 * The desktop preload bridge as the web app sees it: every member optional, because the same build
 * runs in a plain browser and in older desktop builds that lack newer parts.
 */
export interface OrbitDesktopBridge {
  platform?: 'darwin' | 'win32' | 'linux';
  onDeepLink?: (cb: (link: DeepLink) => void) => () => void;
  gpuVoice?: {
    status(): Promise<DesktopGpuVoice>;
    install(): Promise<DesktopGpuVoice>;
    remove(): Promise<DesktopGpuVoice>;
  };
  /** Installing what Bots' computers run on (Apple's container runtime). */
  computers?: {
    installAppleRuntime(): Promise<{ ok: boolean; error?: string }>;
  };
  updates?: {
    status(): Promise<DesktopUpdateStatus>;
    check(): Promise<DesktopUpdateStatus>;
    download(): Promise<DesktopUpdateStatus>;
    install(): Promise<void>;
    onStatus(cb: (status: DesktopUpdateStatus) => void): () => void;
    onOpenRequest(cb: () => void): () => void;
  };
}

declare global {
  interface Window {
    orbitDesktop?: OrbitDesktopBridge;
  }
}

/** Running inside the macOS desktop app, where GPU voice has no sidecar (on-device voice only). */
export const isMacDesktop = () => typeof window !== 'undefined' && window.orbitDesktop?.platform === 'darwin';

/**
 * The desktop app's GPU voice control, or null outside the desktop app. Polls while an install or
 * removal is running so the settings show its progress.
 */
export function useDesktopGpuVoice(): [DesktopGpuVoice | null, (action: 'install' | 'remove') => Promise<void>] {
  const bridge = typeof window !== 'undefined' ? window.orbitDesktop?.gpuVoice : undefined;
  const [state, setState] = useState<DesktopGpuVoice | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    bridge.status().then((s) => { if (alive) setState(s); }, () => {});
    return () => { alive = false; };
  }, [bridge, tick]);
  const busy = state?.phase === 'installing' || state?.phase === 'removing';
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [busy]);
  const run = async (action: 'install' | 'remove') => {
    if (!bridge) return;
    setState((s) => (s ? { ...s, phase: action === 'install' ? 'installing' : 'removing', error: undefined } : s));
    try {
      setState(await bridge[action]());
    } finally {
      setTick((n) => n + 1);
    }
  };
  return [bridge ? state : null, run];
}

/** The desktop app's update status, live, or null outside the desktop app (and in older builds). */
export function useDesktopUpdates(): DesktopUpdateStatus | null {
  const bridge = typeof window !== 'undefined' ? window.orbitDesktop?.updates : undefined;
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    bridge.status().then((s) => { if (alive) setStatus(s); }, () => {});
    const off = bridge.onStatus((s) => setStatus(s));
    return () => { alive = false; off(); };
  }, [bridge]);
  return bridge ? status : null;
}
