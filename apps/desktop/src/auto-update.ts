/**
 * Updates from GitHub Releases (`electron-updater`), driven from Settings.
 *
 * The app checks on launch and every four hours, and says what it found in Settings. Nothing is
 * downloaded until the person asks. After the download, `prepare` fetches the new version's
 * server (Docker images or the native bundle) while the current one keeps running, so the
 * restart only has to stop, switch and start. Never in a development build: it has no
 * `app-update.yml`, and electron-updater throws a confusing error if asked to check.
 */

import { app } from 'electron';
import { createRequire } from 'node:module';
import type { DesktopUpdateStatus } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import { nextUpdateStatus, type UpdateEvent } from './update-status';

const log = createLogger({ scope: 'update' });

// electron-updater is CommonJS and is left external in the bundle, so it is loaded with
// require() rather than an ESM named import (which is unreliable for its export shape).
const requireCjs = createRequire(import.meta.url);

type ElectronUpdaterModule = typeof import('electron-updater');
type AutoUpdater = ElectronUpdaterModule['autoUpdater'];

export const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface AutoUpdateOptions {
  /** Fetch what the new version's server needs. Resolves to a note for Settings, if any. */
  prepare: (version: string) => Promise<string | undefined>;
  onStatus: (status: DesktopUpdateStatus) => void;
}

let updater: AutoUpdater | null = null;
let status: DesktopUpdateStatus = { phase: 'unsupported', current: app.getVersion() };
let options: AutoUpdateOptions | null = null;
let timer: NodeJS.Timeout | null = null;

function loadUpdater(): AutoUpdater | null {
  if (updater) return updater;
  try {
    updater = (requireCjs('electron-updater') as ElectronUpdaterModule).autoUpdater;
    return updater;
  } catch (err) {
    log.warn('electron-updater is unavailable', err);
    return null;
  }
}

function apply(event: UpdateEvent): void {
  const next = nextUpdateStatus(status, event);
  if (next === status) return;
  status = next;
  if (event.type !== 'progress') log.info(`update: ${status.phase}${'version' in status && status.version ? ` ${status.version}` : ''}`);
  options?.onStatus(status);
}

export function updateStatus(): DesktopUpdateStatus {
  return status;
}

export function initAutoUpdate(opts: AutoUpdateOptions): void {
  options = opts;
  if (!app.isPackaged) {
    log.info('auto-update disabled: not a packaged build');
    return;
  }
  const autoUpdater = loadUpdater();
  if (!autoUpdater) return;
  status = { phase: 'idle', current: app.getVersion() };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (msg?: unknown) => log.info(String(msg)),
    warn: (msg?: unknown) => log.warn(String(msg)),
    error: (msg?: unknown) => log.error(String(msg)),
    debug: (msg?: unknown) => log.debug(String(msg)),
  } as unknown as AutoUpdater['logger'];

  autoUpdater.on('checking-for-update', () => apply({ type: 'check' }));
  autoUpdater.on('update-available', (info) => apply({ type: 'available', version: String(info?.version ?? '') }));
  autoUpdater.on('update-not-available', () => apply({ type: 'not-available' }));
  autoUpdater.on('download-progress', (p) => apply({ type: 'progress', percent: Number(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', () => {
    apply({ type: 'downloaded' });
    void prepareStack();
  });
  autoUpdater.on('error', (err) => apply({ type: 'error', error: (err as Error)?.message ?? String(err) }));

  void checkForUpdates();
  timer = setInterval(() => void checkForUpdates(), UPDATE_INTERVAL_MS);
  timer.unref?.();
}

/** The prefetch is an optimisation: when it fails, the new version fetches on its first start. */
async function prepareStack(): Promise<void> {
  if (status.phase !== 'preparing' || !options) return;
  const { version } = status;
  try {
    apply({ type: 'prepared', note: await options.prepare(version) });
  } catch (err) {
    log.warn(`could not prepare the ${version} server ahead of the restart`, err);
    apply({ type: 'prepared', note: 'Orbit will finish downloading its server after the restart.' });
  }
}

export async function checkForUpdates(): Promise<DesktopUpdateStatus> {
  const autoUpdater = status.phase === 'unsupported' ? null : loadUpdater();
  if (!autoUpdater) return status;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    apply({ type: 'error', error: (err as Error)?.message ?? String(err) });
  }
  return status;
}

/** Settings' Download button: fetch the release found by the last check. */
export async function downloadUpdate(): Promise<DesktopUpdateStatus> {
  const autoUpdater = status.phase === 'unsupported' ? null : loadUpdater();
  if (!autoUpdater || !(status.phase === 'available' || (status.phase === 'error' && status.version))) return status;
  apply({ type: 'progress', percent: 0 });
  autoUpdater.downloadUpdate().catch((err: unknown) => apply({ type: 'error', error: (err as Error)?.message ?? String(err) }));
  return status;
}

/** Relaunch on the downloaded version. The caller stops the stack first. */
export function restartAndInstall(): void {
  if (status.phase !== 'ready') return;
  const autoUpdater = loadUpdater();
  if (!autoUpdater) return;
  if (timer) clearInterval(timer);
  // isSilent=false, isForceRunAfter=true: relaunch, do not just quit.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}
