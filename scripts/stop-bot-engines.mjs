#!/usr/bin/env node
/**
 * Stop the Hermes gateways Orbit started for its bots, the primary included.
 *
 *   node scripts/stop-bot-engines.mjs <enginesDir> [<enginesDir> …]   # only gateways living under these
 *   node scripts/stop-bot-engines.mjs --all                           # every Orbit bot gateway on this machine
 *
 * Why this exists: the server starts each bot's gateway detached (engine.ts), so a server restart can
 * reuse it instead of waiting for a cold start. The flip side is that nothing stops those gateways
 * when the server goes away for good. They keep running from launchd and keep writing into
 * `<enginesDir>/{primary,bot_*}` — delete the data folder and it reappears within seconds.
 *
 * A gateway is ours when its HERMES_HOME is a `primary` or `bot_*` folder (one of the given dirs, or
 * any `…/engines/{primary,bot_*}` with --all). The person's own Hermes (home ~/.hermes) never
 * matches, so it is left alone.
 *
 * Also importable: `import { stopBotEngines } from './stop-bot-engines.mjs'`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_HOME = /[/\\]engines[/\\](?:primary|bot_[^/\\]+)[/\\]?$/;

function hermesHomeOf(pid) {
  try {
    // Linux: the environment is a file. macOS: `ps eww` appends it to the command line.
    const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    return environ.split('\0').find((kv) => kv.startsWith('HERMES_HOME='))?.slice('HERMES_HOME='.length) ?? null;
  } catch { /* not Linux */ }
  try {
    const out = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.match(/(?:^|\s)HERMES_HOME=(\S+)/)?.[1] ?? null;
  } catch { return null; }
}

/** Every running `gateway run --no-supervise` with the HERMES_HOME it was started with. */
export function listBotGateways() {
  let out = '';
  try {
    out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidText, command] = m;
    if (!/gateway/.test(command) || !/--no-supervise/.test(command)) continue;
    const pid = Number(pidText);
    if (pid === process.pid) continue;
    const home = hermesHomeOf(pid);
    if (home && BOT_HOME.test(home)) found.push({ pid, home });
  }
  return found;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The server spawns each gateway as the leader of its own process group: signal the group so its
// helpers (browser harness, MCP children) go with it.
const signal = (pid, sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } };

/**
 * Stop the matching gateways: SIGTERM, up to `graceMs` to exit, then SIGKILL.
 * `dirs` empty means every Orbit bot gateway. Returns what was stopped.
 */
export async function stopBotEngines(dirs = [], { graceMs = 8000, log = () => {} } = {}) {
  const roots = dirs.filter(Boolean).map((d) => path.resolve(d) + path.sep);
  const targets = listBotGateways().filter(({ home }) =>
    roots.length === 0 || roots.some((root) => (path.resolve(home) + path.sep).startsWith(root)));
  if (targets.length === 0) return [];
  for (const t of targets) { log(`stopping bot engine pid ${t.pid} (${t.home})`); signal(t.pid, 'SIGTERM'); }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targets.some((t) => alive(t.pid))) await sleep(200);
  for (const t of targets) if (alive(t.pid)) { log(`pid ${t.pid} ignored SIGTERM; killing it`); signal(t.pid, 'SIGKILL'); }
  return targets;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const dirs = args.filter((a) => a !== '--all');
  if (!all && dirs.length === 0) {
    console.error('usage: stop-bot-engines.mjs <enginesDir> [...] | --all');
    process.exit(2);
  }
  const stopped = await stopBotEngines(all ? [] : dirs, { log: (m) => console.log(`  ${m}`) });
  console.log(stopped.length ? `  ✓ stopped ${stopped.length} bot engine(s)` : '  ✓ no bot engines running');
}
