/**
 * Electron main: decide what to open, then keep it alive.
 *
 * Launch has exactly two shapes — first-run setup, or a window onto a server — and one
 * side quest: when the server is the local Docker stack, it has to be started (and
 * health-checked) before a window is worth showing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import { ORBIT_HEADERS, ORBIT_WEB_URL_ENV } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import type { DesktopSetup, DesktopLocalStackState, ServerProbe } from './shared/api';
import { IPC } from './shared/api';
import {
  DEFAULT_LOCAL_WEB_URL,
  normalizeServerUrl,
  resolveStartupTarget,
} from './setup-config';
import { clearSetup, configureSetupStore, readSetup, writeSetup } from './setup-store';
import { LocalStackController, describeStackState } from './local-stack';
import { createAppWindow, openExternalSafely, type AppWindow } from './app-window';
import { buildAppMenu } from './app-menu';
import { dismissUpdateBar, initAutoUpdate, checkForUpdates, restartAndInstall } from './auto-update';
import { startBadge, type BadgeController } from './badge';
import { detectHermes, ensureHermesApiKey } from './hermes-setup';
import { runHermesSetup, wireMcpForServer } from './hermes-setup-window';

const log = createLogger({ scope: 'main' });
const here = path.dirname(fileURLToPath(import.meta.url));

app.setName('Orbit');

const userDataDir = app.getPath('userData');
configureSetupStore(userDataDir);

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let appSession: AppWindow | null = null;
let badge: BadgeController | null = null;
/** The URL the app window is pointing at, for Settings and the menu. */
let currentUrl: string | null = null;
let booted = false;

const stack = new LocalStackController({
  userDataDir,
  appRoot: app.getAppPath(),
  version: app.getVersion(),
  packaged: app.isPackaged,
  onState: (state) => {
    broadcast(IPC.stackState, state);
    refreshMenu();
  },
});

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* a renderer mid-teardown */
    }
  }
}

// ------------------------------------------------------------------ windows

function openSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 540,
    height: 420,
    resizable: false,
    minimizable: process.platform !== 'darwin',
    maximizable: false,
    fullscreenable: false,
    title: 'Welcome to Orbit',
    backgroundColor: '#FFFFFF',
    // Frameless on macOS (the window is a single welcome card); standard frame elsewhere
    // so Linux/Windows users keep their system close button.
    frame: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 12 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'orbit-setup',
    },
  });

  setupWindow.once('ready-to-show', () => setupWindow?.show());
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Closing setup on first run without saving means there is nothing to open.
    if (!mainWindow && !booted) app.quit();
  });
  void setupWindow.loadFile(path.join(here, 'setup.html'));
}

async function openAppWindow(url: string): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  currentUrl = url;
  appSession = await createAppWindow({
    url,
    onClosed: () => {
      mainWindow = null;
      appSession = null;
      badge?.stop();
      badge = null;
    },
  });
  mainWindow = appSession.window;
  booted = true;

  // createAppWindow already waited for the first load, so the session has cookies and
  // the badge stream can start immediately.
  badge?.stop();
  badge = startBadge({ serverUrl: url, session: appSession.session, window: appSession.window });
  refreshMenu();
}

async function closeAppWindow(): Promise<void> {
  badge?.stop();
  badge = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const win = mainWindow;
    mainWindow = null;
    appSession = null;
    win.destroy();
  }
}

// ------------------------------------------------------------------ menu

function isLocalServer(): boolean {
  if (!currentUrl) return false;
  return normalizeServerUrl(currentUrl) === normalizeServerUrl(DEFAULT_LOCAL_WEB_URL);
}

function refreshMenu(): void {
  const menu = buildAppMenu({
    stackPhase: () => stack.state().phase,
    isLocalServer,
    onChangeServer: () => void changeServer(),
    onStopStack: () => void stopStack(),
    onCheckForUpdates: () => void checkForUpdates(true),
    onOpenSettings: () => void openSettings(),
    onOpenDocs: () => void openExternalSafely('https://github.com/NousResearch/hermes-agent'),
    onShowWindow: () => mainWindow?.focus(),
  });
  Menu.setApplicationMenu(menu);
}

async function changeServer(): Promise<void> {
  clearSetup();
  await stopStack();
  await closeAppWindow();
  openSetupWindow();
}

async function stopStack(): Promise<void> {
  const state = await stack.stop();
  broadcast(IPC.stackState, state);
  refreshMenu();
}

function openSettings(): void {
  if (mainWindow && !mainWindow.isDestroyed() && currentUrl) {
    // Orbit's own settings live in the web app; the desktop menu is a shortcut to them.
    void mainWindow.loadURL(`${normalizeServerUrl(currentUrl) ?? currentUrl}/settings`);
    return;
  }
  openSetupWindow();
}

// ------------------------------------------------------------------ startup

/** A `--server=<url>` flag, for support and for pointing the app at a staging server. */
function cliServerUrl(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith('--server='));
  return arg ? arg.slice('--server='.length) : undefined;
}

async function startLocalStackOrExplain(): Promise<string | null> {
  const state = await stack.start();
  if (state.phase === 'ready' && state.webUrl) return state.webUrl;

  if (state.phase === 'docker-missing') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'Docker is required',
      detail:
        'Orbit runs its server in Docker on this computer. Install Docker Desktop, then try again. ' +
        'You can also connect to an Orbit server that is already running elsewhere.',
      buttons: ['Open Docker download', 'Choose another server', 'Quit'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) await openExternalSafely('https://www.docker.com/products/docker-desktop/');
    if (response === 1) openSetupWindow();
    else app.quit();
    return null;
  }

  if (state.phase === 'docker-not-running') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'Docker is not running',
      detail: state.error ?? 'Start Docker Desktop, then try again.',
      buttons: ['Try again', 'Choose another server', 'Quit'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) return startLocalStackOrExplain();
    if (response === 1) openSetupWindow();
    else app.quit();
    return null;
  }

  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: 'Orbit could not start',
    detail: `${describeStackState(state)}\n\n${state.error ?? ''}`.trim(),
    buttons: ['Show details', 'Choose another server', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) {
    await dialog.showMessageBox({
      message: 'Local stack details',
      detail: `Phase: ${state.phase}\nFolder: ${stack.stackDir}\n\n${state.error ?? '(no further detail)'}`,
      buttons: ['OK'],
    });
  }
  if (response === 1) openSetupWindow();
  else app.quit();
  return null;
}

/**
 * When the local stack comes up, make sure the agent harness can reach it: an API key in
 * `~/.hermes/.env`, and an `mcp_servers.orbit` entry pointing at this server.
 */
async function prepareLocalHermes(): Promise<void> {
  try {
    const status = await detectHermes(process.env);
    if (!status.found) {
      log.info('Hermes not installed; skipping MCP wiring');
      return;
    }
    ensureHermesApiKey({}, { stackEnvPath: path.join(stack.stackDir, '.env') });
    const token = stack.token();
    if (token) wireMcpForServer(token, stack.webUrl());
  } catch (err) {
    log.warn('Hermes preparation failed', err);
  }
}

async function boot(): Promise<void> {
  const saved = readSetup();
  const target = resolveStartupTarget({
    envUrl: cliServerUrl() ?? process.env[ORBIT_WEB_URL_ENV],
    saved,
    env: process.env,
  });

  if (target.kind === 'setup') {
    openSetupWindow();
    return;
  }

  const wantsLocalStack = saved?.mode === 'new';
  if (wantsLocalStack) {
    const url = await startLocalStackOrExplain();
    if (!url) return;
    await openAppWindow(url);
    void prepareLocalHermes();
    return;
  }

  await openAppWindow(target.url);
}

// ------------------------------------------------------------------ IPC

function registerIpc(): void {
  ipcMain.handle(IPC.stackGet, () => stack.state());
  ipcMain.handle(IPC.stackStart, async () => {
    const state = await stack.start();
    if (state.phase === 'ready' && state.webUrl) await openAppWindow(state.webUrl);
    return state;
  });
  ipcMain.handle(IPC.stackStop, () => stack.stop());

  ipcMain.handle(IPC.setupGet, () => readSetup());
  ipcMain.handle(IPC.setupSave, (_event, setup: DesktopSetup) => {
    writeSetup(userDataDir, setup);
    const saved = readSetup();
    refreshMenu();
    return saved;
  });
  ipcMain.handle(IPC.setupClear, () => {
    clearSetup();
  });

  ipcMain.handle(IPC.setupProbe, async (_event, input: string): Promise<ServerProbe> => {
    const origin = normalizeServerUrl(input);
    if (!origin) return { ok: false, error: 'That does not look like a URL.' };
    try {
      // Probing from main avoids CORS and the setup window's file:// origin entirely.
      const res = await fetch(`${origin}/api/health`, {
        headers: { [ORBIT_HEADERS.desktop]: '1' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { ok: false, error: `${origin} answered HTTP ${res.status}` };
      const body = (await res.json()) as { ok?: boolean; version?: string; engine?: string };
      if (body?.ok === false) return { ok: false, error: `${origin} is not healthy` };
      return { ok: true, version: body.version, engine: body.engine };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not reach ${origin}: ${message}` };
    }
  });

  ipcMain.on(IPC.setupComplete, () => {
    if (setupWindow && !setupWindow.isDestroyed()) {
      const win = setupWindow;
      setupWindow = null;
      win.destroy();
    }
    void boot().catch((err) => {
      log.error('boot after setup failed', err);
      void dialog.showMessageBox({ message: 'Orbit could not start', detail: String(err), buttons: ['Quit'] }).then(
        () => app.quit(),
      );
    });
  });

  ipcMain.handle(IPC.hermesStatus, () => detectHermes(process.env));
  ipcMain.handle(IPC.hermesInstall, async (event) => {
    try {
      const status = await runHermesSetup(event.sender);
      return status;
    } catch (err) {
      log.error('Hermes install failed', err);
      throw err;
    }
  });
  ipcMain.handle(IPC.hermesWireMcp, (_event, token: string) => {
    const url = stack.webUrl();
    const result = wireMcpForServer(String(token ?? ''), url);
    if (!result.ok) throw new Error(result.error ?? 'could not wire MCP');
  });

  ipcMain.handle(IPC.updateCheck, () => checkForUpdates(true));
  ipcMain.handle(IPC.updateInstall, () => restartAndInstall());
  ipcMain.on(IPC.noticeDismiss, () => dismissUpdateBar());
  ipcMain.handle(IPC.openExternal, (_event, url: string) => openExternalSafely(String(url ?? '')));
}

// ------------------------------------------------------------------ smoke test

/**
 * `ORBIT_SMOKE=1 electron .` loads the real setup window off-screen, checks that the
 * preload bridge is present, prints what it found and exits. CI and the packaging job use
 * it to prove the bundle, the HTML and the preload path all agree — without a visible
 * window.
 */
async function runSmokeTest(): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    width: 540,
    height: 420,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'orbit-smoke',
    },
  });
  try {
    await win.loadFile(path.join(here, 'setup.html'));
    const report = (await win.webContents.executeJavaScript(`(() => ({
      title: document.title,
      hasBridge: typeof window.orbitDesktop === 'object' && window.orbitDesktop !== null,
      bridgeKeys: window.orbitDesktop ? Object.keys(window.orbitDesktop).sort() : [],
      platform: window.orbitDesktop ? window.orbitDesktop.platform : null,
      screens: document.querySelectorAll('.screen').length,
      radios: document.querySelectorAll('input[name="mode"]').length,
      continueDisabled: document.getElementById('continue') ? document.getElementById('continue').disabled : null,
    }))()`)) as Record<string, unknown>;
    // Resolved in main, where process.resourcesPath and the stack controller live.
    const resources = stack.resourceDir();
    Object.assign(report, {
      packaged: app.isPackaged,
      stackResourceDir: resources,
      stackComposePresent: fs.existsSync(path.join(resources, 'docker-compose.yml')),
      stackEnvExamplePresent: fs.existsSync(path.join(resources, '.env.example')),
    });
    console.log(`[orbit-smoke] ${JSON.stringify(report)}`);

    // Optional visual check: composite the window invisibly, then save what it drew.
    const shotPath = process.env.ORBIT_SMOKE_SCREENSHOT;
    if (shotPath) {
      win.setOpacity(0);
      win.showInactive();
      await new Promise((r) => setTimeout(r, 600));
      const image = await win.webContents.capturePage();
      fs.writeFileSync(shotPath, image.toPNG());
      console.log(`[orbit-smoke] screenshot ${shotPath} (${image.getSize().width}x${image.getSize().height})`);

      // ...and the Hermes step, which is only reachable after a failed detection.
      await win.webContents.executeJavaScript(`(() => {
        document.getElementById('screen-server').hidden = true;
        document.getElementById('screen-hermes').hidden = false;
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 250));
      const second = await win.webContents.capturePage();
      const hermesPath = shotPath.replace(/\.png$/, '.hermes.png');
      fs.writeFileSync(hermesPath, second.toPNG());
      console.log(`[orbit-smoke] screenshot ${hermesPath} (${second.getSize().width}x${second.getSize().height})`);

      // The "existing instance" state: URL row revealed, Continue still disabled until a
      // probe passes.
      await win.webContents.executeJavaScript(`(() => {
        document.getElementById('screen-hermes').hidden = true;
        document.getElementById('screen-server').hidden = false;
        const radio = document.querySelector('input[value="existing"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        const input = document.getElementById('server-url');
        input.value = 'https://orbit.example.com';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return document.getElementById('continue').disabled;
      })()`).then((disabled) => console.log(`[orbit-smoke] existing-mode continue disabled: ${disabled}`));
      await new Promise((r) => setTimeout(r, 250));
      const third = await win.webContents.capturePage();
      const existingPath = shotPath.replace(/\.png$/, '.existing.png');
      fs.writeFileSync(existingPath, third.toPNG());
      console.log(`[orbit-smoke] screenshot ${existingPath} (${third.getSize().width}x${third.getSize().height})`);
    }
    if (!report.hasBridge) {
      console.error('[orbit-smoke] FAIL: preload bridge missing');
      app.exit(1);
      return;
    }
    console.log('[orbit-smoke] ok');
    app.exit(0);
  } catch (err) {
    console.error('[orbit-smoke] FAIL', err);
    app.exit(1);
  }
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.focus();
    }
  });

  app.whenReady().then(
    () => {
      registerIpc();
      if (process.env.ORBIT_SMOKE === '1') {
        void runSmokeTest();
        return;
      }
      refreshMenu();
      initAutoUpdate({
        preloadPath: path.join(here, 'preload.cjs'),
      });
      void boot().catch((err) => {
        log.error('boot failed', err);
        void dialog.showMessageBox({
          type: 'error',
          message: 'Orbit could not start',
          detail: err instanceof Error ? err.message : String(err),
          buttons: ['Quit'],
        });
      });
    },
    (err) => {
      log.error('app.whenReady rejected', err);
      app.quit();
    },
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void boot();
  });

  app.on('window-all-closed', () => {
    // The local stack keeps running (containers survive a quit on purpose: Stop Local
    // Stack is the explicit action). macOS keeps the app in the dock.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Abort an in-flight start; never block quit on `docker compose down`.
    stack.abort();
    badge?.stop();
    badge = null;
    dismissUpdateBar();
  });
}

/** Exposed for the E2E harness: the app's stack folder and current target. */
export const __testing = {
  stackDir: () => stack.stackDir,
  currentUrl: () => currentUrl,
  state: (): DesktopLocalStackState => stack.state(),
  userDataDir,
};
