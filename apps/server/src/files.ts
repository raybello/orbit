import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { db } from './db.js';
import { mediaTypeFor } from './lib/mime.js';
import type { FileEntry, FilesResponse } from './types.js';

/**
 * The unified Files view: one list over a bot's Library, the files messages attached, and the
 * workspace its agent works in. Everything here reads the disk this server runs on; no shell, no
 * computer API — a bot's files live next to us, so a plain fs walk is enough.
 */

export type FileKind = 'library' | 'attachment' | 'workspace';

/** A message attachment and a Library file share one root; a workspace is its own. */
export const LIB_ROOT = path.join(env.botDataDir, 'files');

export const libraryRoot = (botId: string) => path.join(LIB_ROOT, botId);
export const workspaceRoot = (botId: string) => path.join(env.enginesDir, botId, 'workspace');

const rootFor = (kind: FileKind, botId: string) =>
  kind === 'workspace' ? workspaceRoot(botId) : libraryRoot(botId);

/**
 * A relative path we are willing to join onto a root: no absolute paths, no empty or `.` parts, no
 * `..`, no control characters. '' means the root itself; null means refuse. Same rule as
 * configApi's safeRel, so the two file features cannot disagree about what a path is.
 */
export function safeRel(p: string | undefined | null): string | null {
  const rel = String(p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..')) return null;
  if (/[\0\n\r\\]/.test(rel)) return null;
  return rel;
}

/** A bot id comes from the database, but a file id comes from the URL: keep it to a plain token. */
const safeBotId = (id: string): string | null => (/^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null);

function realRoot(root: string): string | null {
  try {
    return fs.realpathSync(root);
  } catch {
    return null; // the directory does not exist (yet): nothing to list
  }
}

/**
 * The absolute path of `rel` inside `real` (an already-resolved root), or null when it escapes the
 * root, is not a regular file, or does not exist. Links are followed first, so a link inside the
 * root cannot point outside it.
 */
function insideReal(real: string, rel: string): string | null {
  const clean = safeRel(rel);
  if (!clean) return null; // the root itself is a directory, never a file
  try {
    const file = fs.realpathSync(path.join(real, clean));
    if (!file.startsWith(real + path.sep)) return null;
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Resolve `rel` under `root` with the traversal and symlink guard above. */
export function resolveInside(root: string, rel: string | undefined | null): string | null {
  const real = realRoot(root);
  return real ? insideReal(real, String(rel ?? '')) : null;
}

// ---------- ids: an opaque handle the download route can resolve ----------

export interface FileRef {
  kind: FileKind;
  botId: string;
  path: string;
}

/**
 * A URL-safe id for one file. It only names the file; the download route checks that the signed-in
 * user owns the bot again, so an id cannot be used to read somebody else's file.
 */
export function fileIdFor(ref: FileRef): string {
  return Buffer.from(JSON.stringify({ k: ref.kind, b: ref.botId, p: ref.path }), 'utf8').toString('base64url');
}

export interface ResolvedFile extends FileRef {
  /** Absolute path on disk, already checked to sit inside the source root. */
  file: string;
  filename: string;
  size: number;
  mediaType: string;
}

/** The inverse of fileIdFor. Anything malformed, unsafe or gone from disk resolves to null. */
export function resolveFileId(id: string): ResolvedFile | null {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(String(id ?? ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const kind = parsed?.k;
  if (kind !== 'library' && kind !== 'attachment' && kind !== 'workspace') return null;
  if (typeof parsed?.b !== 'string' || typeof parsed?.p !== 'string') return null;
  const botId = safeBotId(parsed.b);
  const rel = safeRel(parsed.p);
  if (!botId || !rel) return null;
  const file = resolveInside(rootFor(kind, botId), rel);
  if (!file) return null;
  const filename = rel.split('/').pop()!;
  return { kind, botId, path: rel, file, filename, size: fs.statSync(file).size, mediaType: mediaTypeFor(filename) };
}

// ---------- walks ----------

interface WalkedFile {
  path: string;
  size: number;
  createdAt: number;
}

const MAX_DEPTH = 16;

function walk(root: string, rel = '', depth = 0): WalkedFile[] {
  const real = realRoot(root);
  if (!real || depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rel ? path.join(real, rel) : real, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WalkedFile[] = [];
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (safeRel(child) === null) continue;
    // A real directory is walked; a link is never followed as a directory (that is how walks loop).
    if (e.isDirectory() && !e.isSymbolicLink()) {
      out.push(...walk(root, child, depth + 1));
      continue;
    }
    const file = insideReal(real, child);
    if (!file) continue;
    const st = fs.statSync(file);
    out.push({ path: child, size: st.size, createdAt: Math.round(st.mtimeMs) });
  }
  return out;
}

function entryFor(kind: FileKind, botId: string, botName: string, rel: string, size: number, createdAt: number, filename?: string): FileEntry {
  const name = filename?.trim() || rel.split('/').pop() || rel;
  const id = fileIdFor({ kind, botId, path: rel });
  return {
    id,
    botId,
    botName,
    type: kind,
    filename: name,
    path: rel,
    size,
    mediaType: mediaTypeFor(name),
    createdAt,
    downloadUrl: `/api/files/${id}/download`,
  };
}

/** Every file in a bot's Library, recursively. A bot with no Library yet simply has none. */
export function listLibraryFiles(botId: string, botName: string): FileEntry[] {
  return walk(libraryRoot(botId)).map((f) => entryFor('library', botId, botName, f.path, f.size, f.createdAt));
}

/** Every file in a managed bot's workspace, recursively. Missing dir → []. */
export function listWorkspaceFiles(botId: string, botName: string): FileEntry[] {
  return walk(workspaceRoot(botId)).map((f) => entryFor('workspace', botId, botName, f.path, f.size, f.createdAt));
}

/**
 * Files the agent attached to messages. They live in the Library, so the size and time come from
 * disk when the file is still there; an attachment whose file is gone keeps its message time and
 * a size of 0, so the row still shows up (and its download 404s).
 */
export function listAttachmentFiles(botId: string, botName: string): FileEntry[] {
  const rows = db.prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq ASC").all(botId) as any[];
  const out: FileEntry[] = [];
  for (const row of rows) {
    let body: any;
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    const files = Array.isArray(body?.files) ? body.files : [];
    for (const f of files) {
      const rel = safeRel(typeof f?.path === 'string' ? f.path : null);
      if (!rel) continue;
      const file = resolveInside(libraryRoot(botId), rel);
      let size = 0;
      let createdAt = Number(row.created_at) || 0;
      if (file) {
        const st = fs.statSync(file);
        size = st.size;
        createdAt = Math.round(st.mtimeMs);
      }
      const name = typeof f?.filename === 'string' && f.filename.trim() ? f.filename.trim() : rel.split('/').pop()!;
      out.push(entryFor('attachment', botId, botName, rel, size, createdAt, name));
    }
  }
  return out;
}

// ---------- the aggregate the Files view asks for ----------

export interface AggregateFilesOptions {
  userId: string;
  botId?: string;
  type?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const int = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};

/**
 * Rooms are bot rows, and a room owns no files. The column only exists on a database that has been
 * migrated for rooms, so the clause is added only when it is there.
 */
const NOT_ROOM = (db.prepare('PRAGMA table_info(bots)').all() as { name: string }[]).some((c) => c.name === 'kind')
  ? " AND COALESCE(kind,'agent')<>'room'"
  : '';

/** The user's own bots, or just the one they asked for. A room is not a file owner. */
function botsFor(userId: string, botId?: string): { id: string; name: string; engine: string | null }[] {
  if (botId) {
    const row = db.prepare(`SELECT id, name, engine FROM bots WHERE id=? AND user_id=?${NOT_ROOM}`).get(botId, userId) as any;
    return row ? [row] : [];
  }
  return db
    .prepare(`SELECT id, name, engine FROM bots WHERE user_id=?${NOT_ROOM} ORDER BY created_at ASC`)
    .all(userId) as any[];
}

/** Every file the user can see, filtered, newest first, then one page of it. */
export function aggregateFiles(opts: AggregateFilesOptions): FilesResponse {
  const type = (['library', 'attachment', 'workspace'] as const).includes(opts.type as FileKind)
    ? (opts.type as FileKind)
    : 'all';
  const search = (opts.search ?? '').trim().toLowerCase();
  const page = Math.max(1, int(opts.page, 1));
  const asked = int(opts.pageSize, DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, asked > 0 ? asked : DEFAULT_PAGE_SIZE);

  const files: FileEntry[] = [];
  for (const bot of botsFor(opts.userId, opts.botId)) {
    if (type === 'all' || type === 'library') files.push(...listLibraryFiles(bot.id, bot.name));
    if (type === 'all' || type === 'attachment') files.push(...listAttachmentFiles(bot.id, bot.name));
    // Only a managed bot has a workspace of its own; the primary bot works in its Library.
    if ((type === 'all' || type === 'workspace') && bot.engine === 'managed') files.push(...listWorkspaceFiles(bot.id, bot.name));
  }

  const matched = search ? files.filter((f) => f.filename.toLowerCase().includes(search)) : files;
  matched.sort((a, b) => b.createdAt - a.createdAt || a.filename.localeCompare(b.filename));

  const start = (page - 1) * pageSize;
  return { files: matched.slice(start, start + pageSize), total: matched.length, page, pageSize };
}
