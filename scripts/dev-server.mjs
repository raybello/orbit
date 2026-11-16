#!/usr/bin/env node
/**
 * `pnpm --filter @orbit/server run dev`: tsx watch, plus cleanup of the bots' Hermes gateways when
 * the dev session ends.
 *
 * The server starts each extra bot's gateway detached on purpose, so a hot reload (tsx watch
 * restarting the server on every save) reuses the running gateways instead of cold-starting them.
 * But nothing stopped them once you stopped the dev server, and they kept writing into
 * ENGINES_DIR — deleting `data/` brought it straight back. This wrapper outlives the reloads, and
 * when it is stopped (Ctrl-C, the debugger's stop button, the terminal closing) or tsx exits, it
 * stops every gateway living under this server's ENGINES_DIR.
 *
 * Set ORBIT_KEEP_ENGINES=1 to leave them running.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stopBotEngines } from './stop-bot-engines.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'apps', 'server');
const envFile = path.join(root, '.env');

/** ENGINES_DIR the way env.ts resolves it: the environment, then .env, else <repo>/data/engines. */
function enginesDir() {
  let fromFile;
  try { fromFile = parseEnv(fs.readFileSync(envFile, 'utf8')).ENGINES_DIR; } catch { /* no .env */ }
  const value = process.env.ENGINES_DIR || fromFile;
  // A relative value is relative to the server's working directory, which is apps/server.
  return value ? path.resolve(serverDir, value) : path.join(root, 'data', 'engines');
}

const tsx = path.join(serverDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const args = ['watch', ...(fs.existsSync(envFile) ? [`--env-file=${envFile}`] : []), 'src/index.ts'];
if (!fs.existsSync(envFile)) console.warn(`[dev-server] ${envFile} is missing — copy .env.example to .env (scripts/dev-reset-stack.sh does this)`);

const child = spawn(tsx, args, { cwd: serverDir, stdio: 'inherit', env: process.env });

let cleaning = false;
async function finish(code) {
  if (cleaning) return;
  cleaning = true;
  if (process.env.ORBIT_KEEP_ENGINES === '1') process.exit(code);
  const dir = enginesDir();
  try {
    const stopped = await stopBotEngines([dir], { log: (m) => console.log(`[dev-server] ${m}`) });
    if (stopped.length) console.log(`[dev-server] stopped ${stopped.length} bot engine(s) under ${dir}`);
  } catch (e) {
    console.warn(`[dev-server] could not stop bot engines: ${e?.message ?? e}`);
  }
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    // Let the server run its own shutdown (it suspends bot computers) before the gateways go.
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    else void finish(0);
  });
}
child.on('error', (e) => { console.error(`[dev-server] could not start tsx: ${e.message}`); void finish(127); });
child.on('exit', (code, sig) => { void finish(sig ? 0 : code ?? 0); });
