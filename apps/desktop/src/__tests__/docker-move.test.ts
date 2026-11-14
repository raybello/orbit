import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTAINER_PATHS,
  chooseStack,
  composeArgsFor,
  dockerDataExists,
  moveAccepted,
  nativePortsFile,
  readStackChoice,
  stackChoiceFile,
  writeStackChoice,
  type StackChoice,
} from '../docker-move';
import type { ExecResult, RuntimeExec } from '../mac-runtime';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-docker-move-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------------ choice file

describe('stack choice file', () => {
  test('round-trips and is private', () => {
    const userData = tmpDir('choice');
    assert.equal(readStackChoice(userData), null);

    writeStackChoice(userData, 'native');
    assert.equal(readStackChoice(userData), 'native');
    const mode = fs.statSync(stackChoiceFile(userData)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

    writeStackChoice(userData, 'docker');
    assert.equal(readStackChoice(userData), 'docker');
    // Written through a temp file and renamed, so a crash cannot leave half a word behind.
    assert.equal(fs.existsSync(`${stackChoiceFile(userData)}.tmp`), false);
  });

  test('treats junk as "no choice" rather than guessing', () => {
    const userData = tmpDir('choice-junk');
    fs.writeFileSync(stackChoiceFile(userData), 'kubernetes\n');
    assert.equal(readStackChoice(userData), null);
  });

  test('the ports file lives in the stack directory', () => {
    assert.equal(nativePortsFile('/u/stack'), path.join('/u/stack', '.native-ports'));
  });
});

// ------------------------------------------------------------------ chooseStack

describe('chooseStack', () => {
  /** A decision harness that records every write and every dialog call. */
  function harness(overrides: Partial<Parameters<typeof chooseStack>[0]> = {}) {
    const userData = tmpDir(`choose-${Math.random().toString(16).slice(2)}`);
    const writes: StackChoice[] = [];
    const dialogs: boolean[] = [];
    const options = {
      userDataDir: userData,
      eligible: true,
      writeChoice: (_dir: string, choice: StackChoice) => void writes.push(choice),
      dockerDataExists: () => false,
      confirmSwitch: ({ dockerData }: { dockerData: boolean }) => {
        dialogs.push(dockerData);
        return false;
      },
      ...overrides,
    };
    return { userData, writes, dialogs, options };
  }

  test('is not eligible: Docker, no questions, no writes', async () => {
    const { options, writes, dialogs } = harness({ eligible: false, dockerDataExists: () => true });
    const decision = await chooseStack(options);
    assert.deepEqual(decision, { choice: 'docker', reason: 'ineligible', moveRequired: false });
    assert.deepEqual(writes, []);
    assert.deepEqual(dialogs, []);
  });

  test('a saved choice wins in both directions', async () => {
    for (const saved of ['docker', 'native'] as const) {
      const { options, writes, dialogs } = harness({ readChoice: () => saved, dockerDataExists: () => true });
      const decision = await chooseStack(options);
      assert.equal(decision.choice, saved);
      assert.equal(decision.reason, 'saved');
      assert.equal(decision.moveRequired, false);
      assert.deepEqual(writes, []);
      assert.deepEqual(dialogs, [], 'a saved choice must never re-open the dialog');
    }
  });

  test('first run without Docker data: native, recorded, no dialog', async () => {
    const { options, writes, dialogs } = harness({ dockerDataExists: () => false });
    const decision = await chooseStack(options);
    assert.deepEqual(decision, { choice: 'native', reason: 'first-run-no-docker', moveRequired: false });
    assert.deepEqual(writes, ['native']);
    assert.deepEqual(dialogs, []);
  });

  test('first run with Docker data, dialog accepted: native, and nothing written yet', async () => {
    const { options, writes, dialogs } = harness({
      dockerDataExists: () => true,
      confirmSwitch: ({ dockerData }: { dockerData: boolean }) => {
        dialogs.push(dockerData);
        return true;
      },
    });
    const decision = await chooseStack(options);
    assert.deepEqual(decision, { choice: 'native', reason: 'dialog-accepted', moveRequired: true });
    assert.deepEqual(dialogs, [true], 'the dialog has to say there is Docker data');
    // The choice is written by moveAccepted, after the copy succeeds.
    assert.deepEqual(writes, []);
  });

  test('first run with Docker data, dialog declined: Docker, recorded so it is asked once', async () => {
    const { options, writes } = harness({ dockerDataExists: () => true, confirmSwitch: () => false });
    const decision = await chooseStack(options);
    assert.deepEqual(decision, { choice: 'docker', reason: 'dialog-declined', moveRequired: false });
    assert.deepEqual(writes, ['docker']);
  });

  test('a failed move leaves the decision unmade', async () => {
    const { options, writes } = harness({ dockerDataExists: () => true, confirmSwitch: () => true });
    const decision = await chooseStack(options);
    assert.equal(decision.moveRequired, true);
    assert.deepEqual(writes, [], 'writing "native" before the copy would strand the user without data');
  });
});

// ------------------------------------------------------------------ compose plumbing

describe('composeArgsFor', () => {
  test('matches the flags LocalStackController uses, so both read the same files', () => {
    assert.deepEqual(composeArgsFor('/u/stack', ['ps']), [
      'compose',
      '-f',
      '/u/stack/docker-compose.yml',
      '--project-directory',
      '/u/stack',
      '--env-file',
      '/u/stack/.env',
      'ps',
    ]);
  });
});

// ------------------------------------------------------------------ dockerDataExists

describe('dockerDataExists', () => {
  test('sees a copied database or bind-mounted data directory', async () => {
    const userData = tmpDir('data-files');
    assert.equal(await dockerDataExists({ userDataDir: userData, exists: (f) => f.startsWith(userData) && fs.existsSync(f) }), false);

    fs.mkdirSync(path.join(userData, 'docker'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'docker', 'orbit.db'), '');
    assert.equal(await dockerDataExists({ userDataDir: userData }), true);
  });

  test('falls back to the compose volume, and tolerates Docker being down', async () => {
    const userData = tmpDir('data-volume');
    const asked: string[][] = [];
    const exec: RuntimeExec = async (_binary, args) => {
      asked.push(args);
      const volume = args[2];
      return volume === 'orbit_orbit-data'
        ? ({ code: 0, stdout: '[]', stderr: '' } as ExecResult)
        : ({ code: 1, stdout: '', stderr: 'no such volume' } as ExecResult);
    };
    assert.equal(await dockerDataExists({ userDataDir: userData, exec, dockerBinary: 'docker' }), true);
    assert.deepEqual(asked[0], ['volume', 'inspect', 'orbit_orbit-data']);

    const failing: RuntimeExec = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    assert.equal(await dockerDataExists({ userDataDir: userData, exec: failing, dockerBinary: 'docker' }), false);
  });
});

// ------------------------------------------------------------------ moveAccepted

describe('moveAccepted', () => {
  interface Recorded {
    binary: string;
    args: string[];
    subcommand: string;
  }

  /**
   * An exec that records argv and answers like the real Docker CLI: `ps` reports the api
   * service, `cp` creates the destination, everything else succeeds.
   */
  function recorder(opts: { running?: boolean; checkpointCode?: number } = {}) {
    const calls: Recorded[] = [];
    const events: string[] = [];
    const exec: RuntimeExec = async (binary, args) => {
      const composeAt = args.indexOf('compose');
      const subcommand = args[composeAt + 7] ?? '';
      calls.push({ binary, args, subcommand });
      events.push(subcommand);
      if (subcommand === 'ps') {
        return opts.running === false
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 0, stdout: 'api\nsandbox-supervisor\n', stderr: '' };
      }
      if (subcommand === 'exec') {
        return { code: opts.checkpointCode ?? 0, stdout: '', stderr: opts.checkpointCode ? 'SQLITE_BUSY' : '' };
      }
      if (subcommand === 'cp') {
        // `compose cp api:/data/orbit.db <dest>` — the real command creates the file/dir.
        const dest = args[args.length - 1];
        if (path.extname(dest)) fs.writeFileSync(dest, 'sqlite-bytes');
        else fs.mkdirSync(dest, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    return { exec, calls, events };
  }

  function baseOptions(userData: string) {
    const writes: StackChoice[] = [];
    return {
      userDataDir: userData,
      exec: undefined as unknown as RuntimeExec,
      dockerBinary: '/usr/local/bin/docker',
      writeChoice: (_dir: string, choice: StackChoice) => void writes.push(choice),
      writes,
    };
  }

  test('runs the steps in order and copies the data out before stopping compose', async () => {
    const userData = tmpDir('move-ok');
    const options = baseOptions(userData);
    const { exec, calls, events } = recorder();
    const result = await moveAccepted({ ...options, exec });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.steps, [
      'assert-running',
      'checkpoint',
      'copy-db',
      'copy-engines',
      'copy-computers',
      'write-choice',
      'docker-down',
    ]);
    assert.deepEqual(events, ['ps', 'exec', 'cp', 'cp', 'cp', 'down']);

    // 1. The running check targets the api service, not "any container".
    assert.equal(calls[0].args.includes('--services'), true);
    assert.deepEqual(calls[0].args.slice(-2), ['--status', 'running']);

    // 2. The WAL checkpoint runs *inside the container*, against its own better-sqlite3.
    const checkpoint = calls[1].args;
    const execAt = checkpoint.indexOf('exec');
    assert.equal(checkpoint[execAt + 1], '-T');
    assert.equal(checkpoint[execAt + 2], 'api');
    assert.equal(checkpoint[execAt + 3], 'node');
    assert.equal(checkpoint[execAt + 4], '-e');
    assert.match(checkpoint[execAt + 5], /wal_checkpoint\(TRUNCATE\)/);
    assert.match(checkpoint[execAt + 5], /require\('better-sqlite3'\)/);

    // 3. The database is copied to a .tmp path and renamed into place.
    const dbCopy = calls[2].args.slice(-2);
    assert.equal(dbCopy[0], `api:${CONTAINER_PATHS.db}`);
    assert.equal(dbCopy[1], path.join(userData, 'orbit.db.tmp'));
    assert.equal(fs.readFileSync(path.join(userData, 'orbit.db'), 'utf8'), 'sqlite-bytes');
    assert.equal(fs.existsSync(path.join(userData, 'orbit.db.tmp')), false);

    // 4/5. Directories are copied by contents, not nested.
    assert.equal(calls[3].args.at(-2), `api:${CONTAINER_PATHS.engines}/.`);
    assert.equal(calls[3].args.at(-1), path.join(userData, 'engines.tmp'));
    assert.equal(fs.existsSync(path.join(userData, 'engines')), true);
    assert.equal(calls[4].args.at(-2), `api:${CONTAINER_PATHS.computers}/.`);

    // 6/7. The choice is recorded, then compose goes down without -v.
    assert.deepEqual(options.writes, ['native']);
    const down = calls.at(-1)!;
    assert.equal(down.subcommand, 'down');
    assert.equal(down.args.includes('-v'), false, 'down -v would destroy the rollback path');
    assert.equal(down.args.includes('--remove-orphans'), true);
  });

  test('refuses to touch anything when the stack is not running', async () => {
    const userData = tmpDir('move-stopped');
    const options = baseOptions(userData);
    const { exec, calls } = recorder({ running: false });
    const result = await moveAccepted({ ...options, exec });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Docker stack is not running/);
    assert.deepEqual(result.steps, ['assert-running']);
    assert.deepEqual(calls.map((call) => call.subcommand), ['ps']);
    assert.deepEqual(options.writes, [], 'nothing may be recorded when nothing was copied');
  });

  test('stops before copying when the checkpoint fails', async () => {
    const userData = tmpDir('move-checkpoint-fail');
    const options = baseOptions(userData);
    const { exec, calls } = recorder({ checkpointCode: 5 });
    const result = await moveAccepted({ ...options, exec });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /could not checkpoint the database/);
    assert.deepEqual(calls.map((call) => call.subcommand), ['ps', 'exec']);
    assert.deepEqual(options.writes, []);
  });

  test('a missing engines directory is not fatal', async () => {
    const userData = tmpDir('move-no-engines');
    const options = baseOptions(userData);
    const { exec } = recorder();
    const failingEngines: RuntimeExec = async (binary, args, opts) => {
      if (args.includes('cp') && args.some((arg) => arg.endsWith('/engines/.'))) {
        return { code: 1, stdout: '', stderr: 'Could not find the file /data/engines in container api' };
      }
      return exec(binary, args, opts);
    };
    const lines: string[] = [];
    const result = await moveAccepted({ ...options, exec: failingEngines, progress: (line) => lines.push(line) });

    assert.equal(result.ok, true, result.error);
    assert.equal(fs.existsSync(path.join(userData, 'orbit.db')), true);
    assert.equal(fs.existsSync(path.join(userData, 'engines')), false);
    assert.match(lines.join('\n'), /copy-engines: nothing to copy/);
  });

  test('does nothing without Docker, and says so', async () => {
    const userData = tmpDir('move-no-docker');
    const options = baseOptions(userData);
    // A docker binary that resolves but cannot be spawned: `spawn` rejects with ENOENT.
    const missing: RuntimeExec = async () => {
      throw new Error('spawn docker ENOENT');
    };
    const result = await moveAccepted({ ...options, exec: missing });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Docker is not installed/);
    assert.deepEqual(options.writes, []);
  });
});
