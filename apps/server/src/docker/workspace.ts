import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../env.js';

const run = promisify(execFile);

/**
 * A bot's home folder on the host, mounted at /home/bot in its container. Everything that makes the
 * bot's computer *its* computer lives there: the Chrome profile with its logins, the desk scripts'
 * state, the files it saved. Suspending a bot checkpoints this folder; starting it again puts the
 * last checkpoint back.
 */

const HOMES = path.join(env.computerHomeDir, 'homes');
const WORKSPACES = path.join(env.computerHomeDir, 'workspaces');

/** Where the bot's home lives on this machine. */
export function homeDirFor(botId: string): string {
  if (!/^bot_[\w-]+$/.test(botId)) throw new Error(`bot id ${JSON.stringify(botId)} cannot be used as a folder name`);
  return path.join(HOMES, botId);
}

function checkpointPath(botId: string): string {
  return path.join(WORKSPACES, `${botId}.tar.gz`);
}

/** Chrome's caches rebuild themselves; keeping them would multiply every checkpoint. */
const EXCLUDES = [
  '.cache',
  '.config/chromium/Default/Cache',
  '.config/chromium/Default/Code Cache',
  '.config/chromium/Default/GPUCache',
  '.config/chromium/ShaderCache',
  '.local/share/Trash',
];

export async function ensureHomeDir(botId: string): Promise<string> {
  const home = homeDirFor(botId);
  await fs.mkdir(home, { recursive: true });
  return home;
}

/** Save the bot's home folder to a compressed tarball (no-op when the home is gone). */
export async function checkpointWorkspace(botId: string): Promise<void> {
  const home = homeDirFor(botId);
  try {
    await fs.access(home);
  } catch {
    return;
  }
  await fs.mkdir(WORKSPACES, { recursive: true });
  const target = checkpointPath(botId);
  const next = `${target}.next`;
  const args = ['czf', next, '-C', home];
  for (const dir of EXCLUDES) args.push(`--exclude=${dir}`);
  args.push('.');
  try {
    await run('tar', args, { maxBuffer: 8 * 1024 * 1024 });
    await fs.rename(next, target);
  } catch (e: any) {
    await fs.rm(next, { force: true }).catch(() => undefined);
    throw new Error(`could not checkpoint ${botId}'s home: ${e?.stderr || e?.message || e}`);
  }
}

/**
 * Put the last checkpoint back into an empty home folder. A home that already has content is left
 * alone: it is newer than the checkpoint. Returns whether anything was restored.
 */
export async function restoreWorkspace(botId: string): Promise<boolean> {
  const home = homeDirFor(botId);
  const archive = checkpointPath(botId);
  try {
    await fs.access(archive);
  } catch {
    return false;
  }
  await fs.mkdir(home, { recursive: true });
  const entries = await fs.readdir(home);
  if (entries.length) return false;
  await run('tar', ['xzf', archive, '-C', home], { maxBuffer: 8 * 1024 * 1024 });
  return true;
}

/** Delete the home folder and its checkpoint (the bot is gone, or its workspace is being wiped). */
export async function wipeWorkspace(botId: string): Promise<void> {
  await fs.rm(homeDirFor(botId), { recursive: true, force: true });
  await fs.rm(checkpointPath(botId), { force: true });
}
