/**
 * Which stack this Mac should run, and the one-way move from Docker to native.
 *
 * Three jobs, in order of how often they run:
 *
 *  1. remember the user's choice (`.desktop-stack-choice` in userData)
 *  2. decide on first run on an eligible Mac — and, when a Docker stack with data already
 *     exists, ask before touching it
 *  3. perform the move: checkpoint the SQLite WAL, copy the database and the two data
 *     directories out of the container, record the choice, then stop compose *without*
 *     `-v` so the volumes survive a rollback
 *
 * Nothing here imports Electron: the dialog is a function the caller passes in. That keeps
 * the module testable and keeps the decision logic honest about who is asking the question.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@orbit/logger';
import { resolveDockerBinary } from './docker-cli';
import type { ExecResult, RuntimeExec } from './mac-runtime';

const log = createLogger({ scope: 'docker-move' });

export type StackChoice = 'docker' | 'native';

/** Relative to userData. Absent means "no choice made yet". */
export const STACK_CHOICE_FILE = '.desktop-stack-choice';
/** Relative to the stack dir (`userData/stack`) — the file `native-stack.ts` reads. */
export const NATIVE_PORTS_FILE = '.native-ports';

/** Where the container keeps them, from `infra/compose`. */
export const CONTAINER_PATHS = {
  db: '/data/orbit.db',
  engines: '/data/engines',
  computers: '/data/computers',
} as const;

// ------------------------------------------------------------------ choice file

export function stackChoiceFile(userDataDir: string): string {
  return path.join(userDataDir, STACK_CHOICE_FILE);
}

export function nativePortsFile(stackDir: string): string {
  return path.join(stackDir, NATIVE_PORTS_FILE);
}

export function readStackChoice(userDataDir: string): StackChoice | null {
  try {
    const text = fs.readFileSync(stackChoiceFile(userDataDir), 'utf8').trim().toLowerCase();
    return text === 'docker' || text === 'native' ? text : null;
  } catch {
    return null;
  }
}

/** 0600: it is a preference, but the stack dir is user-owned and private anyway. */
export function writeStackChoice(userDataDir: string, choice: StackChoice): void {
  const file = stackChoiceFile(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${choice}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows: mode is advisory */
  }
  fs.renameSync(tmp, file);
  log.info(`stack choice: ${choice}`);
}

// ------------------------------------------------------------------ compose plumbing

/** The same invocation shape `LocalStackController` uses, so state and files agree. */
export function composeArgsFor(stackDir: string, args: string[]): string[] {
  return [
    'compose',
    '-f',
    path.join(stackDir, 'docker-compose.yml'),
    '--project-directory',
    stackDir,
    '--env-file',
    path.join(stackDir, '.env'),
    ...args,
  ];
}

function failureDetail(result: ExecResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.find((line) => /error|denied|no such|failed|not found/i.test(line));
  return (useful ?? lines[0] ?? `exit ${result.code}`).slice(0, 300);
}

// ------------------------------------------------------------------ dockerDataExists

export interface DockerDataOptions {
  userDataDir: string;
  stackDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  exec?: RuntimeExec;
  dockerBinary?: string;
}

/**
 * "Is there a Docker stack here worth asking about?"
 *
 * The compose project is named `orbit`, so the volume Compose creates is
 * `orbit_orbit-data`; an older standalone compose file used `orbit_data` and a bind mount
 * under `userData/docker`. Any of the three means the user has bots in Docker.
 */
export async function dockerDataExists(opts: DockerDataOptions): Promise<boolean> {
  const exists = opts.exists ?? ((file: string) => fs.existsSync(file));
  const stackDir = opts.stackDir ?? path.join(opts.userDataDir, 'stack');
  const candidates = [
    path.join(opts.userDataDir, 'docker', 'orbit.db'),
    path.join(stackDir, 'orbit.db'),
    path.join(stackDir, 'data', 'orbit.db'),
  ];
  if (candidates.some((file) => exists(file))) return true;

  const exec = opts.exec;
  if (!exec) return false;
  const binary =
    opts.dockerBinary ?? resolveDockerBinary(opts.platform ?? process.platform, opts.env ?? process.env, exists);
  if (!binary) return false;

  for (const volume of ['orbit_orbit-data', 'orbit_data']) {
    try {
      const result = await exec(binary, ['volume', 'inspect', volume], { timeoutMs: 5_000 });
      if (result.code === 0) return true;
    } catch {
      /* docker not running: no data we can see */
    }
  }
  return false;
}

// ------------------------------------------------------------------ chooseStack

export interface ChooseStackOptions {
  userDataDir: string;
  /** `nativeStackEligible() && the bundle manifest is present`. The caller owns both. */
  eligible: boolean;
  readChoice?: (userDataDir: string) => StackChoice | null;
  writeChoice?: (userDataDir: string, choice: StackChoice) => void;
  dockerDataExists?: () => Promise<boolean> | boolean;
  /**
   * The "Run Orbit without Docker?" dialog. Returns true for "Switch". Injected because
   * this module must not reach for `dialog.showMessageBox` itself.
   */
  confirmSwitch?: (info: { dockerData: boolean }) => Promise<boolean> | boolean;
}

export type StackDecisionReason =
  | 'ineligible'
  | 'saved'
  | 'first-run-no-docker'
  | 'dialog-accepted'
  | 'dialog-declined';

export interface StackDecision {
  choice: StackChoice;
  reason: StackDecisionReason;
  /**
   * True only when the user just chose native and their Docker data has not been moved
   * yet: the caller has to run `moveAccepted()` before starting the native stack.
   */
  moveRequired: boolean;
}

/**
 * The first-run decision.
 *
 * A saved choice always wins — including `docker`, so a user who declined is not asked on
 * every launch and a user who switched back is not dragged forward again.
 */
export async function chooseStack(opts: ChooseStackOptions): Promise<StackDecision> {
  if (!opts.eligible) return { choice: 'docker', reason: 'ineligible', moveRequired: false };

  const readChoice = opts.readChoice ?? readStackChoice;
  const writeChoice = opts.writeChoice ?? writeStackChoice;

  const saved = readChoice(opts.userDataDir);
  if (saved) return { choice: saved, reason: 'saved', moveRequired: false };

  const hasDockerData = await (opts.dockerDataExists?.() ?? false);
  if (!hasDockerData) {
    writeChoice(opts.userDataDir, 'native');
    return { choice: 'native', reason: 'first-run-no-docker', moveRequired: false };
  }

  const accepted = await (opts.confirmSwitch?.({ dockerData: true }) ?? false);
  if (accepted) {
    // Deliberately not written yet: a failed copy must leave the Docker stack in charge.
    return { choice: 'native', reason: 'dialog-accepted', moveRequired: true };
  }

  writeChoice(opts.userDataDir, 'docker');
  return { choice: 'docker', reason: 'dialog-declined', moveRequired: false };
}

// ------------------------------------------------------------------ moveAccepted

export interface MoveAcceptedOptions {
  userDataDir: string;
  stackDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  exec?: RuntimeExec;
  dockerBinary?: string;
  /** Defaults to `CONTAINER_PATHS`; overridable for images that moved their data. */
  containerPaths?: { db?: string; engines?: string; computers?: string };
  writeChoice?: (userDataDir: string, choice: StackChoice) => void;
  /** `fs.renameSync` by default; injected so a test can assert the atomic swap. */
  rename?: (from: string, to: string) => void;
  remove?: (target: string) => void;
  progress?: (line: string) => void;
}

export interface MoveResult {
  ok: boolean;
  /** The steps that ran, in order — useful in the log and in tests. */
  steps: string[];
  error?: string;
  /** Where the copied files now live, when the move succeeded. */
  moved?: { db: string; engines: string; computers: string };
}

/**
 * Copy the Docker stack's data out and hand the machine to the native stack.
 *
 * Why in the container and not here: the database is `better-sqlite3` behind a named
 * volume, so the only process that can checkpoint and read it is the one inside the
 * image. Running `node -e` there uses the image's own `better-sqlite3`; adding that module
 * to Electron is not an option — it is a native addon, and this app ships with
 * `npmRebuild: false` (build.mjs bundles the main process with esbuild, so nothing native
 * is rebuilt for our ABI). `docker compose cp` then moves the resulting file out.
 *
 * Rollback: the last step is `compose down`, never `down -v`. The volumes stay, so
 * "Switch to Docker…" works with every bot and message still in place.
 */
export async function moveAccepted(opts: MoveAcceptedOptions): Promise<MoveResult> {
  const steps: string[] = [];
  const progress = opts.progress ?? (() => {});
  const exists = opts.exists ?? ((file: string) => fs.existsSync(file));
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const stackDir = opts.stackDir ?? path.join(opts.userDataDir, 'stack');
  const rename = opts.rename ?? ((from: string, to: string) => fs.renameSync(from, to));
  const remove = opts.remove ?? ((target: string) => fs.rmSync(target, { recursive: true, force: true }));
  const writeChoice = opts.writeChoice ?? writeStackChoice;

  const binary = opts.dockerBinary ?? resolveDockerBinary(platform, env, exists);
  if (!binary) {
    return {
      ok: false,
      steps,
      error: 'Docker is not installed, so there is nothing to copy. Orbit will use the native stack from scratch.',
    };
  }
  const exec = opts.exec;
  if (!exec) throw new Error('moveAccepted needs an exec implementation');

  const compose = (args: string[]) => composeArgsFor(stackDir, args);
  const containerPaths = {
    db: opts.containerPaths?.db ?? CONTAINER_PATHS.db,
    engines: opts.containerPaths?.engines ?? CONTAINER_PATHS.engines,
    computers: opts.containerPaths?.computers ?? CONTAINER_PATHS.computers,
  };

  const run = async (label: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> => {
    progress(label);
    try {
      const result = await exec(binary, compose(args), { timeoutMs });
      steps.push(label);
      return result;
    } catch (err) {
      // A missing binary or a broken CLI rejects instead of exiting; treat it as a failed
      // command so the caller can say something useful about it.
      steps.push(label);
      return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  };

  const notInstalled = 'Docker is not installed, so there is nothing to copy. Orbit will use the native stack from scratch.';

  // 1. The stack has to be up: `compose cp` and the checkpoint both need a container.
  const ps = await run('assert-running', ['ps', '--services', '--status', 'running'], 30_000);
  if (ps.code === 127 && /ENOENT|no such file|not found|not recognized/i.test(`${ps.stderr}\n${ps.stdout}`)) {
    return { ok: false, steps, error: notInstalled };
  }
  if (ps.code !== 0 || !ps.stdout.split('\n').some((line) => line.trim() === 'api')) {
    return {
      ok: false,
      steps,
      error:
        'Orbit\'s Docker stack is not running, and Docker must be running to copy your data. ' +
        'Start Docker Desktop, open Orbit once with Docker, then try again.',
    };
  }

  // 2. Fold the WAL into the main database file so a naive copy is a complete copy.
  const checkpoint = await run(
    'checkpoint',
    [
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      // Runs *inside* the container, against the image's own better-sqlite3.
      `const D=require('better-sqlite3');const db=new D(process.env.DB_PATH||'${containerPaths.db}');db.pragma('wal_checkpoint(TRUNCATE)');db.close();`,
    ],
    60_000,
  );
  if (checkpoint.code !== 0) {
    return { ok: false, steps, error: `could not checkpoint the database: ${failureDetail(checkpoint)}` };
  }

  const dataDir = opts.userDataDir;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // 3. The database: copy to `.tmp`, then rename, so a half-copied file is never opened.
  const dbTarget = path.join(dataDir, 'orbit.db');
  const dbTmp = `${dbTarget}.tmp`;
  remove(dbTmp);
  const dbCopy = await run('copy-db', ['cp', `api:${containerPaths.db}`, dbTmp], 300_000);
  if (dbCopy.code !== 0) {
    remove(dbTmp);
    return { ok: false, steps, error: `could not copy the database: ${failureDetail(dbCopy)}` };
  }

  // 4/5. Engines and computer homes are directories; `cp` needs the trailing `/.` to copy
  // their contents rather than nesting a directory.
  const enginesTarget = path.join(dataDir, 'engines');
  const computersTarget = path.join(dataDir, 'computer-homes');
  for (const [label, source, target] of [
    ['copy-engines', containerPaths.engines, enginesTarget],
    ['copy-computers', containerPaths.computers, computersTarget],
  ] as const) {
    const tmp = `${target}.tmp`;
    remove(tmp);
    const copy = await run(label, ['cp', `api:${source}/.`, tmp], 600_000);
    if (copy.code !== 0) {
      // Directories are optional in practice (a user may have no bots yet); note and go on.
      remove(tmp);
      progress(`${label}: nothing to copy (${failureDetail(copy)})`);
      continue;
    }
    remove(target);
    rename(tmp, target);
  }

  rename(dbTmp, dbTarget);

  // 6. Only now is the choice durable.
  writeChoice(opts.userDataDir, 'native');
  steps.push('write-choice');

  // 7. `down`, never `down -v`: the volumes are the rollback path.
  const down = await run('docker-down', ['down', '--remove-orphans'], 180_000);
  if (down.code !== 0) {
    log.warn(`compose down failed after the copy: ${failureDetail(down)}`);
    progress('the Docker stack could not be stopped; quit Docker Desktop to stop it');
  }

  log.info(`moved Docker data to the native stack (${steps.join(' -> ')})`);
  return { ok: true, steps, moved: { db: dbTarget, engines: enginesTarget, computers: computersTarget } };
}
