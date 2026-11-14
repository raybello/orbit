/**
 * Electron main: decide what to open, then keep it alive.
 *
 * Launch has exactly two shapes — first-run setup, or a window onto a server — and one
 * side quest: when the server is the local Docker stack, it has to be started (and
 * health-checked) before a window is worth showing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
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
import { NativeStackController, describeNativeState } from './native-stack';
import { nativeStackEligible, readServerManifest, SERVER_BUNDLE_FILE } from './mac-runtime';
import { chooseStack, dockerDataExists, moveAccepted, readStackChoice, writeStackChoice, type StackChoice } from './docker-move';
import { runDocker } from './docker-cli';
import type { StackController, StackKind } from './stack-controller';
import { createAppWindow, openExternalSafely, sessionForServerUrl, type AppWindow } from './app-window';
import { buildAppMenu } from './app-menu';
import { dismissUpdateBar, initAutoUpdate, checkForUpdates, restartAndInstall } from './auto-update';
import { startBadge, type BadgeController } from './badge';
import { detectHermes, ensureHermesApiKey } from './hermes-setup';
import { runHermesSetup, wireMcpForServer } from './hermes-setup-window';
import { DEFAULT_OWNER_EMAIL, ensureDesktopSession } from './desktop-session';
import { describeSender, isTrustedPage } from './ipc-guard';

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
/** Set once `boot()` has picked a controller, so re-activating the app does not re-ask. */
let stackSelected = false;

/**
 * Which controller this machine runs. Docker everywhere by default; an eligible Mac with a
 * `server-bundle.json` may run the native one instead (see `selectStackController`).
 */
function onStackState(state: DesktopLocalStackState): void {
  broadcast(IPC.stackState, state);
  refreshMenu();
}

function dockerStack(): StackController {
  return new LocalStackController({
    userDataDir,
    appRoot: app.getAppPath(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    onState: onStackState,
  });
}

function nativeStack(manifest: NonNullable<ReturnType<typeof readServerManifest>>): StackController {
  return new NativeStackController({
    userDataDir,
    manifest,
    // The Electron binary doubles as Node for the supervised server processes.
    electronBinary: process.execPath,
    onState: onStackState,
  });
}

/** Starts as Docker so IPC, the menu and the smoke test always have a controller. */
let stack: StackController = dockerStack();

function stackKind(): StackKind {
  return stack.kind ?? 'docker';
}

/** Electron's `Resources/` — where `extraResources` puts `server-bundle.json`. */
function resourcesDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath ?? path.join(path.dirname(process.execPath), '..', 'Resources');
}

function bundledManifestPath(): string {
  return path.join(resourcesDir(), SERVER_BUNDLE_FILE);
}

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

/**
 * Open the app window on `url`.
 *
 * `initialUrl` is the first document to load when it differs from the app's own origin — the
 * one-time sign-in link, which sets the session cookie and redirects. Everything after that
 * (the badge, Settings, the menu) talks to `url`.
 */
async function openAppWindow(url: string, initialUrl?: string): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  currentUrl = url;
  appSession = await createAppWindow({
    url,
    initialUrl,
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
  const desired = normalizeServerUrl(currentUrl);
  if (!desired) return false;
  // The native stack listens on an allocated port, so ask the controller rather than
  // comparing against the Docker stack's fixed default.
  return desired === normalizeServerUrl(DEFAULT_LOCAL_WEB_URL) || desired === normalizeServerUrl(stack.webUrl());
}

/** True only where the native stack is both possible and installable. */
function nativeStackAvailable(): boolean {
  return nativeStackEligible() && readServerManifest(bundledManifestPath()) !== null;
}

function refreshMenu(): void {
  const menu = buildAppMenu({
    stackPhase: () => stack.state().phase,
    stackKind,
    nativeAvailable: nativeStackAvailable,
    isLocalServer,
    onChangeServer: () => void changeServer(),
    onStopStack: () => void stopStack(),
    onSwitchStack: (choice) => void switchStack(choice),
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

// ------------------------------------------------------------------ stack choice

/**
 * The "Run Orbit without Docker?" dialog, shown once when an eligible Mac already has a
 * Docker stack with data in it.
 */
async function askToSwitchToNative(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Run Orbit without Docker?',
    detail:
      'This Mac supports a faster, Docker-free mode.\n\n' +
      'Your bots and data will be copied over.\n\n' +
      'Docker must be running to copy your data.',
    buttons: ['Keep Docker', 'Switch (recommended)'],
    defaultId: 1,
    cancelId: 0,
  });
  return response === 1;
}

/** Copy the Docker stack's data out. Returns false (and says why) when it cannot. */
async function performNativeMove(): Promise<boolean> {
  const result = await moveAccepted({
    userDataDir,
    env: process.env,
    exec: (binary, args, opts) => runDocker(binary, args, opts),
    progress: (line) => log.info(`switch to native: ${line}`),
  });
  if (result.ok) return true;
  await dialog.showMessageBox({
    type: 'warning',
    message: 'Could not switch to the Docker-free mode',
    detail: `${result.error ?? 'The copy failed.'}\n\nOrbit will keep using Docker.`,
    buttons: ['OK'],
  });
  return false;
}

/**
 * Phase 6-E: pick the controller for this launch.
 *
 * `ORBIT_FORCE_STACK=docker|native` exists for support and for CI: `docker` short-circuits
 * everything, `native` skips the first-run question. A missing or invalid
 * `server-bundle.json` never quietly becomes a native stack — without the bundle there is
 * nothing to run.
 */
async function selectStackController(opts: { interactive?: boolean } = {}): Promise<StackController> {
  const forced = process.env.ORBIT_FORCE_STACK?.trim().toLowerCase();
  if (forced && forced !== 'docker' && forced !== 'native') {
    log.warn(`ignoring ORBIT_FORCE_STACK=${forced} (expected docker or native)`);
  }
  if (forced === 'docker') {
    log.info('ORBIT_FORCE_STACK=docker: using the Docker stack');
    return dockerStack();
  }

  const manifestFile = bundledManifestPath();
  const manifest = readServerManifest(manifestFile);
  const eligible = nativeStackEligible();
  if (!eligible || !manifest) {
    const why = !eligible ? 'this Mac is not eligible' : `${manifestFile} is missing or invalid`;
    if (forced === 'native') log.warn(`ORBIT_FORCE_STACK=native ignored: ${why}`);
    else log.info(`native stack unavailable: ${why}`);
    return dockerStack();
  }

  const decision =
    forced === 'native' || opts.interactive === false
      ? { choice: (readStackChoice(userDataDir) ?? 'native') as StackChoice, reason: 'saved' as const, moveRequired: false }
      : await chooseStack({
          userDataDir,
          eligible: true,
          dockerDataExists: () => dockerDataExists({ userDataDir, exec: (b, a, o) => runDocker(b, a, o) }),
          confirmSwitch: askToSwitchToNative,
        });

  if (decision.choice === 'docker') {
    log.info(`stack: docker (${decision.reason})`);
    return dockerStack();
  }

  if (decision.moveRequired && !(await performNativeMove())) return dockerStack();

  log.info(`stack: native ${manifest.version} (${decision.reason})`);
  return nativeStack(manifest);
}

/**
 * The menu's Switch to Docker… / Switch to Native…: record the choice, restart on it.
 *
 * Switching back to Docker does not copy the native database back — Docker's volumes still
 * hold the pre-switch data, and the native files stay on disk so switching forward again
 * picks up where it left off.
 */
async function switchStack(choice: StackChoice): Promise<void> {
  if (!nativeStackAvailable()) return;
  if (stackKind() === choice) return;

  const nativeDb = path.join(userDataDir, 'orbit.db');
  if (choice === 'native') {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: 'Switch to the Docker-free stack?',
      detail: fs.existsSync(nativeDb)
        ? 'Orbit will restart on its native stack, using the data already in this Mac’s app folder.'
        : 'Docker must be running so Orbit can copy your bots and data out of it first.',
      buttons: ['Cancel', 'Switch to Native'],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) return;
    if (!fs.existsSync(nativeDb)) {
      if (!(await performNativeMove())) return;
    } else {
      writeStackChoice(userDataDir, 'native');
    }
  } else {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: 'Switch back to Docker?',
      detail:
        'Orbit will restart in Docker mode, using the data in Docker’s volumes (as it was when you switched away). ' +
        'The native copy stays on disk.',
      buttons: ['Cancel', 'Switch to Docker'],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) return;
    writeStackChoice(userDataDir, 'docker');
  }

  await stopStack();
  await closeAppWindow();
  stackSelected = false;
  await boot();
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
  const native = stackKind() === 'native';
  if ((state.phase === 'ready' || state.phase === 'running') && state.webUrl) return state.webUrl;

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
    message: native ? 'Orbit could not start its native stack' : 'Orbit could not start',
    detail: `${native ? describeNativeState(state) : describeStackState(state)}\n\n${state.error ?? ''}`.trim(),
    buttons: ['Show details', 'Choose another server', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) {
    await dialog.showMessageBox({
      message: native ? 'Native stack details' : 'Local stack details',
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
 *
 * The key itself is mirrored into the stack `.env` *before* `compose up` (see
 * `mirrorHermesKey`) — a container reads its environment once, at start, so writing it here
 * would leave the running server without a key until the next restart.
 */
async function prepareLocalHermes(): Promise<void> {
  try {
    const status = await detectHermes(process.env);
    if (!status.found) {
      log.info('Hermes not installed; skipping MCP wiring');
      return;
    }
    const token = stack.token();
    if (token) wireMcpForServer(token, stack.webUrl());
  } catch (err) {
    log.warn('Hermes preparation failed', err);
  }
}

/**
 * Put HERMES_KEY in the stack `.env` before the stack starts.
 *
 * Runs ahead of `stack.start()`: `docker compose up` hands the container its environment at
 * creation time, so the server would never see a key written afterwards.
 */
function mirrorHermesKey(): void {
  try {
    const envPath = stack.prepareEnvFile?.() ?? path.join(stack.stackDir, '.env');
    ensureHermesApiKey({}, { stackEnvPath: envPath });
  } catch (err) {
    log.warn('could not mirror HERMES_KEY into the stack env before starting', err);
  }
}

/**
 * The URL the app window should open on a local stack, signing in first when it has to.
 *
 * A bundled stack ships `DEV_LOGIN=0` and no Composio key, so its own sign-in screen has
 * nothing that works. The main process mints a one-time owner link instead (see
 * `desktop-session.ts`) and loads it; from the second launch on, `/api/auth/me` already has
 * a session and the window opens on the bare origin.
 */
async function localStackEntryUrl(webUrl: string, setup: DesktopSetup | null): Promise<string> {
  const email = setup?.email ?? DEFAULT_OWNER_EMAIL;
  // Ask through the app window's own partition: its cookie jar is where a session from a
  // previous launch lives, and asking with the global `fetch` would look cookie-less every
  // time and mint a new link on every start.
  const { ses } = sessionForServerUrl(webUrl);
  const result = await ensureDesktopSession({
    webUrl,
    sessionSecret: stack.sessionSecret?.() ?? null,
    email,
    fetchImpl: ses.fetch.bind(ses) as unknown as typeof fetch,
  });
  if (result.status === 'failed') {
    // Not fatal: the window still opens, and the server's own sign-in screen is the fallback.
    log.warn(`could not sign in to the local stack: ${result.error}`);
    return webUrl;
  }
  if (setup && !setup.email) {
    try {
      // Keep the identity stable across launches: new users are created per email.
      writeSetup(userDataDir, { ...setup, email: result.email });
    } catch (err) {
      log.warn('could not persist the stack identity in setup.json', err);
    }
  }
  return result.status === 'signed-in' ? result.url : webUrl;
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
    if (!stackSelected) {
      stack = await selectStackController();
      stackSelected = true;
      refreshMenu();
    }
    // Before `compose up`: the container reads HERMES_KEY from its environment at start.
    mirrorHermesKey();
    const url = await startLocalStackOrExplain();
    if (!url) return;
    const entryUrl = await localStackEntryUrl(url, saved);
    await openAppWindow(url, entryUrl);
    void prepareLocalHermes();
    return;
  }

  await openAppWindow(target.url);
}

// ------------------------------------------------------------------ IPC

/** The setup window's document: the only `file://` page whose calls we trust. */
function setupFileUrl(): string {
  return pathToFileURL(path.join(here, 'setup.html')).href;
}

/**
 * Is this call coming from a page we ship?
 *
 * The app window carries the whole preload bridge wherever it is pointed, so a server the
 * user merely connected to ("existing instance") could otherwise drive Docker, rewrite
 * `~/.hermes/config.yaml` or replace the setup file. Only the setup window's own document
 * and the local stack's origin pass (see `ipc-guard.ts`).
 */
function senderTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const stackWebUrl = stack.webUrl();
  const pageUrl = event.senderFrame?.url ?? '';
  if (isTrustedPage({ pageUrl, stackWebUrl, setupFileUrl: setupFileUrl() })) return true;
  log.warn(`rejected a mutating IPC call from ${describeSender(pageUrl, stackWebUrl)}`);
  return false;
}

/** Throwing variant for `ipcMain.handle`, where the renderer gets the error back. */
function assertSender(event: IpcMainInvokeEvent): void {
  if (!senderTrusted(event)) throw new Error('not allowed from this page');
}

function registerIpc(): void {
  // Read-only: any window may ask what the stack is doing.
  ipcMain.handle(IPC.stackGet, () => stack.state());
  ipcMain.handle(IPC.stackStart, async (event) => {
    assertSender(event);
    const state = await stack.start();
    if ((state.phase === 'ready' || state.phase === 'running') && state.webUrl) {
      await openAppWindow(state.webUrl, await localStackEntryUrl(state.webUrl, readSetup()));
    }
    return state;
  });
  ipcMain.handle(IPC.stackStop, (event) => {
    assertSender(event);
    return stack.stop();
  });

  ipcMain.handle(IPC.setupGet, () => readSetup());
  ipcMain.handle(IPC.setupSave, (event, setup: DesktopSetup) => {
    assertSender(event);
    writeSetup(userDataDir, setup);
    const saved = readSetup();
    refreshMenu();
    return saved;
  });
  ipcMain.handle(IPC.setupClear, (event) => {
    assertSender(event);
    clearSetup();
  });

  ipcMain.handle(IPC.setupProbe, async (event, input: string): Promise<ServerProbe> => {
    assertSender(event);
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

  // `on`, not `handle`: a rejection here is a log line, not an exception in the main process.
  ipcMain.on(IPC.setupComplete, (event) => {
    if (!senderTrusted(event)) return;
    if (setupWindow && !setupWindow.isDestroyed()) {
      const win = setupWindow;
      setupWindow = null;
      win.destroy();
    }
    void boot()
      .then(() => {
        // The setup window is gone; if boot produced nothing, the person is looking at an app with
        // no window (which is how a first run can appear to "just quit"). Put the setup window back
        // with the reason instead of leaving a blank desktop.
        if (!mainWindow && !setupWindow) {
          log.warn('setup finished but no window opened; reopening setup');
          openSetupWindow();
        }
      })
      .catch((err) => {
        log.error('boot after setup failed', err);
        void dialog
          .showMessageBox({
            type: 'error',
            message: 'Orbit could not start',
            detail: String(err instanceof Error ? err.message : err),
            buttons: ['Back to setup'],
          })
          .then(() => openSetupWindow());
      });
  });

  ipcMain.handle(IPC.hermesStatus, () => detectHermes(process.env));
  ipcMain.handle(IPC.hermesInstall, async (event) => {
    assertSender(event);
    try {
      const status = await runHermesSetup(event.sender);
      return status;
    } catch (err) {
      log.error('Hermes install failed', err);
      throw err;
    }
  });
  ipcMain.handle(IPC.hermesWireMcp, (event, token: string) => {
    assertSender(event);
    const url = stack.webUrl();
    const result = wireMcpForServer(String(token ?? ''), url);
    if (!result.ok) throw new Error(result.error ?? 'could not wire MCP');
  });

  ipcMain.handle(IPC.updateCheck, (event) => {
    assertSender(event);
    return checkForUpdates(true);
  });
  ipcMain.handle(IPC.updateInstall, (event) => {
    assertSender(event);
    return restartAndInstall();
  });
  // Only closes the in-app update bar: harmless wherever the page came from, and the bar
  // itself lives in the app window, so guarding it would leave it stuck open.
  ipcMain.on(IPC.noticeDismiss, () => dismissUpdateBar());
  ipcMain.handle(IPC.openExternal, (event, url: string) => {
    assertSender(event);
    return openExternalSafely(String(url ?? ''));
  });
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
    // The Docker stack's resource dir is the native stack's *absence*, so report both.
    const resources =
      stack instanceof LocalStackController ? stack.resourceDir() : path.join(resourcesDir(), 'stack');
    if (process.env.ORBIT_FORCE_STACK) {
      // Exercise the override for real: `docker` returns without any dialog.
      stack = await selectStackController({ interactive: false });
    }
    refreshMenu();
    const serverMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Server');
    Object.assign(report, {
      packaged: app.isPackaged,
      stackKind: stackKind(),
      // The menu is rebuilt on every state change; this is the Server menu as the user sees it.
      serverMenu: (serverMenu?.submenu?.items ?? []).map((item) =>
        item.type === 'separator' ? '----' : `${item.label}${item.enabled ? '' : ' (disabled)'}`,
      ),
      forcedStack: process.env.ORBIT_FORCE_STACK ?? null,
      nativeEligible: nativeStackEligible(),
      serverBundlePresent: fs.existsSync(bundledManifestPath()),
      nativeStackAvailable: nativeStackAvailable(),
      stackResourceDir: resources,
      stackComposePresent: fs.existsSync(path.join(resources, 'docker-compose.yml')),
      stackEnvExamplePresent: fs.existsSync(path.join(resources, '.env.example')),
    });
    console.log(`[orbit-smoke] ${JSON.stringify(report)}`);

    /**
     * The renderer check: load the app itself (ORBIT_SMOKE_APP_URL, a running Orbit server)
     * and prove the web build does not draw window dots inside the desktop shell. The OS
     * draws them here, so a second drawn set is exactly the "duplicated controls" bug.
     */
    const appUrl = process.env.ORBIT_SMOKE_APP_URL?.trim();
    if (appUrl) {
      const appWin = new BrowserWindow({
        show: false,
        width: 1280,
        height: 860,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: 'orbit-smoke-app',
        },
      });
      try {
        await appWin.loadURL(appUrl);
        // Let the shell paint (the app renders after its first API round-trip).
        await new Promise((r) => setTimeout(r, 1500));
        const chrome = (await appWin.webContents.executeJavaScript(`(() => ({
          url: location.href,
          userAgentHasElectron: /Electron\\//.test(navigator.userAgent),
          drawnWindowDots: document.querySelectorAll('.traffic-lights').length,
          shell: document.querySelector('.app') ? 'app' : document.querySelector('.signin') ? 'signin' : 'unknown',
        }))()`)) as Record<string, unknown>;
        console.log(`[orbit-smoke] app ${JSON.stringify(chrome)}`);
        if (chrome.drawnWindowDots !== 0) {
          throw new Error(
            `the web build drew ${chrome.drawnWindowDots} window-dot group(s) inside the desktop shell; ` +
              'the OS controls are already there (see hasNativeWindowControls in apps/web).',
          );
        }
        if (chrome.userAgentHasElectron !== true) {
          throw new Error('the smoke window did not present an Electron user agent');
        }
      } finally {
        appWin.destroy();
      }
    }

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

// A second profile in one machine (the smoke harness, a test run, a support check) must not
// fight the running app for the single-instance lock, which is keyed on userData.
const userDataOverride = process.env.ORBIT_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

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
    // A native stack's children would outlive us as orphans, so kill them now.
    stack.dispose?.();
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
