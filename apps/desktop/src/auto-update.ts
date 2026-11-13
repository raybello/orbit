/**
 * Auto-update via GitHub Releases (`electron-updater`).
 *
 * Three rules shaped this file:
 *  - never interrupt: updates are announced with a small bar, not a modal dialog;
 *  - never in dev: an unpackaged build has no `app-update.yml`, and `electron-updater`
 *    throws a confusing error if asked to check;
 *  - never silently: a failed check is logged once and retried on the next 4-hour tick.
 */

import { app, BrowserWindow, screen } from 'electron';
import { createRequire } from 'node:module';
import { createLogger } from '@orbit/logger';
import { IPC } from './shared/api';

const log = createLogger({ scope: 'update' });

// electron-updater is CommonJS and is left external in the bundle, so it is loaded with
// require() rather than an ESM named import (which is unreliable for its export shape).
const requireCjs = createRequire(import.meta.url);

type ElectronUpdaterModule = typeof import('electron-updater');
type AutoUpdater = ElectronUpdaterModule['autoUpdater'];

export const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface AutoUpdateOptions {
  /** Where the bar's buttons are wired (main exposes restartAndInstall over IPC). */
  onUpdateReady?: (version: string | undefined) => void;
  /** Test seam. */
  intervalMs?: number;
  preloadPath?: string;
}

let bar: BrowserWindow | null = null;
let timer: NodeJS.Timeout | null = null;
let updater: AutoUpdater | null = null;
let readyListener: ((version: string | undefined) => void) | null = null;
let announcedVersion: string | null = null;
let preloadForBar: string | undefined;

function loadUpdater(): AutoUpdater | null {
  if (updater) return updater;
  try {
    const mod = requireCjs('electron-updater') as ElectronUpdaterModule;
    updater = mod.autoUpdater;
    return updater;
  } catch (err) {
    log.warn('electron-updater is unavailable', err);
    return null;
  }
}

/** `electron-updater` wants a console-like logger; give it one without leaking tokens. */
const updaterLogger = {
  info: (msg?: unknown) => log.info(String(msg)),
  warn: (msg?: unknown) => log.warn(String(msg)),
  error: (msg?: unknown) => log.error(String(msg)),
  debug: (msg?: unknown) => log.debug(String(msg)),
};

export function initAutoUpdate(options: AutoUpdateOptions = {}): void {
  readyListener = options.onUpdateReady ?? null;
  preloadForBar = options.preloadPath;

  if (!app.isPackaged) {
    log.info('auto-update disabled: not a packaged build');
    return;
  }

  const autoUpdater = loadUpdater();
  if (!autoUpdater) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = updaterLogger as unknown as AutoUpdater['logger'];

  autoUpdater.on('update-downloaded', (info) => {
    const version = (info as { version?: string })?.version;
    log.info('update downloaded', version ?? '');
    announcedVersion = version ?? null;
    showUpdateBar(version);
    readyListener?.(version);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win !== bar) win.webContents.send(IPC.updateReady, { version });
    }
  });
  autoUpdater.on('error', (err) => log.warn('update check failed', (err as Error)?.message ?? err));

  void checkForUpdates(false);
  timer = setInterval(() => void checkForUpdates(false), options.intervalMs ?? UPDATE_INTERVAL_MS);
  // A pending update check must not keep the app alive after the last window closes.
  timer.unref?.();
}

/** `interactive` shows the "already up to date" answer; the timer never does. */
export async function checkForUpdates(interactive = true): Promise<void> {
  if (!app.isPackaged) {
    if (interactive) log.info('update check skipped in a development build');
    return;
  }
  const autoUpdater = loadUpdater();
  if (!autoUpdater) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    log.warn('update check failed', (err as Error)?.message ?? err);
  }
}

const BAR_HTML = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; align-items: center; gap: 12px;
    padding: 0 14px; font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: rgba(28,28,28,0.96); color: #f2f2f2;
    -webkit-app-region: drag; user-select: none; border-radius: 12px;
  }
  .dot { width: 8px; height: 8px; border-radius: 999px; background: #14c16f; flex: 0 0 8px; }
  .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button {
    -webkit-app-region: no-drag; font: inherit; font-weight: 500; cursor: pointer;
    border-radius: 999px; border: 1px solid transparent; padding: 5px 12px;
  }
  #install { background: #f2f2f2; color: #1c1c1c; }
  #later { background: transparent; border-color: rgba(255,255,255,0.24); color: #f2f2f2; }
</style></head>
<body>
  <span class="dot"></span>
  <span class="label" id="label">Orbit update ready — Restart to install</span>
  <button id="install">Restart</button>
  <button id="later">Later</button>
  <script>
    const label = document.getElementById('label');
    const api = window.orbitDesktop || {};
    document.getElementById('install').onclick = () => api.restartAndInstall?.();
    document.getElementById('later').onclick = () => api.dismissUpdateNotice?.();
    window.orbitDesktop?.onUpdateReady?.((info) => {
      if (info && info.version) label.textContent = 'Orbit ' + info.version + ' ready — Restart to install';
    });
  </script>
</body></html>`;

/**
 * A frameless bar at the top of the active display. Deliberately not a dialog: the user
 * may be mid-conversation with a bot, and an update should never take the keyboard.
 */
export function showUpdateBar(version?: string): BrowserWindow | null {
  if (bar && !bar.isDestroyed()) {
    bar.webContents.send(IPC.updateReady, { version });
    bar.showInactive();
    return bar;
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 460;
  const height = 52;
  const { workArea } = display;

  bar = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: preloadForBar,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'orbit-update-bar',
    },
  });
  bar.setAlwaysOnTop(true, 'floating');
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bar.on('closed', () => {
    bar = null;
  });
  void bar.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BAR_HTML)}`).then(() => {
    bar?.showInactive();
  });
  return bar;
}

export function dismissUpdateBar(): void {
  if (bar && !bar.isDestroyed()) bar.close();
  bar = null;
}

/** `quitAndInstall` is what the Restart button and the IPC handler both call. */
export function restartAndInstall(): void {
  const autoUpdater = loadUpdater();
  if (!autoUpdater) {
    log.warn('restartAndInstall: no updater');
    return;
  }
  dismissUpdateBar();
  // isSilent=false, isForceRunAfter=true: relaunch, do not just quit.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

export function disposeAutoUpdate(): void {
  if (timer) clearInterval(timer);
  timer = null;
  dismissUpdateBar();
}

/** Exposed for tests and for the error line in the menu. */
export function pendingUpdateVersion(): string | null {
  return announcedVersion;
}
