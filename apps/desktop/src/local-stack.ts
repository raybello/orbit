/**
 * The local stack: Orbit's server in Docker Compose, driven from the main process.
 *
 * The state machine is deliberately linear and observable, because every phase maps to a
 * line of text in the setup window:
 *
 *   idle -> checking-docker -> docker-missing | docker-not-running
 *                            -> preparing -> pulling -> starting -> waiting-healthy -> ready
 *                                                                                 -> failed
 *
 * Secrets never round-trip through IPC: they are generated into the stack `.env` (0600)
 * and the `/api/health` probe carries only STACK_TOKEN.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ORBIT_HEADERS } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import { DEFAULT_LOCAL_WEB_URL, normalizeServerUrl } from './setup-config';
import { allocateLoopbackPort } from './loopback-port';
import {
  REQUIRED_SECRETS,
  envValue,
  fillEmptySecrets,
  missingStackSecrets,
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
import type { DesktopLocalStackState, DockerFailureKind, StackPhase } from './shared/api';

const log = createLogger({ scope: 'stack' });

// Re-exported so callers (and tests) can keep importing the stack's helpers from here.
export { REQUIRED_SECRETS, envValue, fillEmptySecrets, missingStackSecrets, setEnvValue };
export { allocateLoopbackPort, bindLoopback } from './loopback-port';
export type { BindFn, BindResult } from './loopback-port';
export type { SecretSpec } from './env-file';

/** The subset of runDocker's options the controller passes through (and tests fake). */
export interface DockerRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
}

// ------------------------------------------------------------------ controller

export interface LocalStackOptions {
  /** `app.getPath('userData')`. */
  userDataDir: string;
  /** `app.getAppPath()` in dev, so resources resolve relative to the checkout. */
  appRoot: string;
  version: string;
  packaged: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Overrides `extraResources/stack` / the dev checkout's `infra/compose`. */
  resourcesDir?: string;
  exists?: (file: string) => boolean;
  exec?: (binary: string, args: string[], opts?: DockerRunOptions) => Promise<DockerResult>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  allocatePort?: () => Promise<number>;
  launchDockerDesktop?: (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => Promise<void>;
  onState?: (state: DesktopLocalStackState) => void;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  daemonWaitMs?: number;
}

const ACTIVE_PHASES: StackPhase[] = [
  'checking-docker',
  'preparing',
  'pulling',
  'starting',
  'waiting-healthy',
];

/**
 * The two names the stack dir always has, and where each may come from.
 *
 * Packaged builds get them from `extraResources/stack` already renamed; a checkout has the
 * images pair under their own names (and no `.env.example`), so those are what a dev desktop
 * stages.
 */
const STACK_FILES: ReadonlyArray<{ target: string; candidates: readonly string[] }> = [
  { target: 'docker-compose.yml', candidates: ['docker-compose.images.yml', 'docker-compose.yml'] },
  { target: '.env.example', candidates: ['.env.images.example', '.env.example'] },
];

/**
 * A compose file that builds from the repo root — the source-build file, which cannot work
 * once it sits in `userData/stack` because `../..` is not the repo there.
 */
const SOURCE_BUILD_CONTEXT = /^\s*context:\s*['"]?\.\.\/\.\.['"]?\s*$/m;

export class LocalStackController {
  readonly stackDir: string;
  private readonly opts: Required<Pick<LocalStackOptions, 'userDataDir' | 'appRoot' | 'version' | 'packaged'>> &
    LocalStackOptions;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private current: DesktopLocalStackState;
  private abortController: AbortController | null = null;

  constructor(options: LocalStackOptions) {
    this.opts = { ...options };
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    const override = this.env.ORBIT_STACK_DIR?.trim();
    this.stackDir = override || path.join(options.userDataDir, 'stack');
    this.current = { phase: 'idle', at: Date.now(), detail: 'Not started' };
  }

  /** Where the bundled compose file and `.env.example` live. */
  resourceDir(): string {
    if (this.opts.resourcesDir) return this.opts.resourcesDir;
    if (this.opts.packaged) {
      const resourcesPath =
        (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ??
        path.join(path.dirname(process.execPath), '..', 'Resources');
      return path.join(resourcesPath, 'stack');
    }
    // Dev: apps/desktop/../../infra/compose
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

  /** The SESSION_SECRET this stack was started with, for the owner-key sign-in. */
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

  /** `GET /api/desktop/probe`, authenticated by the stack token alone. */
  private async probe(
    webUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ imageTag?: string; version?: string } | null> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${webUrl}/api/desktop/probe`, {
        headers: { [ORBIT_HEADERS.stackToken]: token, [ORBIT_HEADERS.desktop]: '1' },
        signal: signal ?? AbortSignal.timeout(5_000),
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
      ['compose', '-f', path.join(this.stackDir, 'docker-compose.yml'), '--project-directory', this.stackDir, '--env-file', path.join(this.stackDir, '.env'), ...args],
      opts,
    );
  }

  private imageTag(): string {
    return this.opts.packaged ? `v${this.opts.version}` : 'edge';
  }

  /**
   * Copy compose + `.env.example` into the stack dir on first run.
   *
   * A checkout holds the source-build files (`docker-compose.yml`, whose context is the repo
   * root, and no `.env.example` at all) beside the images pair the packaged app ships. The
   * controller runs from `userData/stack` with fixed names, so in a dev tree the images files
   * are staged under those names — otherwise a dev desktop tries a build whose context points
   * outside its own stack folder and can never start.
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
   * Should an existing file in the stack dir be replaced by the bundled one?
   *
   * Only in one case: a dev profile that already has the source-build compose file from an
   * earlier launch. It can never start (its build context points outside the stack dir), so
   * leaving it would keep the fix from reaching anyone who already tried. Packaged stacks
   * and every other file are left exactly as the user has them.
   */
  private stageOverStale(destination: string, target: string): boolean {
    if (this.opts.packaged || target !== 'docker-compose.yml') return false;
    try {
      return SOURCE_BUILD_CONTEXT.test(fs.readFileSync(destination, 'utf8'));
    } catch {
      return false;
    }
  }

  /**
   * Create `stack/.env` from the bundled example if it is missing, and return its path.
   *
   * `HERMES_KEY` has to be in that file *before* `compose up` (the container reads its
   * environment once, at start), so main asks for this file ahead of `start()` rather than
   * letting the first `prepareEnv` create it later.
   */
  prepareEnvFile(): string | null {
    const envPath = path.join(this.stackDir, '.env');
    if (fs.existsSync(envPath)) return envPath;
    try {
      this.prepareFiles();
    } catch (err) {
      log.warn('could not stage the stack files', err);
      return null;
    }
    const example = path.join(this.stackDir, '.env.example');
    if (!fs.existsSync(example)) return null;
    fs.copyFileSync(example, envPath);
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
   * leftover 8787 in a hand-edited file is exactly what made a port collision unrecoverable —
   * `up` was retried on the same busy port while health was polled at a URL nothing served.
   */
  private prepareEnv(port: number): { token: string; webUrl: string } {
    const envPath = path.join(this.stackDir, '.env');
    const existing = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, 'utf8')
      : fs.readFileSync(path.join(this.stackDir, '.env.example'), 'utf8');

    const filled = fillEmptySecrets(existing);
    let text = filled.text;
    text = setEnvValue(text, 'ORBIT_IMAGE_TAG', this.imageTag());
    text = setEnvValue(text, 'ORBIT_VERSION', this.opts.version);
    text = setEnvValue(text, 'ORBIT_WEB_PORT', String(port));
    const webUrl = `http://127.0.0.1:${port}`;
    // The server builds cookie flags, redirects and sign-in links from these, so they have to
    // describe the port we actually bound rather than the example file's 8787.
    text = setEnvValue(text, 'APP_URL', webUrl);
    text = setEnvValue(text, 'SERVER_URL', webUrl);
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

  /** `docker info`; true when the daemon answers. */
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
   * Is the thing answering `/api/health` this stack?
   *
   * `{ ok: true }` alone proves only that *an* Orbit server is there — a foreign one on the
   * same port (an older image, another checkout's stack) answers exactly the same way. The
   * server echoes `stackToken: 'verified'` only when the caller presented the STACK_TOKEN it
   * was started with, which is the one thing a stranger cannot fake.
   */
  private async probeHealth(webUrl: string, token: string, signal?: AbortSignal): Promise<boolean> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${webUrl}/api/health`, {
        headers: { [ORBIT_HEADERS.stackToken]: token, [ORBIT_HEADERS.desktop]: '1' },
        signal: signal ?? AbortSignal.timeout(5_000),
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

  async start(): Promise<DesktopLocalStackState> {
    if (ACTIVE_PHASES.includes(this.current.phase)) return this.current;
    if (this.current.phase === 'ready') return this.current;

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
      const port = await allocate();
      let prepared = this.prepareEnv(port);
      let webUrl = prepared.webUrl;

      this.set({ phase: 'pulling', detail: `Pulling orbit/api:${this.imageTag()}`, progress: 0.1 });
      const pull = await this.compose(binary, ['pull', '--quiet'], { timeoutMs: 600_000, signal });
      if (pull.code !== 0) {
        const kind = classifyDockerFailure(failureText(pull));
        if (kind === 'image-not-found') {
          return this.fail(kind, `The image orbit/api:${this.imageTag()} is not published yet.`);
        }
        if (signal.aborted) return this.set({ phase: 'idle', detail: 'Stopped' });
        // A pull can fail for a local-only tag or a flaky registry while usable images
        // are cached; let `up` be the judge instead of failing here.
        log.warn(`compose pull failed (${kind}); continuing`);
      }

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
        // `down`, never `down -v`: a restart must not destroy the user's data.
        const result = await this.compose(binary, ['down', '--remove-orphans'], { timeoutMs: 120_000 });
        if (result.code !== 0) log.warn('compose down failed', failureText(result));
      } catch (err) {
        log.warn('compose down failed', err);
      }
    }
    return this.set({ phase: 'idle', detail: 'Stopped', webUrl: undefined, progress: undefined });
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
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

/** Handy in logs and in the setup window's error line. */
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
