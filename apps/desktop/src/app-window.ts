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
  /** The app's origin: what the window is allowed to stay on, and what it falls back to. */
  url: string;
  /**
   * The first document to load, when it is not the origin itself — a one-time sign-in link
   * (same origin) that sets the session cookie and redirects. Anything off-origin is ignored.
   */
  initialUrl?: string;
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
  // renderer is a server's UI and must not be able to become a general browser. The preload
  // bridge is attached to whatever this window loads, so both ways of leaving the origin —
  // a link (`will-navigate`) and a server redirect (`will-redirect`) — are filtered, and
  // `file://` gets no special case: it would put an arbitrary local file in a frame that can
  // call `installHermes`.
  const leaveOrigin = (event: { preventDefault: () => void }, target: string): void => {
    if (sameOrigin(target, origin)) return;
    event.preventDefault();
    log.info(`blocked navigation to ${target}; opening it in the system browser`);
    void openExternalSafely(target);
  };

  window.webContents.on('will-navigate', (event, target) => leaveOrigin(event, target));
  window.webContents.on('will-redirect', (event, target) => leaveOrigin(event, target));

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url, origin)) void openExternalSafely(url);
    return { action: 'deny' };
  });

  // `will-navigate`/`will-redirect` cover the navigations that announce themselves; a
  // 302 chain or a script-driven `location` change can still finish somewhere else. If the
  // window ends up off-origin, put it back — the app is that origin or it is nothing.
  let bouncingBack = false;
  window.webContents.on('did-finish-load', () => {
    const loaded = window.webContents.getURL();
    if (sameOrigin(loaded, origin) || bouncingBack) return;
    log.warn(`window finished loading ${loaded}, which is not ${origin}; returning to the app`);
    bouncingBack = true;
    void window
      .loadURL(origin)
      .catch((err) => log.warn('could not return the window to the app origin', err))
      .finally(() => {
        bouncingBack = false;
      });
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer gone', details.reason, details.exitCode);
  });

  window.on('closed', () => options.onClosed?.());

  // Only a same-origin document may stand in for the first load; a caller that handed us an
  // off-origin URL gets the app origin instead of a window we would have to police.
  const initialUrl =
    options.initialUrl && sameOrigin(options.initialUrl, origin) ? options.initialUrl : origin;
  await window.loadURL(initialUrl);
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
