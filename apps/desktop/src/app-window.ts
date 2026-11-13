/**
 * The main window: Orbit's web app, loaded from whatever server the user chose.
 *
 * The renderer is the server's own web build — there is no separate desktop UI — so this
 * module's job is to make a browser window behave like an app: one origin, no stray
 * popups, a per-server cookie jar, and a header that tells the server it is being used
 * from the desktop client.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, session, shell, type Session } from 'electron';
import { ORBIT_HEADERS } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import { normalizeServerUrl, sessionPartitionForServerUrl } from './setup-config';
import { installPermissionHandlers } from './session-permissions';

const log = createLogger({ scope: 'window' });

/** Directory of the built main bundle (`dist/`), used to find `preload.cjs`. */
const here = path.dirname(fileURLToPath(import.meta.url));

export function preloadPath(): string {
  return path.join(here, 'preload.cjs');
}

export interface DesktopManifest {
  name?: string;
  updateCheckUrl?: string;
  features?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface CreateAppWindowOptions {
  url: string;
  preload?: string;
  show?: boolean;
  onClosed?: () => void;
}

export interface AppWindow {
  window: BrowserWindow;
  session: Session;
  /** The `desktop.json` the server served, when it served one. */
  manifest: DesktopManifest | null;
  partition: string;
}

/** The session for a server URL, with Orbit's permission policy attached. */
export function sessionForServerUrl(url: string): { ses: Session; partition: string } {
  const partition = sessionPartitionForServerUrl(url);
  const ses = session.fromPartition(partition);
  installPermissionHandlers(ses);
  return { ses, partition };
}

/** True when `target` is the same origin as `origin` (or a sub-path of it). */
function sameOrigin(target: string, origin: string): boolean {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Ask the server for `desktop.json` (optional; lets a deployment advertise an update feed
 * or feature flags). Runs through the window's session so it carries cookies, and never
 * fails the window: a 404 is the normal case.
 */
export async function fetchDesktopManifest(ses: Session, url: string): Promise<DesktopManifest | null> {
  const origin = normalizeServerUrl(url);
  if (!origin) return null;
  try {
    const res = await ses.fetch(`${origin}/desktop.json`, {
      headers: { [ORBIT_HEADERS.desktop]: '1' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as DesktopManifest;
    log.info('desktop.json manifest loaded', Object.keys(body ?? {}));
    return body;
  } catch {
    return null;
  }
}

export async function createAppWindow(options: CreateAppWindowOptions): Promise<AppWindow> {
  const origin = normalizeServerUrl(options.url);
  if (!origin) throw new Error(`createAppWindow: not an http(s) URL: ${options.url}`);

  const { ses, partition } = sessionForServerUrl(origin);

  // Tell the server this is the desktop client on every request to its origin. Set here
  // (per session) rather than per-load, so navigations and fetches both carry it.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (sameOrigin(details.url, origin)) {
      details.requestHeaders[ORBIT_HEADERS.desktop] = '1';
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1c1c1c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: options.preload ?? preloadPath(),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Orbit's screen views are video; throttling a background window breaks them.
      backgroundThrottling: false,
    },
  });

  window.once('ready-to-show', () => {
    if (options.show !== false) window.show();
  });

  // A link to somewhere else opens in the user's real browser, never inside the app: the
  // renderer is a server's UI and must not be able to become a general browser.
  window.webContents.on('will-navigate', (event, target) => {
    if (sameOrigin(target, origin) || target.startsWith('file://')) return;
    event.preventDefault();
    void openExternalSafely(target);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url, origin)) void openExternalSafely(url);
    return { action: 'deny' };
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer gone', details.reason, details.exitCode);
  });

  window.on('closed', () => options.onClosed?.());

  await window.loadURL(origin);
  const manifest = await fetchDesktopManifest(ses, origin);
  return { window, session: ses, manifest, partition };
}

/** Only http(s)/mailto reach the system browser; anything else is dropped. */
export async function openExternalSafely(target: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return;
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    log.warn(`refusing to open ${parsed.protocol} externally`);
    return;
  }
  try {
    await shell.openExternal(target);
  } catch (err) {
    log.warn('openExternal failed', err);
  }
}
