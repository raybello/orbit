import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { DataListing } from '@orbit/contracts';
import { requireUser, type AuthVars } from './lib/auth.js';
import { fileHeaders } from './lib/mime.js';
import { env } from './env.js';
import { getBotRow } from './store.js';
import { cleanRel, isInstanceOwner, listData, refusalFor, resolveData, workspaceOf } from './core/data-files.js';

/**
 * /api/data: the server's data folder as a file browser. The Library panel and anything else that
 * opens a file a bot wrote reads it here. Only the instance owner may; see core/data-files.ts.
 */
export const dataApi = new Hono<AuthVars>();
dataApi.use('/data/*', requireUser);

const NOT_OWNER = 'Only the owner of this computer can browse its files.';

/**
 * One folder. `?path=` is relative to the data folder; with `?bot=` and no path, the listing opens
 * at that Bot's workspace (falling back to the root when it has none yet).
 */
dataApi.get('/data/files', (c) => {
  const user = c.get('user');
  if (!isInstanceOwner(user.id)) return c.json({ error: NOT_OWNER }, 403);
  const botId = c.req.query('bot');
  const bot = botId ? getBotRow(botId) : null;
  if (botId && (!bot || bot.user_id !== user.id)) return c.json({ error: 'not found' }, 404);
  const workspace = bot ? workspaceOf(bot.id) ?? undefined : undefined;
  if (workspace) fs.mkdirSync(`${env.dataDir}/${workspace}`, { recursive: true });

  const asked = c.req.query('path');
  const rel = cleanRel(asked === undefined && workspace ? workspace : asked);
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  const files = listData(rel);
  if (!files) return c.json({ error: 'not a folder' }, 404);
  const body: DataListing = { root: env.dataDir, path: rel, files, ...(workspace ? { workspace } : {}) };
  return c.json(body);
});

/** One file, as the viewers read it. Credentials and live databases are refused (403). */
dataApi.get('/data/raw', (c) => {
  if (!isInstanceOwner(c.get('user').id)) return c.json({ error: NOT_OWNER }, 403);
  const rel = cleanRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const refusal = refusalFor(rel);
  if (refusal) return c.json({ error: refusal }, 403);
  const file = resolveData(rel);
  let size = 0;
  try {
    if (!file || !fs.statSync(file).isFile()) return c.json({ error: 'not found' }, 404);
    size = fs.statSync(file).size;
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  // The target, not the asked-for name: a link named innocently must not serve a credential file.
  const refused = refusalFor(file);
  if (refused) return c.json({ error: refused }, 403);
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: fileHeaders(rel.split('/').pop()!, size) });
});
