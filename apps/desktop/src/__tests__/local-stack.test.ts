import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REQUIRED_SECRETS,
  envValue,
  fillEmptySecrets,
  missingStackSecrets,
  setEnvValue,
} from '../env-file';
import { allocateLoopbackPort, type BindFn } from '../loopback-port';
import type { DockerResult } from '../docker-cli';
import { LocalStackController, type LocalStackOptions } from '../local-stack';

const EXAMPLE = `SESSION_SECRET=
DB_ENCRYPTION_KEY=
STACK_TOKEN=
ORBIT_WEB_PORT=8787
ORBIT_API_PORT=0
HERMES_HOME=/root/.hermes
`;

/** Deterministic 64-char value per byte count, so assertions can name the source. */
const fakeGenerate = (bytes: number) => `${bytes}`.repeat(bytes * 2).slice(0, bytes * 2);

describe('secret filling', () => {
  test('fills every empty required secret with a 64-char hex value', () => {
    const { text, generated } = fillEmptySecrets(EXAMPLE);
    for (const spec of REQUIRED_SECRETS) {
      const value = envValue(text, spec.key);
      assert.ok(value, `${spec.key} should be set`);
      assert.match(value!, /^[0-9a-f]{64}$/);
      assert.equal(value, generated[spec.key]);
    }
  });

  test('leaves existing secrets alone', () => {
    const text = EXAMPLE.replace('SESSION_SECRET=', 'SESSION_SECRET=already-set');
    const { text: filled, generated } = fillEmptySecrets(text);
    assert.equal(envValue(filled, 'SESSION_SECRET'), 'already-set');
    assert.equal(generated.SESSION_SECRET, undefined);
    assert.ok(envValue(filled, 'STACK_TOKEN'));
  });

  test('treats a commented-out key as unset', () => {
    const text = `# SESSION_SECRET=\nSTACK_TOKEN=\n`;
    const { text: filled } = fillEmptySecrets(text, { generate: fakeGenerate });
    assert.equal(envValue(filled, 'SESSION_SECRET'), fakeGenerate(32));
    // The comment survives; the real line is appended.
    assert.match(filled, /^# SESSION_SECRET=$/m);
  });

  test('keeps every unrelated line, in order', () => {
    const { text } = fillEmptySecrets(EXAMPLE, { generate: fakeGenerate });
    const lines = text.trimEnd().split('\n');
    assert.equal(lines[0], `SESSION_SECRET=${fakeGenerate(32)}`);
    assert.equal(lines[1], `DB_ENCRYPTION_KEY=${fakeGenerate(32)}`);
    assert.equal(lines[2], `STACK_TOKEN=${fakeGenerate(32)}`);
    assert.equal(lines[3], 'ORBIT_WEB_PORT=8787');
    assert.equal(lines[4], 'ORBIT_API_PORT=0');
    assert.equal(lines[5], 'HERMES_HOME=/root/.hermes');
  });

  test('appends missing keys rather than dropping them', () => {
    const { text } = fillEmptySecrets('ORBIT_WEB_PORT=8787\n', { generate: fakeGenerate });
    assert.equal(envValue(text, 'ORBIT_WEB_PORT'), '8787');
    assert.equal(missingStackSecrets(text).length, 0);
  });

  test('uses the documented byte counts', () => {
    assert.deepEqual(
      REQUIRED_SECRETS.map((s) => [s.key, s.bytes]),
      [
        ['SESSION_SECRET', 32],
        ['DB_ENCRYPTION_KEY', 32],
        ['STACK_TOKEN', 32],
        // The images compose file needs it (`${VAR:?}` on sandbox-supervisor).
        ['SANDBOX_SUPERVISOR_TOKEN', 32],
      ],
    );
  });

  test('reports what is still missing', () => {
    assert.deepEqual(missingStackSecrets(EXAMPLE), [
      'SESSION_SECRET',
      'DB_ENCRYPTION_KEY',
      'STACK_TOKEN',
      'SANDBOX_SUPERVISOR_TOKEN',
    ]);
    const { text } = fillEmptySecrets(EXAMPLE);
    assert.deepEqual(missingStackSecrets(text), []);
  });

  test('generates the sandbox supervisor token the images compose requires', () => {
    const { text } = fillEmptySecrets('SANDBOX_SUPERVISOR_TOKEN=\n');
    assert.match(envValue(text, 'SANDBOX_SUPERVISOR_TOKEN')!, /^[0-9a-f]{64}$/);
  });
});

describe('envValue / setEnvValue', () => {
  test('reads quoted values and strips trailing comments', () => {
    assert.equal(envValue('A="x y"\n', 'A'), 'x y');
    assert.equal(envValue('A=value # why\n', 'A'), 'value');
    assert.equal(envValue('export A=exported\n', 'A'), 'exported');
    assert.equal(envValue('A=\n', 'A'), null);
    assert.equal(envValue('# A=commented\n', 'A'), null);
  });

  test('replaces in place without touching neighbours', () => {
    const out = setEnvValue('A=1\nB=2\nA=3\n', 'B', '9');
    assert.equal(out, 'A=1\nB=9\nA=3\n');
  });

  test('appends with a newline when the file does not end in one', () => {
    assert.equal(setEnvValue('A=1', 'B', '2'), 'A=1\nB=2\n');
  });
});

describe('allocateLoopbackPort', () => {
  test('returns the port the OS chose and releases the socket', async () => {
    let closed = false;
    const bind: BindFn = async (port, host) => {
      assert.equal(port, 0);
      assert.equal(host, '127.0.0.1');
      return { port: 45789, close: () => void (closed = true) };
    };
    assert.equal(await allocateLoopbackPort({ bind }), 45789);
    assert.equal(closed, true);
  });

  test('retries when a bind races with another process', async () => {
    let attempts = 0;
    const bind: BindFn = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('EADDRINUSE');
      return { port: 50001, close: () => {} };
    };
    assert.equal(await allocateLoopbackPort({ bind }), 50001);
    assert.equal(attempts, 3);
  });

  test('gives up after three attempts with a readable error', async () => {
    const bind: BindFn = async () => {
      throw new Error('EADDRINUSE');
    };
    await assert.rejects(() => allocateLoopbackPort({ bind }), /could not allocate a loopback port: EADDRINUSE/);
  });

  test('really binds a free port through the real net path', async () => {
    const port = await allocateLoopbackPort();
    assert.ok(port > 1024 && port < 65536, `unexpected port ${port}`);
  });
});

// ------------------------------------------------------------------ controller

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-local-stack-'));

process.on('exit', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** What a checkout's `infra/compose` looks like: the source build plus the images pair. */
const SOURCE_COMPOSE = 'services:\n  api:\n    build:\n      context: ../..\n';
const IMAGES_COMPOSE = 'services:\n  api:\n    image: ghcr.io/raybello/orbit/app:${ORBIT_IMAGE_TAG:-edge}\n';
const IMAGES_ENV = `SESSION_SECRET=
DB_ENCRYPTION_KEY=
STACK_TOKEN=
SANDBOX_SUPERVISOR_TOKEN=
ORBIT_IMAGE_TAG=
ORBIT_WEB_PORT=8787
APP_URL=http://127.0.0.1:8787
`;

interface Harness {
  controller: LocalStackController;
  stackDir: string;
  /** Every docker argv, in order. */
  calls: string[][];
  /** For each docker call, whether its cwd existed. */
  cwdState: boolean[];
  /** Every URL the controller fetched, in order. */
  fetched: string[];
  env: () => string;
}

/**
 * A controller wired to fake docker, a fake server and a fake clock.
 *
 * `server` decides what the fake Orbit answers: the two probes the controller makes are
 * `/api/health` (identity) and `/api/desktop/probe` (image tag).
 */
function harness(opts: {
  name: string;
  ports?: number[];
  packaged?: boolean;
  up?: (call: number) => DockerResult;
  server?: (url: string, headers: Record<string, string>) => { status: number; body: unknown };
  files?: Record<string, string>;
}): Harness {
  const root = path.join(tmpRoot, opts.name);
  fs.rmSync(root, { recursive: true, force: true });
  const resources = path.join(root, 'resources');
  const userDataDir = path.join(root, 'userData');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const files = opts.files ?? {
    'docker-compose.yml': SOURCE_COMPOSE,
    'docker-compose.images.yml': IMAGES_COMPOSE,
    '.env.images.example': IMAGES_ENV,
  };
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(resources, name), text);
  }

  const calls: string[][] = [];
  const fetched: string[] = [];
  /** Did the stack dir exist for each docker call? `spawn` fails outright when it does not. */
  const cwdState: boolean[] = [];
  const ports = [...(opts.ports ?? [18080])];
  let upCalls = 0;

  const exec = async (_binary: string, args: string[], runOpts?: { cwd?: string }): Promise<DockerResult> => {
    calls.push(args);
    cwdState.push(Boolean(runOpts?.cwd && fs.existsSync(runOpts.cwd)));
    if (args[0] === 'info') return { code: 0, stdout: '24.0.7\n', stderr: '' };
    if (args[0] === 'compose' && args.includes('pull')) return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'compose' && args.includes('up')) {
      upCalls += 1;
      return opts.up?.(upCalls) ?? { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const answer = opts.server?.(url, headers) ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const controller = new LocalStackController({
    userDataDir,
    appRoot: path.join(root, 'apps', 'desktop'),
    version: '0.1.0',
    packaged: opts.packaged ?? false,
    resourcesDir: resources,
    platform: 'darwin',
    env: { ORBIT_DOCKER_BIN: '/usr/bin/docker' } as NodeJS.ProcessEnv,
    exists: (file: string) => file === '/usr/bin/docker',
    exec,
    fetchImpl,
    sleep: async () => {},
    allocatePort: async () => {
      const next = ports.shift();
      if (next === undefined) throw new Error('ran out of fake ports');
      return next;
    },
    healthTimeoutMs: 200,
    healthIntervalMs: 1,
  } satisfies LocalStackOptions);

  const stackDir = path.join(userDataDir, 'stack');
  return {
    controller,
    stackDir,
    calls,
    cwdState,
    fetched,
    env: () => fs.readFileSync(path.join(stackDir, '.env'), 'utf8'),
  };
}

/** A server that only calls itself ours when it was given the right stack token. */
function selfAwareServer(imageTag = 'edge') {
  return (url: string, headers: Record<string, string>) => {
    const token = headers['x-orbit-stack-token'];
    if (url.endsWith('/api/health')) {
      return { status: 200, body: token ? { ok: true, stackToken: 'verified' } : { ok: true } };
    }
    if (url.endsWith('/api/desktop/probe')) {
      if (!token) return { status: 401, body: { error: 'unauthenticated' } };
      return { status: 200, body: { ok: true, imageTag, hermesConnected: false, version: '0.1.0' } };
    }
    return { status: 404, body: { error: 'not found' } };
  };
}

describe('LocalStackController: staging files', () => {
  test('creates the stack folder before the first docker call', async () => {
    const h = harness({ name: 'cwd-first', server: selfAwareServer() });
    assert.equal(fs.existsSync(h.stackDir), false, 'the harness should start with no stack folder');

    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);
    // `spawn` fails with ENOENT for a missing cwd, which a first run would report as a
    // broken Docker install.
    assert.deepEqual(h.cwdState.filter((ok) => !ok), []);
    assert.ok(h.calls.length > 0);
  });

  test('a dev checkout stages the images pair under the names the controller uses', async () => {
    const h = harness({ name: 'staging', server: selfAwareServer() });
    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);

    // The source-build compose file would point its build context outside the stack dir.
    assert.equal(fs.readFileSync(path.join(h.stackDir, 'docker-compose.yml'), 'utf8'), IMAGES_COMPOSE);
    assert.equal(fs.readFileSync(path.join(h.stackDir, '.env.example'), 'utf8'), IMAGES_ENV);
  });

  test('a packaged build uses the renamed files it ships', async () => {
    const h = harness({
      name: 'packaged',
      server: selfAwareServer(),
      files: { 'docker-compose.yml': IMAGES_COMPOSE, '.env.example': IMAGES_ENV },
    });
    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);
    assert.equal(fs.readFileSync(path.join(h.stackDir, 'docker-compose.yml'), 'utf8'), IMAGES_COMPOSE);
  });

  test('replaces a source-build compose file left behind by an earlier dev launch', async () => {
    const h = harness({ name: 'stale-dev-compose', server: selfAwareServer() });
    fs.mkdirSync(h.stackDir, { recursive: true });
    fs.writeFileSync(path.join(h.stackDir, 'docker-compose.yml'), SOURCE_COMPOSE);

    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);
    assert.equal(fs.readFileSync(path.join(h.stackDir, 'docker-compose.yml'), 'utf8'), IMAGES_COMPOSE);
  });

  test('a packaged build leaves an existing compose file alone', async () => {
    const untouched = 'services:\n  api:\n    image: ghcr.io/raybello/orbit/app:v0.1.0\n';
    const h = harness({
      name: 'packaged-keeps',
      packaged: true,
      server: selfAwareServer('v0.1.0'),
    });
    fs.mkdirSync(h.stackDir, { recursive: true });
    fs.writeFileSync(path.join(h.stackDir, 'docker-compose.yml'), untouched);
    fs.writeFileSync(path.join(h.stackDir, '.env.example'), IMAGES_ENV);

    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);
    assert.equal(fs.readFileSync(path.join(h.stackDir, 'docker-compose.yml'), 'utf8'), untouched);
  });

  test('prepareEnvFile creates .env from the example before anything starts', () => {
    const h = harness({ name: 'prepare-env', server: selfAwareServer() });
    const envPath = h.controller.prepareEnvFile();
    assert.equal(envPath, path.join(h.stackDir, '.env'));
    assert.equal(fs.readFileSync(envPath!, 'utf8'), IMAGES_ENV);
    // Idempotent: a second call keeps the file it found (HERMES_KEY may already be in it).
    fs.writeFileSync(envPath!, `${IMAGES_ENV}HERMES_KEY=abc\n`);
    assert.equal(h.controller.prepareEnvFile(), envPath);
    assert.match(fs.readFileSync(envPath!, 'utf8'), /HERMES_KEY=abc/);
  });
});

describe('LocalStackController: port collisions', () => {
  test('writes the port it decided on, not the one the example pins', async () => {
    const h = harness({ name: 'port-pinned', server: selfAwareServer() });
    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);
    assert.equal(envValue(h.env(), 'ORBIT_WEB_PORT'), '18080');
    assert.equal(envValue(h.env(), 'APP_URL'), 'http://127.0.0.1:18080');
    assert.equal(state.webUrl, 'http://127.0.0.1:18080');
  });

  test('rebinds on a fresh port and polls the NEW url after a collision', async () => {
    const h = harness({
      name: 'port-retry',
      ports: [18101, 18102],
      up: (call) =>
        call === 1
          ? { code: 1, stdout: '', stderr: 'Bind for 0.0.0.0:18101 failed: port is already allocated' }
          : { code: 0, stdout: '', stderr: '' },
      server: selfAwareServer(),
    });

    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);
    assert.equal(state.webUrl, 'http://127.0.0.1:18102');

    // Two `up`s, and the second one ran against the new port in the .env.
    const ups = h.calls.filter((args) => args.includes('up'));
    assert.equal(ups.length, 2);
    assert.equal(envValue(h.env(), 'ORBIT_WEB_PORT'), '18102');

    // Health was polled at the port that actually bound, never the busy one.
    assert.ok(h.fetched.includes('http://127.0.0.1:18102/api/health'), h.fetched.join(', '));
    assert.ok(!h.fetched.some((url) => url.includes(':18101/')), h.fetched.join(', '));
  });
});

describe('LocalStackController: stack identity', () => {
  test('does not adopt a server that answers {ok:true} without verifying our token', async () => {
    const h = harness({
      name: 'foreign-ok',
      // A stranger's Orbit: healthy, but it does not know this stack's token.
      server: () => ({ status: 200, body: { ok: true, engine: 'hermes' } }),
    });
    const state = await h.controller.start();
    assert.equal(state.phase, 'failed');
    assert.match(state.error ?? '', /did not answer/i);
    assert.ok(h.fetched.some((url) => url.endsWith('/api/health')));
  });

  test('accepts a stack that echoes stackToken: verified', async () => {
    const h = harness({ name: 'own-stack', server: selfAwareServer() });
    const state = await h.controller.start();
    assert.equal(state.phase, 'ready', state.error);
  });

  test('matchesDesiredStack compares the image tag the probe reports', async () => {
    const h = harness({ name: 'probe-tag', server: selfAwareServer('edge') });
    await h.controller.start();
    assert.equal(await h.controller.matchesDesiredStack(), true);
    assert.equal(await h.controller.matchesDesiredStack('http://127.0.0.1:18080'), true);
  });

  test('matchesDesiredStack rejects a stale image tag on the same port', async () => {
    const h = harness({ name: 'probe-old-tag', server: selfAwareServer('v0.0.9') });
    await h.controller.start();
    assert.equal(await h.controller.matchesDesiredStack(), false);
  });

  test('matchesDesiredStack treats a server without the probe endpoint as not ours', async () => {
    const h = harness({
      name: 'probe-missing',
      server: (url, headers) =>
        url.endsWith('/api/health')
          ? { status: 200, body: { ok: true, stackToken: headers['x-orbit-stack-token'] ? 'verified' : undefined } }
          : { status: 404, body: { error: 'not found' } },
    });
    await h.controller.start();
    assert.equal(await h.controller.matchesDesiredStack(), false);
  });

  test('matchesDesiredStack rejects a different url', async () => {
    const h = harness({ name: 'probe-other-url', server: selfAwareServer() });
    await h.controller.start();
    assert.equal(await h.controller.matchesDesiredStack('http://127.0.0.1:19999'), false);
  });
});
