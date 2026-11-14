import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  NativeStackController,
  Service,
  describeNativeState,
  isPortInRange,
  readNativePorts,
  restartDelay,
  writeNativePorts,
  type SpawnFn,
  type SpawnedProcess,
} from '../native-stack';
import { nativePortsFile } from '../docker-move';
import type { ServerManifest } from '../mac-runtime';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-native-stack-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The log is written through a stream: poll until the line we want has landed. */
async function readLogWhen(file: string, pattern: RegExp, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    try {
      text = fs.readFileSync(file, 'utf8');
      if (pattern.test(text)) return text;
    } catch {
      /* not created yet */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${file} never matched ${pattern} (last contents: ${JSON.stringify(text)})`);
}

// ------------------------------------------------------------------ fakes

/** A ChildProcess stand-in: nobody runs, everything can be crashed on demand. */
class FakeProcess implements SpawnedProcess {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly signals: string[] = [];
  private exitListeners: ((code: number | null, signal?: string | null) => void)[] = [];

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'exit') this.exitListeners.push(listener as unknown as (code: number | null) => void);
    return this;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.exit(0, signal as unknown as string);
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    const listeners = [...this.exitListeners];
    this.exitListeners = [];
    for (const listener of listeners) listener(code, signal);
  }
}

interface FakeTimers {
  delays: number[];
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  /** Run the oldest scheduled callback. */
  fire: () => void;
  pending: () => number;
}

function fakeTimers(): FakeTimers {
  let nextId = 1;
  const scheduled = new Map<number, { cb: () => void; ms: number }>();
  const delays: number[] = [];
  return {
    delays,
    setTimeout: ((cb: () => void, ms: number) => {
      const id = nextId++;
      scheduled.set(id, { cb, ms });
      delays.push(ms);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as FakeTimers['setTimeout'],
    clearTimeout: ((handle: ReturnType<typeof setTimeout>) => {
      scheduled.delete(handle as unknown as number);
    }) as FakeTimers['clearTimeout'],
    fire: () => {
      const first = [...scheduled.entries()][0];
      if (!first) throw new Error('no timer scheduled');
      scheduled.delete(first[0]);
      first[1].cb();
    },
    pending: () => scheduled.size,
  };
}

// ------------------------------------------------------------------ restartDelay

describe('restartDelay', () => {
  test('doubles from one second and caps at thirty', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(restartDelay), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    assert.equal(restartDelay(30), 30_000);
  });
});

// ------------------------------------------------------------------ ports file

describe('native ports file', () => {
  test('round-trips, is 0600, and rejects nonsense', () => {
    const stackDir = tmpDir('ports');
    const file = nativePortsFile(stackDir);
    assert.equal(readNativePorts(file), null);

    writeNativePorts(file, { api: 42_001, web: 42_000 });
    assert.deepEqual(readNativePorts(file), { api: 42_001, web: 42_000 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    for (const bad of ['{"api":1,"web":2}', '{"api":42001,"web":42001}', '{"api":"x","web":42000}', 'not json']) {
      fs.writeFileSync(file, bad);
      assert.equal(readNativePorts(file), null, `should reject ${bad}`);
    }
  });

  test('the band is 40000-49999', () => {
    assert.equal(isPortInRange(40_000), true);
    assert.equal(isPortInRange(49_999), true);
    assert.equal(isPortInRange(39_999), false);
    assert.equal(isPortInRange(50_000), false);
    assert.equal(isPortInRange(4_200.5), false);
  });
});

// ------------------------------------------------------------------ Service

describe('Service', () => {
  test('logs, and gives up when the process dies before it is up', async () => {
    const logDir = tmpDir('service-dies');
    const timers = fakeTimers();
    const process = new FakeProcess();
    const spawn: SpawnFn = () => process;

    const service = new Service(
      { name: 'api', binary: '/fake/electron', args: ['dist/index.js'], env: {}, logDir },
      { spawn, timers, startedAfterMs: 1_000 },
    );

    const started = service.start();
    process.exit(1);
    await assert.rejects(started, /api exited during startup \(code 1\)/);

    const log = await readLogWhen(path.join(logDir, 'api.log'), /\[exit\] code=1/);
    assert.match(log, /starting \/fake\/electron dist\/index\.js/);
    assert.match(log, /\[exit\] code=1/);
    assert.equal(timers.pending(), 0, 'the start timer is cleared on exit');
  });

  test('restarts a crash with doubling backoff', async () => {
    const logDir = tmpDir('service-restart');
    const timers = fakeTimers();
    const processes: FakeProcess[] = [];
    const spawn: SpawnFn = () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    };

    const service = new Service(
      { name: 'api', binary: '/fake/electron', args: [], env: {}, logDir },
      { spawn, timers, startedAfterMs: 0, stableUptimeMs: 60_000 },
    );
    await service.start();
    assert.equal(processes.length, 1);
    assert.equal(timers.pending(), 0, 'a started service schedules nothing');

    for (const expectedDelay of [1_000, 2_000, 4_000]) {
      const current = processes.at(-1)!;
      current.exit(1);
      assert.equal(timers.delays.at(-1), expectedDelay, `expected a ${expectedDelay}ms restart delay`);
      timers.fire();
      await tick();
      assert.equal(service.isRunning(), true, 'the restarted process should be running');
    }

    assert.equal(processes.length, 4);
    service.dispose();
    assert.deepEqual(processes.at(-1)!.signals, ['SIGKILL'], 'dispose takes no chances on quit');
  });

  test('a clean stop terminates once and never restarts', async () => {
    const logDir = tmpDir('service-stop');
    const timers = fakeTimers();
    const processes: FakeProcess[] = [];
    const spawn: SpawnFn = () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    };

    const service = new Service(
      { name: 'api', binary: '/fake/electron', args: [], env: {}, logDir },
      { spawn, timers, startedAfterMs: 0, stopGraceMs: 5_000 },
    );
    await service.start();
    await service.stop();

    assert.equal(processes.length, 1, 'a stop must not spawn a replacement');
    assert.deepEqual(processes[0].signals, ['SIGTERM']);
    assert.equal(service.isRunning(), false);
    // Only the stop grace timer was ever scheduled — no restart delay.
    assert.deepEqual(timers.delays, [5_000]);
  });

  test('a process that ignores SIGTERM is killed after the grace period', async () => {
    const logDir = tmpDir('service-stubborn');
    const timers = fakeTimers();
    const process = new FakeProcess();
    // Ignore SIGTERM the first time, like a server stuck in a synchronous call.
    process.kill = ((signal: NodeJS.Signals = 'SIGTERM') => {
      process.signals.push(signal);
      if (signal === 'SIGKILL') process.exit(null, 'SIGKILL');
      return true;
    }) as FakeProcess['kill'];
    const spawn: SpawnFn = () => process;

    const service = new Service(
      { name: 'api', binary: '/fake/electron', args: [], env: {}, logDir },
      { spawn, timers, startedAfterMs: 0, stopGraceMs: 1_000 },
    );
    await service.start();
    const stopping = service.stop();
    await tick();
    assert.equal(process.signals.includes('SIGKILL'), false, 'SIGKILL waits for the grace period');
    timers.fire();
    await stopping;
    assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL']);
  });
});

// ------------------------------------------------------------------ controller

function makeBundle(userDataDir: string, entrypoints: { api: string; migrate?: string }): {
  manifest: ServerManifest;
  dir: string;
} {
  const version = '0.1.0';
  const dir = path.join(userDataDir, 'server-bundles', `orbit-server-${version}`);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, entrypoints.api), '// api');
  if (entrypoints.migrate) fs.writeFileSync(path.join(dir, entrypoints.migrate), '// migrate');
  return {
    manifest: {
      version,
      download: { url: 'https://example.invalid/orbit-server.tar.xz', sha256: 'a'.repeat(64), size: 1 },
      entrypoints,
    },
    dir,
  };
}

interface HarnessOptions {
  entrypoints?: { api: string; migrate?: string };
  ports?: { api: number; web: number } | null;
  healthy?: boolean;
  healthTimeoutMs?: number;
  fetchImpl?: () => Promise<Response>;
}

function harness(options: HarnessOptions = {}) {
  const userDataDir = tmpDir(`native-${Math.random().toString(16).slice(2)}`);
  const entrypoints = options.entrypoints ?? { api: 'dist/index.js', migrate: 'dist/migrate.js' };
  const bundle = makeBundle(userDataDir, entrypoints);

  if (options.ports) writeNativePorts(nativePortsFile(path.join(userDataDir, 'stack')), options.ports);

  const execCalls: { binary: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const exec = async (binary: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    execCalls.push({ binary, args, env: opts?.env });
    return { code: 0, stdout: '', stderr: '' };
  };

  const spawned: { binary: string; args: string[]; env: NodeJS.ProcessEnv; process: FakeProcess }[] = [];
  const spawn: SpawnFn = (binary, args, spawnOptions) => {
    const process = new FakeProcess();
    spawned.push({ binary, args, env: spawnOptions.env, process });
    return process;
  };

  const states: string[] = [];
  let port = 41_000;
  let healthChecks = 0;
  const fetchImpl =
    options.fetchImpl ??
    (async () => {
      healthChecks += 1;
      return new Response(JSON.stringify({ ok: options.healthy ?? true }), { status: 200 });
    });

  const controller = new NativeStackController({
    userDataDir,
    manifest: bundle.manifest,
    bundleDir: path.join(userDataDir, 'server-bundles'),
    electronBinary: '/Applications/Orbit.app/Contents/MacOS/Orbit',
    logDir: path.join(userDataDir, 'stack', 'logs'),
    exec,
    spawn,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
    isPortFree: async () => true,
    allocatePort: async () => (port += 1),
    onState: (state) => void states.push(state.phase),
    healthTimeoutMs: options.healthTimeoutMs ?? 5_000,
    healthIntervalMs: 0,
    serviceStartedMs: 0,
    stopGraceMs: 1_000,
    env: {},
  });

  return {
    controller,
    userDataDir,
    bundleDir: bundle.dir,
    execCalls,
    spawned,
    states,
    healthChecks: () => healthChecks,
  };
}

describe('NativeStackController', () => {
  test('migrates, spawns the API, waits for health, and reports running', async () => {
    const h = harness();

    const state = await h.controller.start();

    assert.equal(state.phase, 'running');
    assert.equal(state.webUrl, 'http://127.0.0.1:41002');
    assert.equal(state.error, undefined);
    assert.deepEqual(h.states, ['starting', 'starting', 'starting', 'running']);

    // 1. Migrations run with the Electron binary acting as Node, against the bundle.
    assert.equal(h.execCalls.length, 1);
    assert.equal(h.execCalls[0].binary, '/Applications/Orbit.app/Contents/MacOS/Orbit');
    assert.equal(h.execCalls[0].args[0], path.join(h.bundleDir, 'dist/migrate.js'));
    assert.equal(h.execCalls[0].env?.ELECTRON_RUN_AS_NODE, '1');

    // 2. One supervised API process, running the bundle's entrypoint.
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0].args[0], path.join(h.bundleDir, 'dist/index.js'));
    const env = h.spawned[0].env;
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.PORT, '41001');
    assert.equal(env.WEB_PORT, '41002');
    assert.equal(env.DB_PATH, path.join(h.userDataDir, 'orbit.db'));
    assert.equal(env.ENGINES_DIR, path.join(h.userDataDir, 'engines'));
    assert.equal(env.COMPUTER_HOME_DIR, path.join(h.userDataDir, 'computer-homes'));
    assert.match(env.SESSION_SECRET!, /^[0-9a-f]{64}$/);
    assert.match(env.STACK_TOKEN!, /^[0-9a-f]{64}$/);
    assert.notEqual(env.SESSION_SECRET, env.STACK_TOKEN);
    assert.ok(env.HERMES_HOME);

    // 3. Ports and secrets are persisted for the next launch.
    const ports = readNativePorts(nativePortsFile(path.join(h.userDataDir, 'stack')));
    assert.deepEqual(ports, { api: 41_001, web: 41_002 });
    const secrets = JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'stack', 'secrets.json'), 'utf8'));
    assert.equal(secrets.session_secret, env.SESSION_SECRET);
    assert.equal(secrets.stack_token, env.STACK_TOKEN);
    assert.equal(fs.statSync(path.join(h.userDataDir, 'stack', 'secrets.json')).mode & 0o777, 0o600);

    // 4. The health probe hit the API port, not the web port.
    assert.equal(h.healthChecks(), 1);

    // 5. Stopping kills the child and lands on `stopped`, not `idle`.
    const stopped = await h.controller.stop();
    assert.equal(stopped.phase, 'stopped');
    assert.deepEqual(h.spawned[0].process.signals, ['SIGTERM']);
    assert.equal(h.controller.matchesDesiredStack(), false);
  });

  test('reuses persisted ports so the web origin (and its cookies) survive a restart', async () => {
    const h = harness({ ports: { api: 42_001, web: 42_000 } });
    const state = await h.controller.start();
    assert.equal(state.webUrl, 'http://127.0.0.1:42000');
    assert.equal(h.spawned[0].env.PORT, '42001');
    assert.equal(h.spawned[0].env.WEB_PORT, '42000');
  });

  test('a bundle without a migrate entrypoint skips migrations', async () => {
    const h = harness({ entrypoints: { api: 'dist/index.js' } });
    const state = await h.controller.start();
    assert.equal(state.phase, 'running');
    assert.equal(h.execCalls.length, 0, 'no migrate entrypoint means nothing to run');
  });

  test('a manifest that promises migrate without the file fails with a clear error', async () => {
    const h = harness({ entrypoints: { api: 'dist/index.js' } });
    // Same bundle, but the manifest still declares a migrate entrypoint.
    h.controller['opts'].manifest.entrypoints.migrate = 'dist/migrate.js';

    const state = await h.controller.start();

    assert.equal(state.phase, 'failed');
    assert.match(state.error ?? '', /entrypoints\.migrate/);
    assert.match(state.error ?? '', /does not match server-bundle\.json/);
    assert.equal(h.spawned.length, 0, 'nothing may be spawned when the bundle is broken');
  });

  test('a failing migration stops the start', async () => {
    const h = harness();
    const failing = async () => ({ code: 1, stdout: '', stderr: 'SQLITE_CANTOPEN: unable to open database file' });
    (h.controller as unknown as { opts: { exec: unknown } }).opts.exec = failing;

    const state = await h.controller.start();
    assert.equal(state.phase, 'failed');
    assert.match(state.error ?? '', /database migration failed \(exit 1\)/);
    assert.match(state.error ?? '', /SQLITE_CANTOPEN/);
    assert.equal(h.spawned.length, 0);
  });

  test('an unhealthy server fails with the log path in the message', async () => {
    const h = harness({ healthy: false, healthTimeoutMs: 150 });
    const state = await h.controller.start();
    assert.equal(state.phase, 'failed');
    assert.match(state.error ?? '', /did not answer \/api\/health/);
    assert.match(state.error ?? '', /api\.log/);
    // The process is stopped again rather than left half-alive.
    assert.deepEqual(h.spawned[0].process.signals, ['SIGTERM']);
  });

  test('a server that exits during startup fails instead of hanging', async () => {
    const h = harness();
    const originalSpawn = h.controller['opts'].spawn;
    (h.controller as unknown as { opts: { spawn: SpawnFn } }).opts.spawn = (binary, args, options) => {
      const process = originalSpawn!(binary, args, options) as FakeProcess;
      queueMicrotask(() => process.exit(1));
      return process;
    };

    const state = await h.controller.start();
    assert.equal(state.phase, 'failed');
    assert.match(state.error ?? '', /exited during startup/);
  });

  test('describeNativeState names the failure', () => {
    assert.equal(describeNativeState({ phase: 'running', at: 0 }), 'Orbit is running (native)');
    assert.equal(describeNativeState({ phase: 'failed', at: 0, error: 'boom' }), 'boom');
  });

  test('webUrl falls back before the first start but reports the persisted port after', async () => {
    const fresh = harness();
    // Before any start there are no ports on disk: the setup window gets the Docker default.
    assert.equal(fresh.controller.webUrl(), 'http://127.0.0.1:8787');

    const h = harness({ ports: { api: 42_001, web: 42_000 } });
    assert.equal(h.controller.webUrl(), 'http://127.0.0.1:42000');
    await h.controller.start();
    assert.equal(h.controller.matchesDesiredStack(), true);
    assert.equal(h.controller.matchesDesiredStack('http://127.0.0.1:42000'), true);
    assert.equal(h.controller.matchesDesiredStack('http://127.0.0.1:8787'), false);
  });
});
