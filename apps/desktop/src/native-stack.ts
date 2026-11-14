/**
 * The native stack: Orbit's server as supervised Node processes, no Docker.
 *
 * `NativeStackController` is a drop-in for `LocalStackController` — same `start`, `stop`,
 * `state`, `webUrl`, `matchesDesiredStack` — so the setup window, the app window and the
 * menu need no idea which one they are talking to. The difference is underneath: instead
 * of `docker compose up`, we unpack a server bundle and run its entrypoints with
 * `ELECTRON_RUN_AS_NODE=1 <electron binary> …`, which means the packaged app needs no
 * separate Node runtime.
 *
 * Two things make this safe to run a product on:
 *
 *  - every child is supervised: logs go to a file, and a crash restarts it with capped
 *    exponential backoff instead of leaving the user with a white window
 *  - ports are persisted (`userData/stack/.native-ports`) so the web origin — and with it
 *    the renderer's cookie jar — stays the same across launches
 *
 * State machine: idle -> starting -> waiting-healthy -> running -> stopping -> stopped,
 * with `failed` reachable from any step of `start()`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream, type WriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { ORBIT_HEADERS } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import { DEFAULT_LOCAL_WEB_URL, normalizeServerUrl } from './setup-config';
import { allocateLoopbackPort, bindLoopback, type BindFn } from './loopback-port';
import { envValue } from './env-file';
import { nativePortsFile } from './docker-move';
import {
  installServerBundle,
  type InstalledBundle,
  type RuntimeExec,
  type ServerManifest,
  serverBundleDir,
} from './mac-runtime';
import type { DesktopLocalStackState, StackPhase } from './shared/api';

const log = createLogger({ scope: 'native-stack' });

/** The port band we allocate in: unprivileged, above the ephemeral range on macOS 26. */
export const NATIVE_PORT_RANGE: readonly [number, number] = [40_000, 49_999];

/** 1s, 2s, 4s … 30s. A crash loop must not become a fork bomb. */
export function restartDelay(count: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, count), 30_000);
}

export class NativeStackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeStackError';
  }
}

// ------------------------------------------------------------------ Service

export interface SpawnedProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; stdio: ['ignore', 'pipe', 'pipe'] },
) => SpawnedProcess;

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as SpawnedProcess;

export interface ServiceSpec {
  /** Also the log file's name: `userData/stack/logs/<name>.log`. */
  name: string;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  logDir: string;
}

export interface ServiceDeps {
  spawn?: SpawnFn;
  /** How long a process must stay up before we call it started. */
  startedAfterMs?: number;
  /** SIGTERM -> SIGKILL grace. */
  stopGraceMs?: number;
  /** Uptime after which a later crash starts the backoff over. */
  stableUptimeMs?: number;
  timers?: {
    setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
  now?: () => number;
}

/**
 * One supervised child process.
 *
 * `start()` resolves once the process has been alive for `startedAfterMs` — long enough
 * that "spawn succeeded" and "the server actually runs" are the same statement. An exit
 * before that rejects, so the controller can report a real error instead of polling a
 * health endpoint for a process that is already gone.
 */
export class Service {
  readonly name: string;
  private readonly spec: ServiceSpec;
  private readonly spawnImpl: SpawnFn;
  private readonly timers: NonNullable<ServiceDeps['timers']>;
  private readonly startedAfterMs: number;
  private readonly stopGraceMs: number;
  private readonly stableUptimeMs: number;
  private readonly now: () => number;

  private proc: SpawnedProcess | null = null;
  private logStream: WriteStream | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResolve: (() => void) | null = null;
  private restartCount = 0;
  private stopping = false;
  private spawnedAt = 0;

  constructor(spec: ServiceSpec, deps: ServiceDeps = {}) {
    this.spec = spec;
    this.name = spec.name;
    this.spawnImpl = deps.spawn ?? defaultSpawn;
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    this.startedAfterMs = deps.startedAfterMs ?? 1_000;
    this.stopGraceMs = deps.stopGraceMs ?? 5_000;
    this.stableUptimeMs = deps.stableUptimeMs ?? 30_000;
    this.now = deps.now ?? Date.now;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;
    this.clearRestartTimer();
    await this.spawnAndWait();
  }

  /** SIGTERM, then SIGKILL after the grace period. Safe to call twice. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();

    const proc = this.proc;
    if (!proc) {
      this.closeLog();
      this.resolveStop();
      return;
    }

    const exited = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
    try {
      proc.kill('SIGTERM');
    } catch (err) {
      log.warn(`${this.name}: SIGTERM failed`, err);
    }

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        const handle = this.timers.setTimeout(() => resolve(true), this.stopGraceMs);
        (handle as { unref?: () => void }).unref?.();
      }),
    ]);

    if (timedOut) {
      log.warn(`${this.name} ignored SIGTERM; killing it`);
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await exited;
    }

    this.proc = null;
    this.closeLog();
  }

  /** Quit-time teardown: no grace, no restart. */
  dispose(): void {
    this.stopping = true;
    this.clearRestartTimer();
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    this.closeLog();
    this.resolveStop();
  }

  // ---------------------------------------------------------------- internals

  private spawnAndWait(): Promise<void> {
    const logStream = this.openLog();
    let proc: SpawnedProcess;
    try {
      proc = this.spawnImpl(this.spec.binary, this.spec.args, {
        env: this.spec.env,
        cwd: this.spec.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.closeLog();
      throw new NativeStackError(`${this.name} could not start: ${errorText(err)}`);
    }
    this.proc = proc;
    this.spawnedAt = this.now();
    logStream.write(
      `\n[${new Date(this.spawnedAt).toISOString()}] starting ${this.spec.binary} ${this.spec.args.join(' ')}\n`,
    );

    const pipe = (stream: NodeJS.ReadableStream | null, tag: 'stdout' | 'stderr') => {
      if (!stream) return;
      stream.on('data', (chunk: Buffer | string) => {
        logStream.write(chunk);
      });
      stream.on('error', (err: Error) => logStream.write(`[${tag} error] ${errorText(err)}\n`));
    };
    pipe(proc.stdout, 'stdout');
    pipe(proc.stderr, 'stderr');

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      // `startedAfterMs: 0` means "trust the spawn" — used by tests, and by nothing else.
      const startedTimer =
        this.startedAfterMs > 0
          ? this.timers.setTimeout(() => {
              if (settled) return;
              settled = true;
              resolve();
            }, this.startedAfterMs)
          : null;
      if (startedTimer) (startedTimer as { unref?: () => void }).unref?.();
      else {
        queueMicrotask(() => {
          if (settled) return;
          settled = true;
          resolve();
        });
      }

      proc.on('error', ((err: Error) => {
        logStream.write(`[spawn error] ${errorText(err)}\n`);
        if (settled) return;
        settled = true;
        if (startedTimer) this.timers.clearTimeout(startedTimer);
        this.proc = null;
        this.closeLog();
        reject(new NativeStackError(`${this.name} could not start: ${errorText(err)}`));
      }) as (...args: never[]) => void);

      proc.on('exit', ((code: number | null, signal?: string | null) => {
        logStream.write(`[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
        this.proc = null;
        this.closeLog();

        const wasStopping = this.stopping;
        this.resolveStop();

        if (!settled) {
          settled = true;
          if (startedTimer) this.timers.clearTimeout(startedTimer);
          reject(
            new NativeStackError(
              `${this.name} exited during startup (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`,
            ),
          );
          return;
        }

        if (wasStopping) return;
        this.scheduleRestart(code);
      }) as (...args: never[]) => void);
    });
  }

  private scheduleRestart(code: number | null): void {
    const uptime = this.now() - this.spawnedAt;
    if (uptime >= this.stableUptimeMs) this.restartCount = 0;
    const delay = restartDelay(this.restartCount);
    this.restartCount += 1;
    log.warn(`${this.name} crashed (code ${code ?? 'null'}); restarting in ${delay}ms`);

    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      // The restart is fire-and-forget: if this attempt dies too, `exit` schedules the next.
      this.spawnAndWait().catch((err) => {
        log.error(`${this.name} restart failed`, err);
      });
    }, delay);
    (this.restartTimer as { unref?: () => void }).unref?.();
  }

  private openLog(): WriteStream {
    if (this.logStream) return this.logStream;
    fs.mkdirSync(this.spec.logDir, { recursive: true, mode: 0o700 });
    this.logStream = createWriteStream(path.join(this.spec.logDir, `${this.name}.log`), {
      flags: 'a',
      mode: 0o600,
    });
    this.logStream.on('error', (err) => log.warn(`${this.name}: log write failed`, err));
    return this.logStream;
  }

  private closeLog(): void {
    const stream = this.logStream;
    this.logStream = null;
    try {
      stream?.end();
    } catch {
      /* already closed */
    }
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private resolveStop(): void {
    const resolve = this.stopResolve;
    this.stopResolve = null;
    resolve?.();
  }
}

// ------------------------------------------------------------------ ports

export interface NativePorts {
  api: number;
  web: number;
}

export function isPortInRange(port: number, range: readonly [number, number] = NATIVE_PORT_RANGE): boolean {
  return Number.isInteger(port) && port >= range[0] && port <= range[1];
}

/** Tolerant read: the file is hand-editable, and a bad one just means "allocate again". */
export function readNativePorts(file: string, range: readonly [number, number] = NATIVE_PORT_RANGE): NativePorts | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NativePorts>;
    const api = Number(parsed?.api);
    const web = Number(parsed?.web);
    if (!isPortInRange(api, range) || !isPortInRange(web, range)) return null;
    if (api === web) return null;
    return { api, web };
  } catch {
    return null;
  }
}

export function writeNativePorts(file: string, ports: NativePorts): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ api: ports.api, web: ports.web }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows: mode is advisory */
  }
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ controller

export interface NativeStackOptions {
  /** `app.getPath('userData')`. */
  userDataDir: string;
  manifest: ServerManifest;
  /** `app.getPath('userData')/server-bundles` unless overridden. */
  bundleDir?: string;
  /** `process.execPath` in Electron: the binary that runs as Node. */
  electronBinary?: string;
  hermesHome?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  exec?: RuntimeExec;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  spawn?: SpawnFn;
  timers?: ServiceDeps['timers'];
  /** Default: a random free port in `NATIVE_PORT_RANGE`. */
  allocatePort?: () => Promise<number>;
  isPortFree?: (port: number) => Promise<boolean>;
  install?: (manifest: ServerManifest, destDir: string) => Promise<InstalledBundle>;
  generateSecret?: () => string;
  onState?: (state: DesktopLocalStackState) => void;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  serviceStartedMs?: number;
  stopGraceMs?: number;
  portRange?: readonly [number, number];
  /** Set by tests to keep logs out of a real userData tree. */
  logDir?: string;
}

const STARTING_PHASES: StackPhase[] = ['starting', 'waiting-healthy'];

export class NativeStackController {
  readonly kind = 'native' as const;
  readonly stackDir: string;
  readonly bundleDir: string;
  private readonly opts: NativeStackOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly range: readonly [number, number];
  private current: DesktopLocalStackState;
  private api: Service | null = null;
  private abortController: AbortController | null = null;

  constructor(options: NativeStackOptions) {
    this.opts = options;
    this.env = options.env ?? process.env;
    this.range = options.portRange ?? NATIVE_PORT_RANGE;
    this.stackDir = this.env.ORBIT_STACK_DIR?.trim() || path.join(options.userDataDir, 'stack');
    this.bundleDir = options.bundleDir ?? serverBundleDir(options.userDataDir);
    this.current = { phase: 'idle', at: (options.now ?? Date.now)(), detail: 'Not started' };
  }

  private get portsFile(): string {
    return nativePortsFile(this.stackDir);
  }

  private get secretsFile(): string {
    return path.join(this.stackDir, 'secrets.json');
  }

  private get logDir(): string {
    return this.opts.logDir ?? path.join(this.stackDir, 'logs');
  }

  state(): DesktopLocalStackState {
    return this.current;
  }

  /** Persisted once the stack has started; before that there is no native URL to report. */
  webUrl(): string {
    if (this.current.webUrl) return this.current.webUrl;
    const ports = readNativePorts(this.portsFile, this.range);
    return ports ? `http://127.0.0.1:${ports.web}` : DEFAULT_LOCAL_WEB_URL;
  }

  /** The shared secret the API expects in `x-orbit-stack-token`. */
  token(): string | null {
    try {
      const secrets = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as Record<string, string>;
      return secrets?.stack_token ?? null;
    } catch {
      return null;
    }
  }

  /** The SESSION_SECRET this stack signs sessions with, for the owner-key sign-in. */
  sessionSecret(): string | null {
    try {
      const secrets = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as Record<string, string>;
      return secrets?.session_secret ?? null;
    } catch {
      return null;
    }
  }

  matchesDesiredStack(desiredUrl?: string): boolean {
    if (this.current.phase !== 'running') return false;
    const desired = normalizeServerUrl(desiredUrl ?? this.webUrl());
    return !!desired && desired === normalizeServerUrl(this.current.webUrl ?? this.webUrl());
  }

  // ---------------------------------------------------------------- state

  private set(next: Partial<DesktopLocalStackState> & { phase: StackPhase }): DesktopLocalStackState {
    this.current = { ...this.current, ...next, at: (this.opts.now ?? Date.now)() };
    log.info(`${next.phase}${next.detail ? `: ${next.detail}` : ''}`);
    try {
      this.opts.onState?.(this.current);
    } catch (err) {
      log.warn('onState handler failed', err);
    }
    return this.current;
  }

  private fail(message: string): DesktopLocalStackState {
    log.error(message);
    return this.set({ phase: 'failed', failureKind: 'other', error: message, detail: message });
  }

  // ---------------------------------------------------------------- start / stop

  async start(): Promise<DesktopLocalStackState> {
    if (this.current.phase === 'running') return this.current;
    if (STARTING_PHASES.includes(this.current.phase)) return this.current;

    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;

    try {
      this.set({ phase: 'starting', detail: 'Preparing the native stack', error: undefined, failureKind: undefined });

      const bundle = await this.ensureBundle(signal);
      if (signal.aborted) return this.stopped();

      const ports = await this.ensurePorts(signal);
      if (signal.aborted) return this.stopped();

      const secrets = this.ensureSecrets();
      const stackEnv = this.stackEnv(bundle.dir, ports, secrets);

      this.set({ phase: 'starting', detail: 'Preparing the database' });
      await this.runMigrations(bundle.dir, stackEnv);
      if (signal.aborted) return this.stopped();

      this.set({ phase: 'starting', detail: 'Starting the Orbit server' });
      const service = new Service(
        {
          name: 'api',
          binary: this.opts.electronBinary ?? process.execPath,
          args: [path.join(bundle.dir, this.opts.manifest.entrypoints.api)],
          env: stackEnv,
          logDir: this.logDir,
        },
        {
          spawn: this.opts.spawn,
          timers: this.opts.timers,
          now: this.opts.now,
          startedAfterMs: this.opts.serviceStartedMs,
          stopGraceMs: this.opts.stopGraceMs,
        },
      );
      this.api = service;
      try {
        await service.start();
      } catch (err) {
        this.api = null;
        return this.fail(`${errorText(err)}. See ${path.join(this.logDir, 'api.log')}.`);
      }

      if (signal.aborted) {
        await service.stop();
        this.api = null;
        return this.stopped();
      }

      const webUrl = `http://127.0.0.1:${ports.web}`;
      const healthy = await this.waitForHealth(ports.api, secrets.stack_token, signal);
      if (signal.aborted) {
        await service.stop();
        this.api = null;
        return this.stopped();
      }
      if (!healthy) {
        await service.stop();
        this.api = null;
        return this.fail(
          'The Orbit server started but did not answer /api/health within 30 seconds. ' +
            `See ${path.join(this.logDir, 'api.log')}.`,
        );
      }

      return this.set({ phase: 'running', detail: 'Orbit is running', webUrl, progress: 1 });
    } catch (err) {
      if (signal.aborted) return this.stopped();
      return this.fail(errorText(err));
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  async stop(): Promise<DesktopLocalStackState> {
    this.abortController?.abort();
    this.abortController = null;

    const service = this.api;
    this.api = null;
    if (!service) {
      return this.set({ phase: 'stopped', detail: 'Stopped', webUrl: undefined, progress: undefined });
    }

    this.set({ phase: 'stopping', detail: 'Stopping the Orbit server' });
    await service.stop();
    return this.set({ phase: 'stopped', detail: 'Stopped', webUrl: undefined, progress: undefined });
  }

  /** Abort an in-flight start. The processes it already spawned are stopped by that start. */
  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Quit-time: kill the children now, no grace, no restart. */
  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.api?.dispose();
    this.api = null;
  }

  private stopped(): DesktopLocalStackState {
    return this.set({ phase: 'stopped', detail: 'Stopped', progress: undefined });
  }

  // ---------------------------------------------------------------- steps

  /** Install the version the manifest names, unless it is already on disk. */
  private async ensureBundle(signal: AbortSignal): Promise<InstalledBundle> {
    const exists = this.opts.exists ?? ((file: string) => fs.existsSync(file));
    const targetDir = path.join(this.bundleDir, `orbit-server-${this.opts.manifest.version}`);
    const apiEntry = path.join(targetDir, this.opts.manifest.entrypoints.api);

    if (exists(apiEntry)) {
      return { version: this.opts.manifest.version, dir: targetDir, current: path.join(this.bundleDir, 'current'), downloaded: false };
    }

    if (signal.aborted) throw new NativeStackError('aborted');
    const install = this.opts.install ?? ((manifest: ServerManifest, dir: string) => installServerBundle(manifest, dir));
    this.set({ phase: 'starting', detail: `Downloading the Orbit server ${this.opts.manifest.version}` });

    try {
      return await install(this.opts.manifest, this.bundleDir);
    } catch (err) {
      throw new NativeStackError(`could not install the Orbit server bundle: ${errorText(err)}`);
    }
  }

  /**
   * The persisted pair, when both ports are still free; otherwise a fresh pair, written
   * back. Stable ports matter beyond convenience: the renderer's session partition is
   * derived from the origin, so a moving port would log the user out on every launch.
   */
  private async ensurePorts(signal: AbortSignal): Promise<NativePorts> {
    const isFree = this.opts.isPortFree ?? ((port: number) => this.defaultIsPortFree(port));
    const existing = readNativePorts(this.portsFile, this.range);
    if (existing && (await isFree(existing.api)) && (await isFree(existing.web))) return existing;
    if (existing) log.warn('persisted native ports are in use; allocating a new pair');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (signal.aborted) throw new NativeStackError('aborted');
      const api = await this.allocatePort();
      const web = await this.allocatePort();
      if (api === web) continue;
      if (!(await isFree(api)) || !(await isFree(web))) continue;
      const ports = { api, web };
      writeNativePorts(this.portsFile, ports);
      log.info(`native ports: api ${api}, web ${web}`);
      return ports;
    }
    throw new NativeStackError('could not find two free ports in 40000-49999 after eight attempts');
  }

  private async allocatePort(): Promise<number> {
    if (this.opts.allocatePort) return this.opts.allocatePort();
    const [min, max] = this.range;
    const span = max - min + 1;
    const isFree = this.opts.isPortFree ?? ((port: number) => this.defaultIsPortFree(port));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = min + Math.floor(Math.random() * span);
      if (await isFree(candidate)) return candidate;
    }
    // Unlikely; the ring above is 10k ports wide. The OS picks a free one as a fallback.
    return allocateLoopbackPort();
  }

  private async defaultIsPortFree(port: number): Promise<boolean> {
    const bind: BindFn = bindLoopback;
    try {
      const result = await bind(port, '127.0.0.1');
      result.close();
      return true;
    } catch {
      return false;
    }
  }

  /** Two 32-byte hex secrets, generated once and kept in `secrets.json` (0600). */
  private ensureSecrets(): { session_secret: string; stack_token: string } {
    const generate = this.opts.generateSecret ?? (() => randomHex(32));
    let secrets: Record<string, string> = {};
    try {
      secrets = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as Record<string, string>;
    } catch {
      secrets = {};
    }

    let changed = false;
    for (const name of ['session_secret', 'stack_token'] as const) {
      if (!secrets[name]) {
        secrets[name] = generate();
        changed = true;
      }
    }

    if (changed) {
      fs.mkdirSync(this.stackDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.secretsFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        /* Windows */
      }
      fs.renameSync(tmp, this.secretsFile);
    }

    return { session_secret: secrets.session_secret, stack_token: secrets.stack_token };
  }

  private stackEnv(
    bundleDir: string,
    ports: NativePorts,
    secrets: { session_secret: string; stack_token: string },
  ): NodeJS.ProcessEnv {
    const userData = this.opts.userDataDir;
    return {
      ...this.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(ports.api),
      WEB_PORT: String(ports.web),
      DB_PATH: path.join(userData, 'orbit.db'),
      ENGINES_DIR: path.join(userData, 'engines'),
      COMPUTER_HOME_DIR: path.join(userData, 'computer-homes'),
      SESSION_SECRET: secrets.session_secret,
      STACK_TOKEN: secrets.stack_token,
      HERMES_HOME: this.opts.hermesHome ?? path.join(os.homedir(), '.hermes'),
      // `ensureHermesApiKey` writes HERMES_KEY into the stack `.env` for the Docker path;
      // read it back here so the MCP bearer is the same in both stacks.
      ...this.hermesKey(),
      // The bundle root, so the API can serve `web/` from the same directory it ran from.
      ORBIT_BUNDLE_DIR: bundleDir,
    };
  }

  private hermesKey(): { HERMES_KEY?: string } {
    try {
      const text = fs.readFileSync(path.join(this.stackDir, '.env'), 'utf8');
      const key = envValue(text, 'HERMES_KEY');
      return key ? { HERMES_KEY: key } : {};
    } catch {
      return {};
    }
  }

  /**
   * Run `dist/migrate.js` when the bundle has one. Orbit's server creates its schema at
   * import time, so a bundle without a migrate entrypoint is complete, not broken — but a
   * manifest that *promises* one and a tarball that lacks it is a release bug worth naming.
   */
  private async runMigrations(bundleDir: string, env: NodeJS.ProcessEnv): Promise<void> {
    const migrate = this.opts.manifest.entrypoints.migrate;
    if (!migrate) {
      log.info('the bundle has no migrate entrypoint; the server creates its schema on boot');
      return;
    }

    const exists = this.opts.exists ?? ((file: string) => fs.existsSync(file));
    const entry = path.join(bundleDir, migrate);
    if (!exists(entry)) {
      throw new NativeStackError(
        `the server bundle declares entrypoints.migrate ("${migrate}") but ${entry} is missing. ` +
          'The release artifact does not match server-bundle.json; reinstall Orbit.',
      );
    }

    const exec = this.opts.exec;
    if (!exec) {
      log.warn('no exec seam: skipping migrations');
      return;
    }
    const result = await exec(this.opts.electronBinary ?? process.execPath, [entry], {
      env,
      timeoutMs: 120_000,
    });
    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-4).join(' | ');
      throw new NativeStackError(`database migration failed (exit ${result.code}): ${detail}`);
    }
  }

  private async waitForHealth(apiPort: number, stackToken: string, signal: AbortSignal): Promise<boolean> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeoutMs = this.opts.healthTimeoutMs ?? 30_000;
    const intervalMs = this.opts.healthIntervalMs ?? 500;
    const url = `http://127.0.0.1:${apiPort}/api/health`;
    const deadline = (this.opts.now ?? Date.now)() + timeoutMs;

    while ((this.opts.now ?? Date.now)() < deadline) {
      if (signal.aborted) return false;
      try {
        const res = await fetchImpl(url, {
          headers: { [ORBIT_HEADERS.stackToken]: stackToken, [ORBIT_HEADERS.desktop]: '1' },
          signal: AbortSignal.timeout(Math.min(5_000, intervalMs * 4)),
        });
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean };
          if (body?.ok === true) return true;
        }
      } catch {
        /* connection refused until the server binds; that is the normal case here */
      }
      this.set({
        phase: 'waiting-healthy',
        detail: 'Waiting for Orbit to answer…',
        progress: Math.min(0.99, Math.max(0, 1 - (deadline - (this.opts.now ?? Date.now)()) / timeoutMs)),
      });
      await sleep(intervalMs);
    }
    return false;
  }
}

/** Exported for the setup window's "what is running" line. */
export function describeNativeState(state: DesktopLocalStackState): string {
  switch (state.phase) {
    case 'running':
      return 'Orbit is running (native)';
    case 'failed':
      return state.error ?? 'The native stack failed to start';
    default:
      return state.detail ?? state.phase;
  }
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
