/**
 * Electron main: decide what to open, then keep it alive.
 *
 * A local Docker stack must be started and health-checked before a window is worth showing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent, type MediaAccessPermissionRequest, type Session } from 'electron';
import { DEEP_LINK_SCHEME, ORBIT_HEADERS, ORBIT_WEB_URL_ENV, type DeepLink, type DesktopGpuVoice } from '@orbit/contracts';
import { gpuVoiceSupport } from './gpu-voice';
import { createLogger } from '@orbit/logger';
import type { DesktopSetup, DesktopLocalStackState, LaunchAction, LaunchChoice, LaunchOptions, LaunchStatus, ServerProbe, StackKind } from './shared/api';
import { IPC } from './shared/api';
import {
  DEFAULT_LOCAL_WEB_URL,
  normalizeServerUrl,
  resolveStartupTarget,
} from './setup-config';
import { clearSetup, configureSetupStore, readSetup, writeSetup } from './setup-store';
import { LocalStackController, describeStackState } from './local-stack';
import { NativeStackController, describeNativeState } from './native-stack';
import { ineligibilityReason, nativeStackEligible, readServerManifest, SERVER_BUNDLE_FILE } from './mac-runtime';
import { installDockerDesktop } from './docker-install';
import { openProgressWindow } from './progress-window';
import { chooseStack, dockerDataExists, moveAccepted, readStackChoice, writeStackChoice } from './docker-move';
import { resolveDockerBinary, runDocker } from './docker-cli';
import type { DockerStack, NativeStack, StackController } from './stack-controller';
import { createAppWindow, openExternalSafely, sessionForServerUrl, type AppWindow } from './app-window';
import { buildAppMenu } from './app-menu';
import { checkForUpdates, downloadUpdate, initAutoUpdate, restartAndInstall, updateStatus } from './auto-update';
import { startBadge, type BadgeController } from './badge';
import { detectHermes, installHermes } from './hermes-setup';
import { DEFAULT_OWNER_EMAIL, ensureDesktopSession } from './desktop-session';
import { describeSender, isTrustedPage } from './ipc-guard';
import { createDeepLinkInbox, deepLinkFromArgv } from './deep-links';
import { installLogFile } from './log-file';

const log = createLogger({ scope: 'main' });
const here = path.dirname(fileURLToPath(import.meta.url));

app.setName('Orbit');

/**
 * Returns the app icon for use in BrowserWindow on Windows/Linux dev builds.
 * Packaged builds get the icon from the .exe / AppImage automatically; macOS
 * uses `app.dock.setIcon` instead, so this returns `undefined` there.
 */
function devWindowIcon(): Electron.NativeImage | undefined {
  if (app.isPackaged || process.platform === 'darwin') return undefined;
  const icon = nativeImage.createFromPath(path.join(here, '..', 'assets', 'icon.png'));
  return icon.isEmpty() ? undefined : icon;
}

// A second profile on one machine (the smoke harness, a test run, a support check) must not
// fight the running app for the single-instance lock, which is keyed on userData, nor share its
// setup, stack folder or data. So the override is applied before anything reads the path.
const userDataOverride = process.env.ORBIT_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));
// A separate profile keeps its log beside its data, so two profiles never interleave one file.
const logFile = installLogFile(userDataOverride ? path.join(app.getPath('userData'), 'logs') : app.getPath('logs'));

const userDataDir = app.getPath('userData');
configureSetupStore(userDataDir);

let mainWindow: BrowserWindow | null = null;
/** The window a person sees until the app window is up: first-run choices, then the start. */
let launchWindow: BrowserWindow | null = null;
let launchView: LaunchStatus['view'] = 'choose';
/** A failure after the stack came up (the app window could not load it), drawn as a failed start. */
let launchFailure: string | null = null;
let launchNote: string | undefined;
let appSession: AppWindow | null = null;
let badge: BadgeController | null = null;
let currentUrl: string | null = null;
/** Set once `boot()` has picked a controller, so re-activating the app does not re-ask. */
let stackSelected = false;
const deepLinks = createDeepLinkInbox();

function onStackState(): void {
  pushLaunchStatus();
  refreshMenu();
}

function launchStatus(): LaunchStatus {
  const state = stack.state();
  return {
    view: launchView,
    kind: stack.kind,
    state: launchFailure ? { ...state, phase: 'failed', error: launchFailure } : state,
    nativeAvailable: stack.kind === 'docker' && nativeStackAvailable(),
    note: launchNote,
  };
}

function pushLaunchStatus(): void {
  if (launchWindow && !launchWindow.isDestroyed()) launchWindow.webContents.send(IPC.launchStatus, launchStatus());
}

function dockerStack(): DockerStack {
  return new LocalStackController({
    userDataDir,
    appRoot: app.getAppPath(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    onState: onStackState,
  });
}

function nativeStack(manifest: NonNullable<ReturnType<typeof readServerManifest>>): NativeStack {
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
  return stack.kind;
}

/** Electron's `Resources/` — where `extraResources` puts `server-bundle.json`. */
function resourcesDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath ?? path.join(path.dirname(process.execPath), '..', 'Resources');
}

function bundledManifestPath(): string {
  return path.join(resourcesDir(), SERVER_BUNDLE_FILE);
}

/**
 * The stack resources this build shipped, for the smoke test's presence checks. The native
 * stack ships no compose files at all, so its answer is the folder the Docker stack stages
 * from — which is the point of the report: a native build has none of them.
 */
function stackResourceDir(controller: StackController): string {
  switch (controller.kind) {
    case 'docker':
      return controller.resourceDir();
    case 'native':
      return path.join(resourcesDir(), 'stack');
  }
}

// ------------------------------------------------------------------ windows

function openLaunchWindow(): void {
  if (launchWindow && !launchWindow.isDestroyed()) {
    pushLaunchStatus();
    launchWindow.show();
    launchWindow.focus();
    return;
  }

  launchWindow = new BrowserWindow({
    width: 540,
    height: 440,
    resizable: false,
    minimizable: process.platform !== 'darwin',
    maximizable: false,
    fullscreenable: false,
    title: 'Orbit',
    backgroundColor: '#FFFFFF',
    // Frameless on macOS (the window is a single card); standard frame elsewhere so Linux and
    // Windows users keep their system close button.
    frame: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 12 } : undefined,
    icon: devWindowIcon(),
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'orbit-setup',
    },
  });

  launchWindow.once('ready-to-show', () => launchWindow?.show());
  launchWindow.on('closed', () => {
    launchWindow = null;
    // With no app window behind it, closing the launch window is how a person cancels.
    if (!mainWindow) quitApp('launch window closed');
  });
  void launchWindow.loadFile(path.join(here, 'setup.html'));
}

/** The app window is up: the launch window has done its job. */
function closeLaunchWindow(): void {
  const win = launchWindow;
  launchWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

/**
 * The main window may use the microphone, the camera and screen capture — and nothing else.
 *
 * `app-window` installs a deliberately narrow policy on every session it creates (microphone
 * only). Installing this afterwards replaces that policy on the app's own session; the setup
 * window keeps its separate `orbit-setup` partition, so a welcome card can never ask for a
 * camera. Keeping the allowlist here rather than widening the shared installer leaves the
 * setup window's stricter policy intact.
 */
const APP_PERMISSIONS = new Set(['media', 'display-capture', 'fullscreen']);

function installDevicePermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (!APP_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }
    // Only getUserMedia is gated by Apple's TCC hardware switch; screen capture prompts on
    // its own when the capture starts, and fullscreen needs no dialog at all.
    if (process.platform !== 'darwin' || permission !== 'media') {
      callback(true);
      return;
    }
    void askForMacMediaAccess(details as MediaAccessPermissionRequest)
      .then((granted) => callback(granted))
      .catch(() => callback(true));
  });

  // `navigator.permissions.query({name:'microphone'})` reads this handler. Without it every
  // device answers "denied" before a request is ever made, even though the handler above
  // would grant it, and the settings page would show a lie.
  ses.setPermissionCheckHandler((_webContents, permission) => APP_PERMISSIONS.has(permission));
}

/**
 * Ask macOS for the microphone and/or camera the renderer's request names.
 *
 * Electron reports getUserMedia as one `media` permission with `mediaTypes`; a request with no
 * types is the older microphone-and-camera pair. `askForMediaAccess` only shows the OS dialog
 * the first time — later calls resolve from the stored decision, which is what we want.
 */
async function askForMacMediaAccess(details: MediaAccessPermissionRequest): Promise<boolean> {
  const types = details.mediaTypes ?? [];
  const wantsAudio = types.length === 0 || types.includes('audio');
  const wantsVideo = types.length === 0 || types.includes('video');
  const answers: boolean[] = [];
  if (wantsAudio) answers.push(await systemPreferences.askForMediaAccess('microphone'));
  if (wantsVideo) answers.push(await systemPreferences.askForMediaAccess('camera'));
  return answers.every(Boolean);
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
    icon: devWindowIcon(),
    onClosed: () => {
      mainWindow = null;
      appSession = null;
      badge?.stop();
      badge = null;
    },
  });
  mainWindow = appSession.window;
  // createAppWindow installs the shared narrow policy; this widens the app's own session to
  // the media surface after it, and never touches the setup window's partition.
  installDevicePermissions(appSession.session);

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

function nativeStackAvailable(): boolean {
  return nativeStackEligible() && readServerManifest(bundledManifestPath()) !== null;
}

function refreshMenu(): void {
  const menu = buildAppMenu({
    stackPhase: () => stack.state().phase,
    stackKind,
    nativeAvailable: nativeStackAvailable,
    isLocalServer,
    onChangeServer: () => void showChoices(),
    onStopStack: () => void stopStack(),
    onSwitchStack: (choice) => void switchStack(choice),
    onCheckForUpdates: () => {
      void checkForUpdates();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.send(IPC.updateOpen);
      }
    },
    onOpenSettings: () => void openSettings(),
    onOpenDocs: () => void openExternalSafely('https://github.com/NousResearch/hermes-agent'),
    onShowWindow: () => mainWindow?.focus(),
  });
  Menu.setApplicationMenu(menu);
}

/** Back to the first screen. The launch window opens before the app window goes, so there is never none. */
async function showChoices(): Promise<void> {
  clearSetup();
  launchView = 'choose';
  launchFailure = null;
  openLaunchWindow();
  await stopStack();
  await closeAppWindow();
  pushLaunchStatus();
}

async function stopStack(): Promise<void> {
  await stack.stop();
  refreshMenu();
}

// ------------------------------------------------------------------ stack choice

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

/**
 * Copy the Docker stack's bots and data out for the native stack. The copy runs inside the api
 * container, so when Docker's stack is not up it is started for the copy (behind the launch
 * window's progress) and stopped again after, its volume kept. On success the choice is native.
 */
async function performNativeMove(): Promise<boolean> {
  const docker = stack.kind === 'docker' ? stack : (stack = dockerStack());
  launchNote = 'Starting Docker once to copy your Bots and data to the native stack.';
  pushLaunchStatus();
  let error: string | undefined;
  const alreadyUp = docker.state().phase === 'ready';
  const up = alreadyUp ? docker.state() : await docker.start();
  if (up.phase === 'ready') {
    const result = await moveAccepted({
      userDataDir,
      env: process.env,
      exec: (binary, args, opts) => runDocker(binary, args, opts),
      progress: (line) => log.info(`switch to native: ${line}`),
    });
    error = result.ok ? undefined : result.error ?? 'The copy failed.';
  } else {
    error = up.error ?? describeStackState(up);
  }
  // Stopped only when started here: the menu's switch runs while Docker serves the open app.
  if (!alreadyUp) await docker.stop();
  launchNote = undefined;
  if (!error) return true;
  log.warn(`switch to native: ${error}`);
  return startFreshAfterFailedMove(error);
}

/**
 * The person asked for native and the copy could not happen: ask, never decide for them. Starting
 * fresh leaves the Docker volume untouched, so switching back to Docker later finds it all.
 */
async function startFreshAfterFailedMove(error: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Your Docker data could not be copied',
    detail:
      `${error}\n\nYou can start fresh without Docker (your Docker data stays where it is, and switching ` +
      'back to Docker later finds it), or keep using Docker.',
    buttons: ['Keep using Docker', 'Start fresh without Docker'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) {
    writeStackChoice(userDataDir, 'docker');
    return false;
  }
  writeStackChoice(userDataDir, 'native');
  return true;
}


/**
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
    const why = !eligible ? (process.platform === 'darwin' ? 'this Mac is not eligible' : 'the native stack is macOS-only') : `${manifestFile} is missing or invalid`;
    if (forced === 'native') log.warn(`ORBIT_FORCE_STACK=native ignored: ${why}`);
    else log.info(`native stack unavailable: ${why}`);
    return dockerStack();
  }

  const decision =
    forced === 'native' || opts.interactive === false
      ? { choice: (readStackChoice(userDataDir) ?? 'native') as StackKind, reason: 'saved' as const, moveRequired: false }
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
 * Record the runtime the person picked on the launch window. Picking native on a machine whose
 * Docker stack already holds bots copies them out first; a failed copy keeps Docker in charge.
 */
async function chooseRuntime(kind: StackKind): Promise<void> {
  stackSelected = false;
  if (kind === 'native' && nativeStackAvailable() && !fs.existsSync(path.join(userDataDir, 'orbit.db'))) {
    if (await dockerDataExists({ userDataDir, exec: (b, a, o) => runDocker(b, a, o) })) {
      launchView = 'progress';
      openLaunchWindow();
      await performNativeMove();
      return;
    }
  }
  writeStackChoice(userDataDir, kind === 'native' && nativeStackAvailable() ? 'native' : 'docker');
}

/**
 * The menu's Switch to Docker… / Switch to Native…: record the choice, restart on it. Switching
 * back does not copy the native database back — Docker's volumes still hold the pre-switch data,
 * and the native files stay on disk, so switching forward again picks up where it left off.
 */
async function switchStack(choice: StackKind): Promise<void> {
  if (!nativeStackAvailable()) return;
  if (stackKind() === choice) return;

  const nativeDb = path.join(userDataDir, 'orbit.db');
  if (choice === 'native') {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: 'Switch to the Docker-free stack?',
      detail: fs.existsSync(nativeDb)
        ? 'Orbit will restart on its native stack, using the data already in this Mac’s app folder.'
        : 'Orbit will copy your bots and data out of Docker first. Docker Desktop needs to be installed.',
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

  stackSelected = false;
  launchView = 'progress';
  openLaunchWindow();
  await stopStack();
  await closeAppWindow();
  await bootOnce();
}

function openSettings(): void {
  if (mainWindow && !mainWindow.isDestroyed() && currentUrl) {
    // Orbit's own settings live in the web app; the desktop menu is a shortcut to them.
    void mainWindow.loadURL(`${normalizeServerUrl(currentUrl) ?? currentUrl}/settings`);
    return;
  }
  openLaunchWindow();
}

// ------------------------------------------------------------------ shutdown

/** Long enough for `compose stop`'s ten-second grace per container, short enough to never hang a quit. */
const STOP_BUDGET_MS = 45_000;
let tornDown = false;
let teardown: Promise<void> | null = null;

/** Stop the stack once, however many quits (menu, updater, a second Cmd-Q) ask for it. */
function tearDown(): Promise<void> {
  teardown ??= (async () => {
    badge?.stop();
    badge = null;
    for (const win of BrowserWindow.getAllWindows()) win.hide();
    log.info(`quit: stopping the ${stack.kind} stack`);
    const stopped = await Promise.race([
      stack.stop().then(() => true, (err) => (log.warn('quit: stop failed', err), false)),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_BUDGET_MS).unref()),
    ]);
    if (!stopped && stack.kind === 'native') stack.dispose();
    log.info(stopped ? 'quit: stack stopped' : 'quit: gave up waiting for the stack to stop');
  })().finally(() => {
    tornDown = true;
  });
  return teardown;
}

// ------------------------------------------------------------------ updates

/**
 * Fetch the new release's server while this one runs. A remote server is not ours to update, and
 * a stack that never started here has nothing to warm.
 */
async function prepareUpdate(version: string): Promise<string | undefined> {
  if (readSetup()?.mode !== 'new') return undefined;
  await stack.prefetch(version);
  return undefined;
}

/**
 * The native database is a file in userData that the new version opens as it is. A copy taken
 * after the stop (so it is consistent) is the way back if the new version's migration goes wrong.
 * Docker's data stays in its named volume, which an update never touches.
 */
function backUpNativeDatabase(): void {
  if (stack.kind !== 'native') return;
  const db = path.join(userDataDir, 'orbit.db');
  if (!fs.existsSync(db)) return;
  const dir = path.join(userDataDir, 'backups');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `orbit-${app.getVersion()}.db`);
    fs.copyFileSync(db, target);
    log.info(`backed up the database to ${target}`);
  } catch (err) {
    log.warn('could not back up the database before the update', err);
  }
}

// ------------------------------------------------------------------ startup

/** A `--server=<url>` flag, for support and for pointing the app at a staging server. */
function cliServerUrl(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith('--server='));
  return arg ? arg.slice('--server='.length) : undefined;
}

/**
 * Download and install Docker Desktop with a progress window, then wait for the person to
 * finish Docker's own first-run prompts. Resolves true when the install step succeeded.
 */
async function runDockerInstall(): Promise<boolean> {
  const progress = openProgressWindow('Installing Docker Desktop', 'Orbit runs its server and each bot’s computer in Docker.');
  try {
    await installDockerDesktop((line) => { log.info(`docker install: ${line}`); progress.line(line); }, {
      onBytes: (received, total) => progress.percent(total > 0 ? (received / total) * 100 : null),
    });
    progress.percent(100);
    progress.line('Docker Desktop is installed.');
    await dialog.showMessageBox({
      type: 'info',
      message: 'Finish setting up Docker Desktop',
      detail: 'Docker Desktop is opening. Accept its licence and any permission prompts, wait for it to say it is running, then click Continue.',
      buttons: ['Continue'],
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Docker Desktop install failed', err);
    progress.fail(message);
    await dialog.showMessageBox({ type: 'error', message: 'Docker Desktop could not be installed', detail: message, buttons: ['OK'] });
    return false;
  } finally {
    progress.close();
  }
}

/**
 * The native stack runs every bot's gateway on this machine, so it needs a `hermes` binary here.
 * The Docker stack ships its own and never asks.
 */
async function prepareNativeHermes(): Promise<void> {
  if (stackKind() !== 'native') return;
  try {
    const status = await detectHermes(process.env);
    if (!status.found) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Install Hermes?',
        detail: 'Every Orbit bot runs on Hermes Agent, and it is not installed yet. Orbit can install it now.',
        buttons: ['Install Hermes', 'Not now'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) {
        log.info('Hermes not installed; native bots will not start until it is');
        return;
      }
      const progress = openProgressWindow('Installing Hermes', 'The agent harness every Orbit bot runs on.', mainWindow);
      try {
        await installHermes((line) => progress.line(line));
        setTimeout(() => progress.close(), 1500);
      } catch (err) {
        progress.fail(err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
  } catch (err) {
    log.warn('Hermes preparation failed', err);
  }
}

/** Quitting is a product decision, so it says why in the log. */
function quitApp(reason: string): void {
  log.warn(`quitting: ${reason}`);
  app.quit();
}

/**
 * The URL the app window should open on a local stack, signing in first when it has to. A
 * bundled stack ships `DEV_LOGIN=0` and no Composio key, so its own sign-in screen has nothing
 * that works; the main process mints a one-time owner link instead (`desktop-session.ts`).
 */
async function localStackEntryUrl(webUrl: string, setup: DesktopSetup | null): Promise<string> {
  const email = setup?.email ?? DEFAULT_OWNER_EMAIL;
  // Ask through the app window's own partition: its cookie jar is where a session from a
  // previous launch lives, and asking with the global `fetch` would look cookie-less every
  // time and mint a new link on every start.
  const { ses } = sessionForServerUrl(webUrl);
  const result = await ensureDesktopSession({
    webUrl,
    sessionSecret: stack.sessionSecret(),
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
    launchView = 'choose';
    openLaunchWindow();
    return;
  }
  if (saved?.mode !== 'new') {
    await openAppWindow(target.url);
    closeLaunchWindow();
    return;
  }
  await startLocal(saved);
}

/**
 * Start the local stack behind the launch window, and swap to the app window once it answers. A
 * start that stops short leaves the launch window showing why, with its recovery actions.
 */
async function startLocal(saved: DesktopSetup): Promise<void> {
  launchView = 'progress';
  launchFailure = null;
  openLaunchWindow();
  if (!stackSelected) {
    stack = await selectStackController();
    stackSelected = true;
    refreshMenu();
    pushLaunchStatus();
  }
  const state = await stack.start();
  if (!(state.phase === 'ready' || state.phase === 'running') || !state.webUrl) return;
  try {
    await openAppWindow(state.webUrl, await localStackEntryUrl(state.webUrl, saved));
  } catch (err) {
    log.error('the app window could not load the stack', err);
    launchFailure = `Orbit started, but its window could not load ${state.webUrl}: ${err instanceof Error ? err.message : String(err)}`;
    await closeAppWindow();
    pushLaunchStatus();
    return;
  }
  closeLaunchWindow();
  void prepareNativeHermes();
}

let bootInFlight: Promise<void> | null = null;

/** A Dock click and a link can both ask for a window at once; they share one boot. */
function bootOnce(): Promise<void> {
  bootInFlight ??= boot().finally(() => {
    bootInFlight = null;
  });
  return bootInFlight;
}

// ------------------------------------------------------------------ IPC

/** The setup window's document: the only `file://` page whose calls we trust. */
function setupFileUrl(): string {
  return pathToFileURL(path.join(here, 'setup.html')).href;
}

/**
 * Is this call coming from a page we ship? The app window carries the whole preload bridge
 * wherever it is pointed, so a server the user merely connected to could otherwise drive Docker
 * or rewrite the setup. Only the setup document and the local stack's origin pass.
 */
function senderTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const stackWebUrl = stack.webUrl();
  const pageUrl = event.senderFrame?.url ?? '';
  if (isTrustedPage({ pageUrl, stackWebUrl, setupFileUrl: setupFileUrl() })) return true;
  log.warn(`rejected a mutating IPC call from ${describeSender(pageUrl, stackWebUrl)}`);
  return false;
}

function assertSender(event: IpcMainInvokeEvent): void {
  if (!senderTrusted(event)) throw new Error('not allowed from this page');
}

function registerIpc(): void {
  ipcMain.handle(IPC.launchOptions, (): LaunchOptions => {
    const manifestPresent = readServerManifest(bundledManifestPath()) !== null;
    return {
      native: {
        available: nativeStackAvailable(),
        reason: ineligibilityReason() ?? (manifestPresent ? undefined : 'this build does not include the native server'),
      },
      dockerInstalled: resolveDockerBinary(process.platform, process.env) !== null,
    };
  });
  ipcMain.handle(IPC.launchStatus, () => launchStatus());
  ipcMain.handle(IPC.launchChoose, async (event, choice: LaunchChoice) => {
    assertSender(event);
    if (choice?.mode === 'remote') {
      const serverUrl = normalizeServerUrl(choice.serverUrl);
      if (!serverUrl) throw new Error('That does not look like a URL.');
      writeSetup(userDataDir, { mode: 'existing', serverUrl });
    } else if (choice?.mode === 'local' && (choice.runtime === 'docker' || choice.runtime === 'native')) {
      const previous = readSetup();
      writeSetup(userDataDir, { mode: 'new', email: previous?.mode === 'new' ? previous.email : undefined });
      await chooseRuntime(choice.runtime);
    } else {
      throw new Error('unknown launch choice');
    }
    refreshMenu();
    await bootOnce();
  });
  // Not awaited: a retry or an install is long, and its progress arrives through launch status.
  ipcMain.handle(IPC.launchAct, async (event, action: LaunchAction) => {
    assertSender(event);
    switch (action) {
      case 'retry':
        void bootOnce();
        return;
      case 'install-docker':
        if (await runDockerInstall()) void bootOnce();
        return;
      case 'open-docker-download':
        await openExternalSafely('https://docs.docker.com/engine/install/');
        return;
      case 'use-native':
        await chooseRuntime('native');
        void bootOnce();
        return;
      case 'show-log':
        shell.showItemInFolder(logFile);
        return;
      case 'back':
        await showChoices();
        return;
    }
  });

  ipcMain.handle(IPC.setupGet, () => readSetup());

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

  // Not guarded: Settings may be served by a remote Orbit server, and these only ever fetch and
  // install the signed release electron-updater verifies, which no page can choose.
  ipcMain.handle(IPC.updateStatus, () => updateStatus());
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates());
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate());
  ipcMain.handle(IPC.updateInstall, async () => {
    if (updateStatus().phase !== 'ready') return;
    await tearDown();
    backUpNativeDatabase();
    restartAndInstall();
  });
  // Only the app window's page may take a link: the setup window and the update bar have no use for one.
  // GPU voice: read-only status for any window; installing/removing is a trusted-page action.
  ipcMain.handle(IPC.gpuVoiceStatus, (): Promise<DesktopGpuVoice> | DesktopGpuVoice =>
    stack.kind === 'docker'
      ? stack.gpuVoiceStatus()
      : { ...gpuVoiceSupport(process.platform, null, 'native'), enabled: false, phase: 'off' },
  );
  ipcMain.handle(IPC.gpuVoiceSet, async (event, on: boolean): Promise<DesktopGpuVoice> => {
    assertSender(event);
    if (stack.kind !== 'docker') return { ...gpuVoiceSupport(process.platform, null, 'native'), enabled: false, phase: 'off' };
    return stack.setGpuVoice(on === true);
  });
  ipcMain.handle(IPC.deepLinkTake, (event) => (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents ? deepLinks.take() : null));
  ipcMain.handle(IPC.openExternal, (event, url: string) => {
    assertSender(event);
    return openExternalSafely(String(url ?? ''));
  });
}

// ------------------------------------------------------------------ smoke test

/**
 * `ORBIT_SMOKE=1 electron .` loads the real setup window off-screen, checks the preload bridge,
 * prints what it found and exits: CI proves the bundle, the HTML and the preload path agree
 * without a visible window.
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
    const resources = stackResourceDir(stack);
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

      // The "existing instance" state: URL row revealed, Continue still disabled until a
      // probe passes.
      await win.webContents.executeJavaScript(`(() => {
        const radio = document.querySelector('input[value="existing"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        const input = document.getElementById('server-url');
        input.value = 'https://orbit.example.com';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return document.getElementById('continue').disabled;
      })()`).then((disabled) => console.log(`[orbit-smoke] existing-mode continue disabled: ${disabled}`));
      await new Promise((r) => setTimeout(r, 250));
      const second = await win.webContents.capturePage();
      const existingPath = shotPath.replace(/\.png$/, '.existing.png');
      fs.writeFileSync(existingPath, second.toPNG());
      console.log(`[orbit-smoke] screenshot ${existingPath} (${second.getSize().width}x${second.getSize().height})`);
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

// Stay alive and say what happened: a single bad request must not end the app.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception in the main process', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection in the main process', reason);
});


// ------------------------------------------------------------------ deep links

/**
 * Become the handler for `orbit://`. A second profile (ORBIT_USER_DATA_DIR, the smoke harness) skips
 * it: registering would take the person's links away from their real install.
 */
function registerProtocolClient(): void {
  if (userDataOverride || process.env.ORBIT_SMOKE === '1') return;
  // Unpackaged, the binary is Electron itself, so the OS must be told which app to start with it.
  const registered = process.defaultApp && process.argv[1]
    ? app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])])
    : app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  if (!registered) log.warn(`could not register as the ${DEEP_LINK_SCHEME}:// handler`);
}

/** Keep the link for the app window and bring the window up; its page takes the link when it can. */
function receiveDeepLink(link: DeepLink | null): void {
  if (!link) return;
  // The text can be private; the log says only where the link points.
  log.info(`deep link for ${link.botId ?? 'the primary bot'}`);
  deepLinks.put(link);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.deepLinkReady);
  } else if (app.isReady() && BrowserWindow.getAllWindows().length === 0) {
    // macOS keeps the app alive with no window; a link should open one, as a Dock click does.
    void bootOnce();
  }
}

if (!app.requestSingleInstanceLock()) {
  quitApp('another Orbit instance holds the single-instance lock');
} else {
  registerProtocolClient();
  // macOS delivers a link that launched the app before `ready`, so this listener goes on first.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    receiveDeepLink(deepLinkFromArgv([url]));
  });
  // Windows and Linux pass the link as an argument, to the first launch or to a second instance.
  receiveDeepLink(deepLinkFromArgv(process.argv));

  app.on('second-instance', (_event, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (launchWindow && !launchWindow.isDestroyed()) {
      launchWindow.focus();
    }
    receiveDeepLink(deepLinkFromArgv(argv));
  });

  app.whenReady().then(
    () => {
      registerIpc();

      // In dev (not packaged) the binary is Electron itself, so the macOS Dock shows the
      // Electron icon. Set our icon explicitly so it appears correctly during development.
      // Windows/Linux use the BrowserWindow `icon` option set in devWindowIcon().
      if (!app.isPackaged && process.platform === 'darwin') {
        const icon = nativeImage.createFromPath(path.join(here, '..', 'assets', 'icon.png'));
        if (!icon.isEmpty()) app.dock?.setIcon(icon);
      }

      if (process.env.ORBIT_SMOKE === '1') {
        void runSmokeTest();
        return;
      }
      refreshMenu();
      initAutoUpdate({
        prepare: prepareUpdate,
        onStatus: (status) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.updateStatus, status);
        },
      });
      void bootOnce().catch((err) => {
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
    if (launchWindow && !launchWindow.isDestroyed()) launchWindow.focus();
    else if (BrowserWindow.getAllWindows().length === 0) void bootOnce();
  });

  app.on('window-all-closed', () => {
    // macOS keeps the app, and its stack, running in the dock until Quit.
    if (process.platform !== 'darwin') quitApp('all windows closed (non-macOS)');
  });

  // Quitting stops the stack first: containers are stopped (not removed) and native processes
  // shut down cleanly, so the next launch resumes them with their data. Quit waits for it.
  app.on('before-quit', (event) => {
    if (tornDown) return;
    event.preventDefault();
    void tearDown().then(() => app.quit());
  });
}

/** Exposed for the E2E harness: the app's stack folder and current target. */
export const __testing = {
  stackDir: () => stack.stackDir,
  currentUrl: () => currentUrl,
  state: (): DesktopLocalStackState => stack.state(),
  userDataDir,
};
