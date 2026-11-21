/**
 * Orbit's server in Docker Compose, driven from the main process. Every phase is observable
 * because each one maps to a line of text in the setup window.
 *
 * Secrets never round-trip through IPC: they are generated into the stack `.env` (0600) and
 * the `/api/health` probe carries only STACK_TOKEN.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ORBIT_HEADERS, type DesktopGpuVoice } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import { DEFAULT_LOCAL_WEB_URL, normalizeServerUrl } from './setup-config';
import { allocateLoopbackPort, bindLoopback } from './loopback-port';
import {
  REQUIRED_SECRETS,
  envValue,
  fillEmptySecrets,
  migrateLegacyBotCap,
  missingStackSecrets,
  normalizeEol,
  setEnvValue,
} from './env-file';
import {
  classifyDockerFailure,
  failureText,
  resolveDockerBinary,
  runDocker,
  type DockerResult,
} from './docker-cli';
import {
  readStackToken,
  readStackWebUrl,
  writeStackToken,
  writeStackWebUrl,
} from './local-stack-networking';
import { sessionSecretFromEnvFile } from './desktop-session';
import { hermesHome } from './hermes-setup';
import { applyGpuVoice, detectNvidiaGpu, gpuProfileArgs, gpuPullError, gpuVoiceEnabled, gpuVoiceSupport, type RunFile } from './gpu-voice';
import type { DockerStack } from './stack-controller';
import type { DesktopLocalStackState, DockerFailureKind, StackPhase } from './shared/api';

const log = createLogger({ scope: 'stack' });

// Re-exported so callers (and tests) can keep importing the stack's helpers from here.
export { REQUIRED_SECRETS, envValue, fillEmptySecrets, missingStackSecrets, setEnvValue };
export { allocateLoopbackPort, bindLoopback } from './loopback-port';
export type { BindFn, BindResult } from './loopback-port';
export type { SecretSpec } from './env-file';

export interface DockerRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `docker compose run` arguments for the one-shot import of a Hermes home into the primary
 * agent's (apps/server/src/import-hermes.ts). `compose run` rather than `docker run`: it uses the
 * api service's image, user and the project's own data volume, whatever compose names it.
 */
export function hostHermesImportArgs(source: string): string[] {
  return ['run', '--rm', '--no-deps', '-T', '-v', `${source}:/import:ro`, 'api', 'node', 'dist/import-hermes.js', '/import', '/data/engines/primary'];
}

// ------------------------------------------------------------------ controller

export interface LocalStackOptions {
  userDataDir: string;
  appRoot: string;
  version: string;
  packaged: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Overrides the resolved `extraResources/stack` or `infra/compose` folder. */
  resourcesDir?: string;
  exists?: (file: string) => boolean;
  exec?: (binary: string, args: string[], opts?: DockerRunOptions) => Promise<DockerResult>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  allocatePort?: () => Promise<number>;
  /** Can the last launch's port be bound again? Injected in tests. */
  isPortFree?: (port: number) => Promise<boolean>;
  launchDockerDesktop?: (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Runs `nvidia-smi` for GPU detection; injected in tests. */
  runFile?: RunFile;
  onState?: (state: DesktopLocalStackState) => void;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  daemonWaitMs?: number;
}

/**
 * The two names the stack dir always has. A checkout holds the images pair under their own
 * names (and no `.env.example`); packaged builds get them from `extraResources/stack`.
 */
const STACK_FILES: ReadonlyArray<{ target: string; candidates: readonly string[] }> = [
  { target: 'docker-compose.yml', candidates: ['docker-compose.images.yml', 'docker-compose.yml'] },
  { target: '.env.example', candidates: ['.env.images.example', '.env.example'] },
];

/** A compose file that builds from the repo root: `../..` is not the repo once staged. */
const SOURCE_BUILD_CONTEXT = /^\s*context:\s*['"]?\.\.\/\.\.['"]?\s*$/m;

/** One probe's signal: the caller's (stop/abort), but never longer than five seconds. */
function probeSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(5_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class LocalStackController implements DockerStack {
  readonly kind = 'docker' as const;
  readonly stackDir: string;
  private readonly opts: Required<Pick<LocalStackOptions, 'userDataDir' | 'appRoot' | 'version' | 'packaged'>> &
    LocalStackOptions;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private current: DesktopLocalStackState;
  private abortController: AbortController | null = null;
  private inFlight: Promise<DesktopLocalStackState> | null = null;
  /** The GPU voice install/remove in progress or last failed, for the settings to show. */
  private gpu: { phase: DesktopGpuVoice['phase']; detail?: string; error?: string } | null = null;
  private gpuName: Promise<string | null> | null = null;

  constructor(options: LocalStackOptions) {
    this.opts = { ...options };
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    const override = this.env.ORBIT_STACK_DIR?.trim();
    this.stackDir = override || path.join(options.userDataDir, 'stack');
    this.current = { phase: 'idle', at: Date.now(), detail: 'Not started' };
  }

  resourceDir(): string {
    if (this.opts.resourcesDir) return this.opts.resourcesDir;
    if (this.opts.packaged) {
      const resourcesPath =
        (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ??
        path.join(path.dirname(process.execPath), '..', 'Resources');
      return path.join(resourcesPath, 'stack');
    }
    return path.resolve(this.opts.appRoot, '..', '..', 'infra', 'compose');
  }

  state(): DesktopLocalStackState {
    return this.current;
  }

  webUrl(): string {
    return this.current.webUrl ?? readStackWebUrl(this.stackDir, DEFAULT_LOCAL_WEB_URL);
  }

  token(): string | null {
    return readStackToken(this.stackDir);
  }

  sessionSecret(): string | null {
    return sessionSecretFromEnvFile(path.join(this.stackDir, '.env'));
  }

  /**
   * Is the stack at `desiredUrl` the one this controller runs?
   *
   * A matching URL is not enough: another Orbit server (an older image, a colleague's stack)
   * can hold the same port. `GET /api/desktop/probe` answers with the image tag it runs, so
   * only a probe that both accepts our stack token and reports the tag we want counts. An
   * old server without the endpoint, or one we cannot reach, is not ours.
   */
  async matchesDesiredStack(desiredUrl?: string): Promise<boolean> {
    if (this.current.phase !== 'ready') return false;
    const desired = normalizeServerUrl(desiredUrl ?? this.current.webUrl ?? this.webUrl());
    if (!desired || desired !== normalizeServerUrl(this.current.webUrl ?? this.webUrl())) return false;
    const token = this.token();
    if (!token) return false;
    const probe = await this.probe(desired, token);
    return probe?.imageTag === this.imageTag();
  }

  private async probe(
    webUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ imageTag?: string; version?: string } | null> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${webUrl}/api/desktop/probe`, {
        headers: { [ORBIT_HEADERS.stackToken]: token, [ORBIT_HEADERS.desktop]: '1' },
        // Always bounded: Docker Desktop's port proxy accepts a connection before the container
        // listens and can then leave the request hanging, which used to stall start() for good.
        signal: probeSignal(signal),
      });
      if (!res.ok) return null;
      return (await res.json()) as { imageTag?: string; version?: string };
    } catch {
      return null;
    }
  }

  private set(next: Partial<DesktopLocalStackState> & { phase: StackPhase }): DesktopLocalStackState {
    this.current = { ...this.current, ...next, at: (this.opts.now ?? Date.now)() };
    if (next.phase !== undefined) log.info(`${next.phase}${next.detail ? `: ${next.detail}` : ''}`);
    try {
      this.opts.onState?.(this.current);
    } catch (err) {
      log.warn('onState handler failed', err);
    }
    return this.current;
  }

  private fail(kind: DockerFailureKind, message: string): DesktopLocalStackState {
    return this.set({ phase: 'failed', failureKind: kind, error: message, detail: message });
  }

  private exec(binary: string, args: string[], opts?: DockerRunOptions): Promise<DockerResult> {
    const runner = this.opts.exec ?? ((b, a, o) => runDocker(b, a, o));
    return runner(binary, args, { cwd: this.stackDir, ...opts });
  }

  private compose(binary: string, args: string[], opts?: DockerRunOptions) {
    return this.exec(
      binary,
      [
        'compose', '-f', path.join(this.stackDir, 'docker-compose.yml'), '--project-directory', this.stackDir, '--env-file', path.join(this.stackDir, '.env'),
        // The GPU voice sidecar runs only when the person installed it (ORBIT_GPU_VOICE=1).
        ...gpuProfileArgs(this.envText(), this.platform),
        ...args,
      ],
      opts,
    );
  }

  private envText(): string {
    try {
      return normalizeEol(fs.readFileSync(path.join(this.stackDir, '.env'), 'utf8'));
    } catch {
      return '';
    }
  }

  private writeEnv(text: string): void {
    const envPath = path.join(this.stackDir, '.env');
    fs.writeFileSync(envPath, text, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      /* Windows */
    }
  }

  /**
   * Are all images the stack needs already on this machine? A tag that is not on the registry (a
   * locally built image, an installer tested before its release published) still runs then.
   */
  private async imagesPresent(binary: string, signal?: AbortSignal): Promise<boolean> {
    const listed = await this.compose(binary, ['config', '--images'], { timeoutMs: 30_000, signal });
    if (listed.code !== 0) return false;
    const images = listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!images.length) return false;
    const inspect = await this.exec(binary, ['image', 'inspect', '--format', '{{.Id}}', ...images], { timeoutMs: 30_000, signal });
    return inspect.code === 0;
  }

  /**
   * The port the last launch used, when it can serve again: free, or still held by this stack's
   * own server. Keeping it keeps the web origin, so the session and the page's storage survive a
   * restart, and keeps the compose config, so `up -d` resumes the containers instead of
   * recreating them.
   */
  private async reusablePort(signal?: AbortSignal): Promise<number | null> {
    const port = Number(envValue(this.envText(), 'ORBIT_WEB_PORT'));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    const isFree = this.opts.isPortFree ?? (async (p: number) => {
      try {
        (await bindLoopback(p, '127.0.0.1')).close();
        return true;
      } catch {
        return false;
      }
    });
    const token = envValue(this.envText(), 'STACK_TOKEN');
    if (token && (await this.probeHealth(`http://127.0.0.1:${port}`, token, signal))) return port;
    // Docker's port forwarder lets go of a stopped container's port a moment after the stop, so a
    // relaunch right after a quit waits for it rather than moving the app to a new origin.
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await isFree(port)) return port;
      if (signal?.aborted) return null;
      await sleep(500);
    }
    log.info(`port ${port} from the last launch is taken by something else; picking another`);
    return null;
  }

  /**
   * The server image tag: this release's own tag when packaged, `edge` in development.
   * `ORBIT_IMAGE_TAG` overrides both (support, and testing an installer before its release
   * has published images).
   */
  private pinnedTag(): boolean {
    return /^v\d+\.\d+\.\d+/.test(this.imageTag());
  }

  private imageTag(): string {
    const forced = this.env.ORBIT_IMAGE_TAG?.trim();
    if (forced && /^[\w][\w.-]{0,127}$/.test(forced)) return forced;
    return this.opts.packaged ? `v${this.opts.version}` : 'edge';
  }

  /**
   * Copy compose + `.env.example` into the stack dir on first run, under the fixed names the
   * controller uses: in a dev tree that means the images pair, because the source-build file's
   * context points outside `userData/stack` and can never start there.
   */
  private prepareFiles(): void {
    fs.mkdirSync(this.stackDir, { recursive: true, mode: 0o700 });
    const resources = this.resourceDir();
    for (const { target, candidates } of STACK_FILES) {
      const destination = path.join(this.stackDir, target);
      const source = candidates.map((name) => path.join(resources, name)).find((file) => fs.existsSync(file));
      if (fs.existsSync(destination) && !this.stageOverStale(destination, target)) continue;
      if (!source) {
        throw new MissingResourceError(path.join(resources, candidates[0]), resources);
      }
      fs.copyFileSync(source, destination);
      try {
        fs.chmodSync(destination, 0o600);
      } catch {
        /* Windows */
      }
    }
  }

  /**
   * Should an existing file in the stack dir be replaced by the bundled one? Both cases ship a
   * fix to an install that already ran: a dev profile holding the source-build compose file
   * (which can never start), and any app whose bundled compose changed since it was staged (a
   * new service, a healthcheck, a fixed env default) — otherwise upgrades never reach existing
   * stacks. `.env.example` is only a template, so it follows the bundle too (an old install could
   * have staged one with broken line endings). `.env` is never replaced, so generated secrets and
   * the user's edits survive.
   */
  private stageOverStale(destination: string, target: string): boolean {
    try {
      const staged = fs.readFileSync(destination, 'utf8');
      if (target === 'docker-compose.yml' && !this.opts.packaged && SOURCE_BUILD_CONTEXT.test(staged)) return true;
      const bundled = this.bundledFile(target);
      return Boolean(bundled) && bundled !== staged;
    } catch {
      return false;
    }
  }

  private bundledFile(target: string): string | null {
    const resources = this.resourceDir();
    const source = STACK_FILES.find((f) => f.target === target)
      ?.candidates.map((name) => path.join(resources, name))
      .find((file) => fs.existsSync(file));
    if (!source) return null;
    try {
      return fs.readFileSync(source, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Create `stack/.env` from the bundled example if it is missing, and return its path, for a
   * caller that edits the file outside `start()` (the GPU voice switch).
   */
  prepareEnvFile(): string | null {
    const envPath = path.join(this.stackDir, '.env');
    if (fs.existsSync(envPath)) {
      // Fill any secrets missing from an older install — e.g. SANDBOX_SUPERVISOR_TOKEN added
      // after the user's first run. start() calls prepareEnv() too, but doing it here means
      // a caller sees a complete file before compose ever runs.
      try {
        const raw = fs.readFileSync(envPath, 'utf8');
        const existing = normalizeEol(raw);
        if (existing !== raw) log.info('rewrote the stack .env with LF line endings');
        const { text: filledText, generated } = fillEmptySecrets(existing);
        const { text, changed } = migrateLegacyBotCap(filledText);
        if (changed) log.info('removed the old MAX_BOTS=4 template default from the stack .env');
        if (text !== raw) {
          fs.writeFileSync(envPath, text, { encoding: 'utf8', mode: 0o600 });
          try {
            fs.chmodSync(envPath, 0o600);
          } catch {
            /* Windows */
          }
        }
      } catch {
        /* non-fatal: prepareEnv() in start() fills secrets before compose runs */
      }
      return envPath;
    }
    try {
      this.prepareFiles();
    } catch (err) {
      log.warn('could not stage the stack files', err);
      return null;
    }
    const example = path.join(this.stackDir, '.env.example');
    if (!fs.existsSync(example)) return null;
    fs.writeFileSync(envPath, normalizeEol(fs.readFileSync(example, 'utf8')), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      /* Windows */
    }
    return envPath;
  }

  /**
   * Read `.env`, fill secrets, pin the image tag, port and URLs, write it back 0600.
   *
   * The port is always the one the controller decided on: the example file pins 8787, and a
   * leftover 8787 makes a port collision unrecoverable — `up` retried on the busy port while
   * health was polled at a URL nothing served.
   */
  private prepareEnv(port: number): { token: string; webUrl: string } {
    const envPath = path.join(this.stackDir, '.env');
    const existing = normalizeEol(
      fs.existsSync(envPath)
        ? fs.readFileSync(envPath, 'utf8')
        : fs.readFileSync(path.join(this.stackDir, '.env.example'), 'utf8'),
    );

    const filled = fillEmptySecrets(existing);
    let text = migrateLegacyBotCap(filled.text).text;
    text = setEnvValue(text, 'ORBIT_IMAGE_TAG', this.imageTag());
    text = setEnvValue(text, 'ORBIT_VERSION', this.opts.version);
    text = setEnvValue(text, 'ORBIT_WEB_PORT', String(port));
    const webUrl = `http://127.0.0.1:${port}`;
    // The server builds cookie flags, redirects and sign-in links from these, so they have to
    // describe the port we actually bound rather than the example file's 8787.
    text = setEnvValue(text, 'APP_URL', webUrl);
    text = setEnvValue(text, 'SERVER_URL', webUrl);
    // GPU voice follows the person's choice (and is always off on macOS).
    text = applyGpuVoice(text, gpuVoiceEnabled(text, this.platform), this.platform);
    fs.writeFileSync(envPath, text, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      /* Windows */
    }

    const token = envValue(text, 'STACK_TOKEN');
    if (!token) throw new Error('the stack .env has no STACK_TOKEN after generation');
    writeStackToken(this.stackDir, token);
    writeStackWebUrl(this.stackDir, webUrl);
    return { token, webUrl };
  }

  /**
   * Seed the primary agent's home from this computer's own Hermes before the stack starts. The
   * stack mounts nothing from the host, so the import runs in a throwaway container of the api
   * service with the Hermes home mounted read-only for that run alone. It is idempotent (a marker
   * in the primary's home on the data volume), so after the first start it only costs a container
   * start. A failure is logged and the stack starts anyway: the agents simply have no keys yet.
   */
  private async importHostHermes(binary: string, signal: AbortSignal): Promise<void> {
    const source = hermesHome(this.env);
    if (!fs.existsSync(source)) return;
    this.set({ phase: 'starting', detail: 'Importing your Hermes settings', progress: 0.4 });
    const result = await this.compose(binary, hostHermesImportArgs(source), { timeoutMs: 120_000, signal });
    if (result.code === 0) log.info(`hermes import: ${result.stdout.trim().split('\n').pop() ?? ''}`);
    else log.warn(`importing ${source} into the primary agent failed; starting without it`, failureText(result));
  }

  private async daemonUp(binary: string, signal?: AbortSignal): Promise<{ up: boolean; text: string }> {
    const result = await this.exec(binary, ['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 20_000,
      signal,
    });
    return { up: result.code === 0, text: failureText(result) };
  }

  private async waitForDaemon(binary: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      const { up } = await this.daemonUp(binary, signal);
      if (up) return true;
      this.set({ phase: 'checking-docker', detail: 'Waiting for Docker Desktop to start…' });
      await sleep(2_000);
    }
    return false;
  }

  /**
   * Is the thing answering `/api/health` this stack? `{ ok: true }` alone proves only that *an*
   * Orbit server is there. The server echoes `stackToken: 'verified'` only when the caller
   * presented the STACK_TOKEN it was started with — the one thing a stranger cannot fake.
   */
  private async probeHealth(webUrl: string, token: string, signal?: AbortSignal): Promise<boolean> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${webUrl}/api/health`, {
        headers: { [ORBIT_HEADERS.stackToken]: token, [ORBIT_HEADERS.desktop]: '1' },
        // Always bounded: Docker Desktop's port proxy accepts a connection before the container
        // listens and can then leave the request hanging, which used to stall start() for good.
        signal: probeSignal(signal),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; stackToken?: string };
      return body?.ok === true && body.stackToken === 'verified';
    } catch {
      return false;
    }
  }

  private async waitForHealth(webUrl: string, token: string, signal: AbortSignal): Promise<boolean> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const timeoutMs = this.opts.healthTimeoutMs ?? 120_000;
    const intervalMs = this.opts.healthIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) return false;
      if (await this.probeHealth(webUrl, token, signal)) return true;
      const remaining = Math.max(0, deadline - Date.now());
      this.set({
        phase: 'waiting-healthy',
        detail: 'Waiting for Orbit to answer…',
        progress: Math.min(0.99, 1 - remaining / timeoutMs),
      });
      await sleep(Math.min(intervalMs, remaining || intervalMs));
    }
    return false;
  }

  /**
   * Bring the stack up, or join the start already running: a second caller (a Dock click, a
   * retry button) waits for the same outcome instead of reading a half-done phase as the result.
   */
  start(): Promise<DesktopLocalStackState> {
    if (this.current.phase === 'ready') return Promise.resolve(this.current);
    this.inFlight ??= this.bringUp().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async bringUp(): Promise<DesktopLocalStackState> {
    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;

    try {
      this.set({ phase: 'checking-docker', detail: 'Looking for Docker', error: undefined, failureKind: undefined });

      // Every docker call runs with the stack dir as its cwd, and on a first run it is not
      // there yet: `spawn` answers ENOENT for a missing cwd, which would look like a broken
      // Docker install. The folder is cheap and idempotent to create.
      fs.mkdirSync(this.stackDir, { recursive: true, mode: 0o700 });

      const exists = this.opts.exists ?? ((file: string) => fs.existsSync(file));
      const binary = resolveDockerBinary(this.platform, this.env, exists);
      if (!binary) {
        return this.set({
          phase: 'docker-missing',
          detail: 'Docker is not installed',
          error: 'Orbit needs Docker Desktop to run its server on this computer.',
        });
      }

      let daemon = await this.daemonUp(binary, signal);
      if (!daemon.up) {
        const kind = classifyDockerFailure(daemon.text);
        if (kind === 'socket-permission') {
          return this.fail(
            kind,
            'Docker is installed but this user cannot reach its socket. Add yourself to the docker group (Linux) and restart Orbit.',
          );
        }
        if (kind === 'daemon-down') {
          this.set({ phase: 'checking-docker', detail: 'Starting Docker Desktop…' });
          try {
            const launch = this.opts.launchDockerDesktop ?? launchDockerDesktopDefault;
            await launch(this.platform, this.env);
          } catch (err) {
            log.warn('could not launch Docker Desktop', err);
          }
          daemon = { up: await this.waitForDaemon(binary, this.opts.daemonWaitMs ?? 90_000, signal), text: daemon.text };
          if (!daemon.up) {
            return this.set({
              phase: 'docker-not-running',
              detail: 'Docker is not running',
              error: 'Start Docker Desktop, then try again.',
              failureKind: 'daemon-down',
            });
          }
        } else {
          return this.set({
            phase: 'docker-not-running',
            detail: 'Docker is not answering',
            error: daemon.text.split('\n')[0] || 'docker info failed',
            failureKind: kind,
          });
        }
      }

      this.set({ phase: 'preparing', detail: 'Preparing the stack folder' });
      try {
        this.prepareFiles();
      } catch (err) {
        if (err instanceof MissingResourceError) {
          return this.fail('compose-missing', err.message);
        }
        throw err;
      }
      const allocate = this.opts.allocatePort ?? (() => allocateLoopbackPort());
      const port = (await this.reusablePort(signal)) ?? (await allocate());
      let prepared = this.prepareEnv(port);
      let webUrl = prepared.webUrl;

      // A release tag names fixed images, so once they are on this machine every later launch
      // just starts them. `edge` moves, so development pulls unless ORBIT_SKIP_PULL=1 (the dev
      // rebuild loop) says the local image, built from the working tree, is the one to run.
      const reuseLocal = this.pinnedTag() || this.env.ORBIT_SKIP_PULL?.trim() === '1';
      if (reuseLocal && (await this.imagesPresent(binary, signal))) {
        log.info(`using the local ghcr.io/raybello/orbit/app:${this.imageTag()}, not pulling`);
      } else {
        this.set({ phase: 'pulling', detail: `Pulling ghcr.io/raybello/orbit/app:${this.imageTag()}`, progress: 0.1 });
        const pull = await this.compose(binary, ['pull', '--quiet'], { timeoutMs: 600_000, signal });
        if (pull.code !== 0) {
          const kind = classifyDockerFailure(failureText(pull));
          if (kind === 'image-not-found' && !(await this.imagesPresent(binary, signal))) {
            return this.fail(kind, `The image ghcr.io/raybello/orbit/app:${this.imageTag()} is not published yet.`);
          }
          if (signal.aborted) return this.set({ phase: 'idle', detail: 'Stopped' });
          // A pull can fail for a local-only tag or a flaky registry while usable images
          // are cached; let `up` be the judge instead of failing here.
          log.warn(`compose pull failed (${kind}); continuing`);
        }
      }

      await this.importHostHermes(binary, signal);
      if (signal.aborted) return this.set({ phase: 'idle', detail: 'Stopped' });

      this.set({ phase: 'starting', detail: 'Starting the stack', progress: 0.5 });
      let up = await this.compose(binary, ['up', '-d', '--remove-orphans'], { timeoutMs: 300_000, signal });

      // The port we picked can be taken between allocating and binding. Retry twice — on a
      // *new* port, which means the `.env` and the URL we will poll both have to move with it.
      for (let attempt = 0; up.code !== 0 && attempt < 2; attempt += 1) {
        const kind = classifyDockerFailure(failureText(up));
        if (kind !== 'port-in-use') break;
        const retryPort = await allocate();
        log.warn(`port in use; retrying on ${retryPort}`);
        this.set({ phase: 'starting', detail: `Port busy, retrying on ${retryPort}` });
        prepared = this.prepareEnv(retryPort);
        webUrl = prepared.webUrl;
        up = await this.compose(binary, ['up', '-d', '--remove-orphans'], { timeoutMs: 300_000, signal });
      }

      if (up.code !== 0) {
        if (signal.aborted) return this.set({ phase: 'idle', detail: 'Stopped' });
        const kind = classifyDockerFailure(failureText(up));
        return this.fail(kind, summarizeDockerFailure(up));
      }

      const healthy = await this.waitForHealth(webUrl, prepared.token, signal);
      if (signal.aborted) return this.set({ phase: 'idle', detail: 'Stopped' });
      if (!healthy) {
        return this.fail(
          'other',
          'The stack started but Orbit did not answer /api/health within two minutes. Check `docker compose logs`.',
        );
      }

      return this.set({ phase: 'ready', detail: 'Orbit is running', webUrl, progress: 1 });
    } catch (err) {
      if (signal.aborted) return this.set({ phase: 'idle', detail: 'Stopped' });
      const message = err instanceof Error ? err.message : String(err);
      log.error('stack start failed', err);
      return this.fail('other', message);
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  async stop(): Promise<DesktopLocalStackState> {
    this.abortController?.abort();
    this.abortController = null;
    const exists = this.opts.exists ?? ((file: string) => fs.existsSync(file));
    const binary = resolveDockerBinary(this.platform, this.env, exists);
    if (binary && this.current.phase !== 'idle') {
      try {
        // `stop`, not `down`: the containers, their volumes and the images stay, so the next
        // launch resumes them with `up -d` instead of recreating anything.
        // The server suspends each Bot's computer on SIGTERM (it saves the home folder), which can
        // outlast compose's default ten seconds; cutting it short with SIGKILL risks that save.
        const result = await this.compose(binary, ['stop', '--timeout', '30'], { timeoutMs: 120_000 });
        if (result.code !== 0) log.warn('compose stop failed', failureText(result));
      } catch (err) {
        log.warn('compose stop failed', err);
      }
    }
    return this.set({ phase: 'idle', detail: 'Stopped', webUrl: undefined, progress: undefined });
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async prefetch(version: string): Promise<void> {
    const exists = this.opts.exists ?? ((file: string) => fs.existsSync(file));
    const binary = resolveDockerBinary(this.platform, this.env, exists);
    if (!binary) throw new Error('Docker is not installed');
    // The shell environment wins over --env-file when compose interpolates, so this names the
    // new release's images without touching the running stack's .env.
    const tag = `v${version}`;
    const pull = await this.compose(binary, ['pull', '--quiet'], { timeoutMs: 1_800_000, env: { ...this.env, ORBIT_IMAGE_TAG: tag } });
    if (pull.code !== 0) throw new Error(`could not pull the ${tag} images: ${summarizeDockerFailure(pull)}`);
    log.info(`prefetched the ${tag} images`);
  }

  // ---------------------------------------------------------------- GPU voice

  private detectGpu(): Promise<string | null> {
    // A GPU does not come and go while the app runs; ask the driver once.
    return (this.gpuName ??= detectNvidiaGpu(this.opts.runFile));
  }

  /** Can this computer run the GPU voice sidecar, is it on, and what is it doing. */
  async gpuVoiceStatus(): Promise<DesktopGpuVoice> {
    const support = gpuVoiceSupport(this.platform, this.platform === 'darwin' ? null : await this.detectGpu(), 'docker');
    const enabled = gpuVoiceEnabled(this.envText(), this.platform);
    const busy = this.gpu?.phase === 'installing' || this.gpu?.phase === 'removing' || this.gpu?.phase === 'error';
    const phase: DesktopGpuVoice['phase'] = busy ? this.gpu!.phase : enabled ? 'on' : 'off';
    return { ...support, enabled, phase, detail: this.gpu?.detail, error: phase === 'error' ? this.gpu?.error : undefined };
  }

  /**
   * Install (pull and start the sidecar, then recreate the api pointed at it) or remove it. The
   * choice is written first, so a stack started later honours it even if this run is interrupted.
   * Models are not part of this: the GPU voice settings download them, with progress, afterwards.
   */
  async setGpuVoice(on: boolean): Promise<DesktopGpuVoice> {
    const status = await this.gpuVoiceStatus();
    if (on && !status.supported) {
      const why = status.reason === 'macos' ? 'GPU voice needs an NVIDIA GPU; on a Mac, calls use on-device voice.' : 'No NVIDIA GPU was found on this computer.';
      this.gpu = { phase: 'error', error: why };
      return this.gpuVoiceStatus();
    }
    if (this.gpu?.phase === 'installing' || this.gpu?.phase === 'removing') return status;
    const exists = this.opts.exists ?? ((file: string) => fs.existsSync(file));
    const binary = resolveDockerBinary(this.platform, this.env, exists);
    if (!binary) {
      this.gpu = { phase: 'error', error: 'Docker is not installed.' };
      return this.gpuVoiceStatus();
    }
    try {
      if (!fs.existsSync(path.join(this.stackDir, '.env'))) this.prepareEnvFile();
      if (!on) {
        // Stop the sidecar while the profile is still on, so compose knows the service.
        this.gpu = { phase: 'removing', detail: 'Stopping the GPU voice server…' };
        const rm = await this.compose(binary, ['rm', '--stop', '--force', 'audiocpp'], { timeoutMs: 120_000 });
        if (rm.code !== 0) log.warn('could not remove the GPU voice sidecar', failureText(rm));
      }
      this.writeEnv(applyGpuVoice(this.envText(), on, this.platform));

      if (on) {
        this.gpu = { phase: 'installing', detail: 'Downloading the GPU voice server (about 4 GB)…' };
        const pull = await this.compose(binary, ['pull', '--quiet', 'audiocpp'], { timeoutMs: 3_600_000 });
        if (pull.code !== 0 && !(await this.imagesPresent(binary))) {
          this.writeEnv(applyGpuVoice(this.envText(), false, this.platform));
          this.gpu = { phase: 'error', error: gpuPullError(failureText(pull), this.imageTag(), summarizeDockerFailure(pull)) };
          return this.gpuVoiceStatus();
        }
      }
      if (this.current.phase === 'ready') {
        // `up -d` starts the sidecar and recreates the api, whose AUDIOCPP_URL just changed.
        this.gpu = { phase: on ? 'installing' : 'removing', detail: on ? 'Starting the GPU voice server…' : 'Restarting Orbit without GPU voice…' };
        const up = await this.compose(binary, ['up', '-d'], { timeoutMs: 300_000 });
        if (up.code !== 0) {
          this.gpu = { phase: 'error', error: summarizeDockerFailure(up) };
          return this.gpuVoiceStatus();
        }
        const token = this.token();
        const webUrl = this.current.webUrl;
        if (token && webUrl) await this.waitForHealth(webUrl, token, new AbortController().signal);
        if (webUrl) this.set({ phase: 'ready', detail: 'Orbit is running', webUrl, progress: 1 });
      }
      this.gpu = null;
    } catch (err) {
      log.error('GPU voice change failed', err);
      this.gpu = { phase: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    return this.gpuVoiceStatus();
  }
}

export class MissingResourceError extends Error {
  constructor(readonly source: string, readonly resources: string) {
    super(
      `The desktop app is missing its bundled stack files: ${source}. ` +
        `In a packaged build these come from extraResources/stack; in dev, run from a checkout ` +
        `that has infra/compose/docker-compose.yml and infra/compose/.env.example.`,
    );
    this.name = 'MissingResourceError';
  }
}

function summarizeDockerFailure(result: DockerResult): string {
  const lines = failureText(result)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.find((line) => /error|denied|no such|failed/i.test(line));
  return (useful ?? lines[0] ?? `docker exited with code ${result.code}`).slice(0, 400);
}

/** Start Docker Desktop the platform's way; failures are the caller's to log. */
export async function launchDockerDesktopDefault(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const spawnDetached = (command: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });

  if (platform === 'darwin') {
    await spawnDetached('open', ['-a', 'Docker']);
    return;
  }
  if (platform === 'win32') {
    const pf = env.PROGRAMFILES ?? 'C:\\Program Files';
    await spawnDetached(`${pf}\\Docker\\Docker\\Docker Desktop.exe`, []);
    return;
  }
  // Linux: docker is a service, not an app. Ask systemd, and let it fail quietly.
  await spawnDetached('systemctl', ['--user', 'start', 'docker']);
}

export function describeStackState(state: DesktopLocalStackState): string {
  switch (state.phase) {
    case 'docker-missing':
      return 'Docker is not installed';
    case 'docker-not-running':
      return 'Docker is not running';
    case 'ready':
      return 'Orbit is running';
    case 'failed':
      return state.error ?? 'The stack failed to start';
    default:
      return state.detail ?? state.phase;
  }
}
