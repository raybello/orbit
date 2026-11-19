import fs from 'node:fs';
import path from 'node:path';
import type { LibraryFile } from '@orbit/contracts';
import { db } from '../db.js';
import { env } from '../env.js';
import { engineHome } from '../engine.js';
import { workspaceRoot } from '../files.js';

/**
 * The server's data folder as a file browser sees it: `/data` in the Docker stack, with every
 * bot's agent home (engines/), the screens' home folders (computers/) and the Library (files/)
 * under it. Only the instance owner browses it (see isInstanceOwner); files that hold
 * credentials, and the live database, are listed but never served.
 */

/** Names that hold credentials or live state. Their keys are edited under Settings → API keys. */
const SECRET_NAME = /^(\.env(\..*)?|auth\.json|\.anthropic_oauth\.json|\.orbit-inherited\.json|.*\.(pem|key|p12)|id_(rsa|ed25519|ecdsa)(\.pub)?)$/i;
const LIVE_DB = /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i;

/** Why this file is not served, or null. */
export function refusalFor(rel: string): string | null {
  const name = rel.split('/').pop() ?? '';
  if (SECRET_NAME.test(name)) return 'This file holds credentials, so it is not shown here. Edit API keys under Settings → API keys.';
  if (LIVE_DB.test(name)) return 'This is a live database file, so it is not shown here.';
  return null;
}

/** A relative path inside the data folder, cleaned, or null when it tries to leave it. */
export function cleanRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\r\n]/.test(rel)) return null;
  return rel;
}

/**
 * The absolute path of `rel` in the data folder, or null when it is not there or escapes it.
 * Links are resolved first, so a link inside the folder cannot reach outside it.
 */
export function resolveData(rel: string): string | null {
  try {
    const root = fs.realpathSync(env.dataDir);
    const target = fs.realpathSync(rel ? path.join(root, rel) : root);
    return target === root || target.startsWith(root + path.sep) ? target : null;
  } catch {
    return null;
  }
}

/** One folder of the data tree: folders first, then by name. Null when it is not a folder there. */
export function listData(rel: string): LibraryFile[] | null {
  const dir = resolveData(rel);
  if (!dir) return null;
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .map((e) => {
      let size = 0; let modifiedAt = 0; let isDir = e.isDirectory();
      try {
        const st = fs.statSync(path.join(dir, e.name));
        size = st.size; modifiedAt = st.mtimeMs; isDir = st.isDirectory();
      } catch { /* a dangling link lists as an empty file */ }
      return { name: e.name, size, modifiedAt, isDir };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/** Where a bot's agent works (its Hermes home's workspace), relative to the data folder, when it is inside it. */
export function workspaceOf(botId: string): string | null {
  if (!engineHome(botId)) return null;
  const rel = path.relative(path.resolve(env.dataDir), path.resolve(workspaceRoot(botId)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * The person whose computer this is: the owner of the primary Bot. On a fresh install with no
 * primary yet, whoever is signed in.
 */
export function isInstanceOwner(userId: string): boolean {
  const owner = db.prepare("SELECT user_id FROM bots WHERE engine='primary' LIMIT 1").get() as { user_id: string } | undefined;
  return !owner || owner.user_id === userId;
}
