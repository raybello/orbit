/**
 * The native stack's bot engines: the Hermes gateways its server starts for every extra Bot.
 *
 * The server spawns each gateway detached, as the leader of its own process group, so that a server
 * restart can reuse it. Stopping the server therefore leaves them running from launchd, still
 * writing into `<userData>/engines/bot_*` — quitting Orbit left processes behind, and deleting the
 * engines folder brought it straight back. The controller calls this after the server is down.
 *
 * Each gateway records itself in `<home>/gateway.pid` (a pid, or JSON with `pid` and `hermes_home`).
 * A pid is only signalled when it is alive and its command line is a Hermes gateway, so a stale
 * pid file that now names some unrelated process is left alone.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface BotEngine {
  pid: number;
  home: string;
}

export interface BotEngineDeps {
  readDir?: (dir: string) => string[];
  readFile?: (file: string) => string;
  /** The process's command line, or null when it is gone. */
  commandOf?: (pid: number) => string | null;
  /** `process.kill`: negative pids signal the group. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultCommandOf = (pid: number): string | null => {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

/** The pid a `gateway.pid` names, when it belongs to this home. */
export function parseGatewayPid(raw: string, home: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  let pid = Number.NaN;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'number') pid = parsed;
    else if (parsed && typeof parsed === 'object') {
      const record = parsed as { pid?: unknown; hermes_home?: unknown };
      if (typeof record.hermes_home === 'string' && path.resolve(record.hermes_home) !== path.resolve(home)) return null;
      pid = Number(record.pid);
    }
  } catch {
    pid = Number(text);
  }
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** Live gateways under `enginesDir`, one per `bot_*` home that has one. */
export function findBotEngines(enginesDir: string, deps: BotEngineDeps = {}): BotEngine[] {
  const readDir = deps.readDir ?? ((dir: string) => fs.readdirSync(dir));
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  const commandOf = deps.commandOf ?? defaultCommandOf;
  let names: string[];
  try {
    names = readDir(enginesDir);
  } catch {
    return [];
  }
  const found: BotEngine[] = [];
  for (const name of names) {
    if (!name.startsWith('bot_')) continue;
    const home = path.join(enginesDir, name);
    let raw: string;
    try {
      raw = readFile(path.join(home, 'gateway.pid'));
    } catch {
      continue;
    }
    const pid = parseGatewayPid(raw, home);
    if (!pid) continue;
    const command = commandOf(pid);
    if (command && /\bgateway\b/.test(command)) found.push({ pid, home });
  }
  return found;
}

function signalGroup(kill: NonNullable<BotEngineDeps['kill']>, pid: number, signal: NodeJS.Signals): void {
  try {
    kill(-pid, signal);
  } catch {
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function alive(kill: NonNullable<BotEngineDeps['kill']>, pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM every gateway under `enginesDir`, wait up to `graceMs`, then SIGKILL what is left.
 * Returns the engines it stopped.
 */
export async function stopBotEngines(
  enginesDir: string,
  options: BotEngineDeps & { graceMs?: number } = {},
): Promise<BotEngine[]> {
  const kill = options.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const engines = findBotEngines(enginesDir, options);
  if (engines.length === 0) return [];
  for (const e of engines) signalGroup(kill, e.pid, 'SIGTERM');
  const deadline = now() + (options.graceMs ?? 8_000);
  while (now() < deadline && engines.some((e) => alive(kill, e.pid))) await sleep(200);
  for (const e of engines) if (alive(kill, e.pid)) signalGroup(kill, e.pid, 'SIGKILL');
  return engines;
}

/** Quit-time: SIGTERM every gateway now and do not wait; the app is about to exit. */
export function signalBotEngines(enginesDir: string, deps: BotEngineDeps = {}): BotEngine[] {
  const kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const engines = findBotEngines(enginesDir, deps);
  for (const e of engines) signalGroup(kill, e.pid, 'SIGTERM');
  return engines;
}
