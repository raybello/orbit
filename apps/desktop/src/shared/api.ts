/**
 * The desktop app's own types, in one place.
 *
 * Most API shapes live in `@orbit/contracts`. These do not belong there yet: they are
 * about the *desktop client's* lifecycle (setup file, local Docker stack, Hermes install)
 * rather than the server's HTTP surface. `src/preload.cjs` mirrors `OrbitDesktopAPI`
 * literally, so a change here needs the same change there.
 */

import type { DeepLink, DesktopGpuVoice, DesktopPhoneAccess, DesktopUpdateStatus } from '@orbit/contracts';

export type SetupMode = 'new' | 'existing';

/** Which local runtime runs Orbit's server: Docker Compose, or the macOS-only native bundle. */
export type StackKind = 'docker' | 'native';

/** The contents of `userData/setup.json`. */
export interface DesktopSetup {
  /** `new`: run the Docker stack on this computer. `existing`: connect to a server URL. */
  mode: SetupMode;
  /** Always present for `existing`; optional (and advisory) for `new`. */
  serverUrl?: string;
  /**
   * The identity Orbit signs in to its own local stack as (`new` mode only), written on the
   * first launch so the account — and its bots — stay the same from then on.
   */
  email?: string;
  /** Extra headers the server may require in front of it (a proxy, a VPN gateway). */
  customHeaders?: Record<string, string>;
  /** When the setup was written, epoch ms. */
  createdAt?: number;
}

export type DockerFailureKind =
  | 'image-not-found'
  | 'port-in-use'
  | 'address-pool-exhausted'
  | 'network'
  | 'daemon-down'
  | 'socket-permission'
  | 'compose-missing'
  | 'other';

/** The phases of the local stack state machine, in the order they normally happen.
 *
 * The Docker stack walks the `docker-*` / `pulling` / `waiting-healthy` / `ready` path; the
 * native stack (`native-stack.ts`) uses `starting` -> `waiting-healthy` -> `running` ->
 * `stopping` -> `stopped`. Both share this type so the setup window, the menu and the IPC
 * broadcast never need to know which controller is behind them.
 */
export type StackPhase =
  | 'idle'
  | 'checking-docker'
  | 'docker-missing'
  | 'docker-not-running'
  | 'preparing'
  | 'pulling'
  | 'starting'
  | 'waiting-healthy'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface DesktopLocalStackState {
  phase: StackPhase;
  /** A human-readable line for the setup window ("Pulling orbit/api:v0.1.0"). */
  detail?: string;
  /** 0..1 where a phase can report progress (pulling, waiting-healthy). */
  progress?: number;
  /** Where the stack answers once `phase === 'ready'`. */
  webUrl?: string;
  error?: string;
  failureKind?: DockerFailureKind;
  /** Epoch ms of the last transition. */
  at: number;
}

export interface HermesStatus {
  found: boolean;
  /** From `hermes --version`, when we could run it. */
  version?: string;
  /** HERMES_HOME, or `~/.hermes`. */
  home?: string;
  /** The binary we resolved, when found. */
  binaryPath?: string;
}

export interface ServerProbe {
  ok: boolean;
  /** Set when the probe failed: the HTTP status, or a network error message. */
  error?: string;
  engine?: string;
  version?: string;
}

/** What the launch window may offer on this machine. */
export interface LaunchOptions {
  native: { available: boolean; reason?: string };
  dockerInstalled: boolean;
}

/** The person's answer on the launch window's first screens. */
export type LaunchChoice = { mode: 'local'; runtime: StackKind } | { mode: 'remote'; serverUrl: string };

/** What the launch window draws while a local stack starts. */
export interface LaunchStatus {
  /** `choose` until there is a saved setup to start; `progress` while one starts. */
  view: 'choose' | 'progress';
  kind: StackKind;
  state: DesktopLocalStackState;
  /** The native stack could run here instead (offered when Docker is missing). */
  nativeAvailable: boolean;
  /** Replaces the runtime line while the start serves something else (copying Docker's data). */
  note?: string;
}

/** A recovery the launch window offers when a start stops short (`launch-model.ts`). */
export type LaunchAction = 'retry' | 'install-docker' | 'open-docker-download' | 'use-native' | 'show-log' | 'back';

export interface OrbitDesktopAPI {
  // The launch window: first-run choices, then the start of the local stack.
  launch: {
    options(): Promise<LaunchOptions>;
    status(): Promise<LaunchStatus>;
    onStatus(cb: (status: LaunchStatus) => void): () => void;
    /** Save the choice and start on it; the window switches to progress through `onStatus`. */
    choose(choice: LaunchChoice): Promise<void>;
    act(action: LaunchAction): Promise<void>;
  };
  getSetup(): Promise<DesktopSetup | null>;
  /** Probe `/api/health` from the main process, so the launch window needs no CORS. */
  probeServer(url: string): Promise<ServerProbe>;
  // Updates, driven from the web app's Settings.
  updates: {
    status(): Promise<DesktopUpdateStatus>;
    check(): Promise<DesktopUpdateStatus>;
    download(): Promise<DesktopUpdateStatus>;
    /** Stop the stack and relaunch on the downloaded version. */
    install(): Promise<void>;
    onStatus(cb: (status: DesktopUpdateStatus) => void): () => void;
    /** The app menu's Check for Updates…: Settings should come forward. */
    onOpenRequest(cb: () => void): () => void;
  };
  /** Opens an https URL in the system browser; other schemes are refused in main. */
  openExternal(url: string): Promise<void>;
  // Deep links
  /**
   * Calls `cb` with each `orbit://` link the OS hands the app, including one that arrived before this
   * page subscribed. Each link is delivered once, to the app window only.
   */
  onDeepLink(cb: (link: DeepLink) => void): () => void;
  // GPU voice: the audio.cpp sidecar, installed only when the person asks (Windows/Linux + NVIDIA).
  gpuVoice: {
    status(): Promise<DesktopGpuVoice>;
    install(): Promise<DesktopGpuVoice>;
    remove(): Promise<DesktopGpuVoice>;
  };
  // "Allow my phone to connect": the local stack reachable on the local network, only while on.
  phoneAccess: {
    status(): Promise<DesktopPhoneAccess>;
    set(on: boolean): Promise<DesktopPhoneAccess>;
  };
  // Platform
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
}

/** IPC channel names. Kept as a const map so preload and main cannot drift. */
export const IPC = {
  launchOptions: 'orbit:launch:options',
  launchStatus: 'orbit:launch:status',
  launchChoose: 'orbit:launch:choose',
  launchAct: 'orbit:launch:act',
  setupGet: 'orbit:setup:get',
  setupProbe: 'orbit:setup:probe',
  updateStatus: 'orbit:update:status',
  updateCheck: 'orbit:update:check',
  updateDownload: 'orbit:update:download',
  updateInstall: 'orbit:update:install',
  updateOpen: 'orbit:update:open',
  openExternal: 'orbit:shell:open-external',
  deepLinkReady: 'orbit:deeplink:ready',
  deepLinkTake: 'orbit:deeplink:take',
  gpuVoiceStatus: 'orbit:gpu-voice:status',
  gpuVoiceSet: 'orbit:gpu-voice:set',
  phoneAccessStatus: 'orbit:phone-access:status',
  phoneAccessSet: 'orbit:phone-access:set',
} as const;
