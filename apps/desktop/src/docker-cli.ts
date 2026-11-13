/**
 * The Docker CLI, as much of it as the local stack needs.
 *
 * Everything here is dependency-injectable (`exists`, `spawn`) so the state machine can be
 * tested on a machine without Docker, and so failures can be classified instead of being
 * shown to the user as a wall of stderr.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { DockerFailureKind } from './shared/api';

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the timeout fired or the caller aborted. */
  killed?: boolean;
}

export interface RunDockerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. */
  spawn?: typeof nodeSpawn;
  /** Hard cap on captured output, so `docker compose logs` cannot eat the heap. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * Where the docker binary usually lives, per platform.
 *
 * Docker Desktop's CLI is not always on PATH for a GUI-launched app (a macOS app started
 * from Finder inherits almost nothing), so we look in the well-known places as well.
 */
export function dockerCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const pf = env.PROGRAMFILES ?? 'C:\\Program Files';
    const local = env.LOCALAPPDATA ?? '';
    return [
      `${pf}\\Docker\\Docker\\resources\\bin\\docker.exe`,
      local ? `${local}\\Docker\\resources\\bin\\docker.exe` : '',
      // Last: a bare name means "whatever PATH says", which only wins if nothing above exists.
      'docker.exe',
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
      '/usr/bin/docker',
      '/Applications/Docker.app/Contents/Resources/bin/docker',
      'docker',
    ];
  }
  return ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker', 'docker'];
}

/**
 * Resolve the docker binary.
 *
 * `exists` is injected; when it is the real `fs.existsSync`, a bare `docker` candidate is
 * resolved through PATH (which the caller's `exec` will do anyway) rather than rejected.
 */
export function resolveDockerBinary(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = defaultExists,
): string | null {
  const explicit = env.ORBIT_DOCKER_BIN?.trim();
  if (explicit && exists(explicit)) return explicit;

  for (const candidate of dockerCandidates(platform, env)) {
    // A bare name has no directory to stat: hand it to the shell/exec and let PATH decide.
    const isBareName = !candidate.includes('/') && !candidate.includes('\\');
    if (isBareName) return candidate;
    if (exists(candidate)) return candidate;
  }
  return null;
}

function defaultExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * Map docker/compose stderr onto something the UI can act on.
 *
 * Order matters: "permission denied ... docker.sock" also contains "Is the docker daemon
 * running", so permission is checked before daemon-down.
 */
export function classifyDockerFailure(output: string): DockerFailureKind {
  const text = String(output ?? '').toLowerCase();
  if (!text.trim()) return 'other';

  if (
    /permission denied.*docker\.sock/.test(text) ||
    /got permission denied while trying to connect/.test(text) ||
    /docker\.sock.*permission denied/.test(text)
  ) {
    return 'socket-permission';
  }

  if (
    /cannot connect to the docker daemon/.test(text) ||
    /is the docker daemon running/.test(text) ||
    /error during connect/.test(text) ||
    /failed to connect to the docker api/.test(text) ||
    /docker daemon is not running/.test(text)
  ) {
    return 'daemon-down';
  }

  if (
    /no such image/.test(text) ||
    /manifest unknown/.test(text) ||
    /pull access denied/.test(text) ||
    /not found: manifest/.test(text) ||
    /image.*not found/.test(text)
  ) {
    return 'image-not-found';
  }

  if (
    /port is already allocated/.test(text) ||
    /address already in use/.test(text) ||
    /bind for 0\.0\.0\.0.*failed/.test(text)
  ) {
    return 'port-in-use';
  }

  if (
    /could not find an available, non-overlapping ipv4 address pool/.test(text) ||
    /all predefined address pools have been fully subnetted/.test(text)
  ) {
    return 'address-pool-exhausted';
  }

  if (
    /no such file or directory.*docker-compose/.test(text) ||
    /no configuration file provided/.test(text) ||
    /can't find a suitable configuration file/.test(text) ||
    /docker-compose\.ya?ml.*not found/.test(text) ||
    /compose.*file.*not found/.test(text)
  ) {
    return 'compose-missing';
  }

  if (
    /dial tcp/.test(text) ||
    /i\/o timeout/.test(text) ||
    /tls handshake timeout/.test(text) ||
    /no such host/.test(text) ||
    /network is unreachable/.test(text) ||
    /failed to resolve reference/.test(text) ||
    /temporary failure in name resolution/.test(text) ||
    /connection reset by peer/.test(text)
  ) {
    return 'network';
  }

  return 'other';
}

/**
 * Run docker and capture output. Never rejects on a non-zero exit: the caller decides what
 * a failure means. Rejects only if spawning itself fails.
 */
export function runDocker(
  binary: string,
  args: string[],
  opts: RunDockerOptions = {},
): Promise<DockerResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const spawn = opts.spawn ?? nodeSpawn;

  return new Promise<DockerResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: 130, stdout: '', stderr: 'aborted', killed: true });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        // `windowsHide` keeps a cmd flash out of the user's face on Windows.
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcess;
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;

    const finish = (result: DockerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const kill = () => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      // SIGTERM is ignored by some docker builds; make sure the promise settles.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2_000).unref?.();
    };

    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      kill();
      finish({
        code: 124,
        stdout,
        stderr: `${stderr}\ndocker ${args[0] ?? ''} timed out after ${Math.round(timeoutMs / 1000)}s`,
        killed: true,
      });
    }, timeoutMs);
    timer.unref?.();

    const collect = (chunk: Buffer, into: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      if (into === 'out') {
        stdout = (stdout + text).slice(-maxBytes);
      } else {
        stderr = (stderr + text).slice(-maxBytes);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code: number | null) => {
      finish({ code: code ?? (killed ? 130 : 1), stdout, stderr, killed: killed || undefined });
    });
  });
}

/** The combined text a classifier should look at. */
export function failureText(result: DockerResult): string {
  return `${result.stderr}\n${result.stdout}`.trim();
}
