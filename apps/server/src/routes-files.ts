import { Hono } from 'hono';
import type { Context } from 'hono';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { requireUser, type AuthVars } from './lib/auth.js';
import { db } from './db.js';
import { aggregateFiles, resolveFileId } from './files.js';

/**
 * /api/files: one list over every bot's Library, message attachments and workspace, plus a download
 * that streams the file back. Every path needs a signed-in user, and only that user's bots appear.
 */
export const filesApi = new Hono<AuthVars>();
filesApi.use('*', requireUser);

const ownsBot = (userId: string, botId: string) =>
  !!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(botId, userId);

function listFiles(c: Context<AuthVars>) {
  const user = c.get('user');
  const q = c.req.query();
  return c.json(
    aggregateFiles({
      userId: user.id,
      botId: q.botId || undefined,
      type: q.type || undefined,
      search: q.search || undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    }),
  );
}

function downloadFile(c: Context<AuthVars>) {
  const user = c.get('user');
  // The id names a bot and a path; resolving it re-checks the path guard and that the file is there.
  const found = resolveFileId(c.req.param('fileId') ?? '');
  if (!found || !ownsBot(user.id, found.botId)) return c.json({ error: 'not found' }, 404);

  const mediaType = found.mediaType;
  const canPreview =
    mediaType.startsWith('image/') || mediaType.startsWith('audio/') || mediaType.startsWith('video/') || mediaType === 'application/pdf';
  return new Response(Readable.toWeb(fs.createReadStream(found.file)) as ReadableStream, {
    headers: {
      'content-type': mediaType,
      'content-length': String(found.size),
      'content-disposition': `${canPreview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.filename)}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

// index.ts mounts this router at /api/files; the `/files` aliases keep the same URLs if it is
// mounted at /api like the other new routers. Both spellings answer /api/files/... either way.
filesApi.get('/', listFiles);
filesApi.get('/files', listFiles);
filesApi.get('/:fileId/download', downloadFile);
filesApi.get('/files/:fileId/download', downloadFile);
