/**
 * The desktop app's own types, in one place.
 *
 * Most API shapes live in `@orbit/contracts`. These do not belong there yet: they are
 * about the *desktop client's* lifecycle (setup file, local Docker stack, Hermes install)
 * rather than the server's HTTP surface. `src/preload.cjs` mirrors `OrbitDesktopAPI`
 * literally, so a change here needs the same change there.
 */

export type SetupMode = 'new' | 'existing';

/** The contents of `userData/setup.json`. */
export interface DesktopSetup {
  /** `new`: run the Docker stack on this computer. `existing`: connect to a server URL. */
  mode: SetupMode;
  /** Always present for `existing`; optional (and advisory) for `new`. */
  serverUrl?: string;
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

/** The phases of the local stack state machine, in the order they normally happen. */
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
  /** True when `~/.hermes/.env` already carries API_SERVER_KEY. */
  hasApiKey?: boolean;
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

export interface OrbitDesktopAPI {
  // Stack
  getStackState(): Promise<DesktopLocalStackState>;
  startStack(): Promise<DesktopLocalStackState>;
  stopStack(): Promise<DesktopLocalStackState>;
  onStackState(cb: (state: DesktopLocalStackState) => void): () => void;
  // Setup
  getSetup(): Promise<DesktopSetup | null>;
  saveSetup(setup: DesktopSetup): Promise<DesktopSetup | null>;
  clearSetup(): Promise<void>;
  /** Probe `/api/health` from the main process, so the setup window needs no CORS. */
  probeServer(url: string): Promise<ServerProbe>;
  /** Tells main the setup window is done; it closes us and continues startup. */
  finishSetup(): void;
  // Hermes
  getHermesStatus(): Promise<HermesStatus>;
  installHermes(onProgress: (line: string) => void): Promise<HermesStatus>;
  wireHermesMcp(token: string): Promise<void>;
  // Updates
  checkForUpdates(): Promise<void>;
  onUpdateReady(cb: () => void): () => void;
  restartAndInstall(): Promise<void>;
  /** Closes the update bar; the bar's own renderer calls it. */
  dismissUpdateNotice(): void;
  /** Opens an https URL in the system browser; other schemes are refused in main. */
  openExternal(url: string): Promise<void>;
  // Platform
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
}

/** IPC channel names. Kept as a const map so preload and main cannot drift. */
export const IPC = {
  stackGet: 'orbit:stack:get',
  stackStart: 'orbit:stack:start',
  stackStop: 'orbit:stack:stop',
  stackState: 'orbit:stack:state',
  setupGet: 'orbit:setup:get',
  setupSave: 'orbit:setup:save',
  setupClear: 'orbit:setup:clear',
  setupProbe: 'orbit:setup:probe',
  setupComplete: 'setup-complete',
  hermesStatus: 'orbit:hermes:status',
  hermesInstall: 'orbit:hermes:install',
  hermesInstallProgress: 'orbit:hermes:install-progress',
  hermesWireMcp: 'orbit:hermes:wire-mcp',
  updateCheck: 'orbit:update:check',
  updateReady: 'orbit:update:ready',
  updateInstall: 'orbit:update:install',
  noticeDismiss: 'orbit:notice:dismiss',
  openExternal: 'orbit:shell:open-external',
} as const;
