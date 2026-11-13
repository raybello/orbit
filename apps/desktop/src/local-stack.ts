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

  matchesDesiredStack(desiredUrl?: string): boolean {
    if (this.current.phase !== 'ready') return false;
    const desired = normalizeServerUrl(desiredUrl ?? this.webUrl());
    return !!desired && desired === normalizeServerUrl(this.current.webUrl ?? this.webUrl());
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

  /** Copy compose + `.env.example` into the stack dir on first run. */
  private prepareFiles(): void {
    fs.mkdirSync(this.stackDir, { recursive: true, mode: 0o700 });
    const resources = this.resourceDir();
    for (const name of ['docker-compose.yml', '.env.example']) {
      const target = path.join(this.stackDir, name);
      if (fs.existsSync(target)) continue;
      const source = path.join(resources, name);
      if (!fs.existsSync(source)) {
        throw new MissingResourceError(source, resources);
      }
      fs.copyFileSync(source, target);
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        /* Windows */
      }
    }
  }

  /** Read `.env`, fill secrets, pin the image tag and port, write it back 0600. */
  private prepareEnv(port: number): { token: string; webUrl: string } {
    const envPath = path.join(this.stackDir, '.env');
    const existing = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, 'utf8')
      : fs.readFileSync(path.join(this.stackDir, '.env.example'), 'utf8');

    const filled = fillEmptySecrets(existing);
    let text = filled.text;
    text = setEnvValue(text, 'ORBIT_IMAGE_TAG', this.imageTag());
    text = setEnvValue(text, 'ORBIT_VERSION', this.opts.version);
    if (!envValue(text, 'ORBIT_WEB_PORT') || envValue(text, 'ORBIT_WEB_PORT') === '0') {
      text = setEnvValue(text, 'ORBIT_WEB_PORT', String(port));
    }
    fs.writeFileSync(envPath, text, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      /* Windows */
    }

    const token = envValue(text, 'STACK_TOKEN');
    if (!token) throw new Error('the stack .env has no STACK_TOKEN after generation');
    writeStackToken(this.stackDir, token);
    const webPort = Number(envValue(text, 'ORBIT_WEB_PORT') ?? port) || port;
    const webUrl = `http://127.0.0.1:${webPort}`;
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

  private async probeHealth(webUrl: string, token: string, signal?: AbortSignal): Promise<boolean> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${webUrl}/api/health`, {
        headers: { [ORBIT_HEADERS.stackToken]: token, [ORBIT_HEADERS.desktop]: '1' },
        signal: signal ?? AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean };
      return body?.ok === true;
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
      const prepared = this.prepareEnv(port);
      const webUrl = prepared.webUrl;

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

      // The port we picked can be taken between allocating and binding. Retry twice.
      for (let attempt = 0; up.code !== 0 && attempt < 2; attempt += 1) {
        const kind = classifyDockerFailure(failureText(up));
        if (kind !== 'port-in-use') break;
        const retryPort = await allocate();
        log.warn(`port in use; retrying on ${retryPort}`);
        this.set({ phase: 'starting', detail: `Port busy, retrying on ${retryPort}` });
        this.prepareEnv(retryPort);
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
