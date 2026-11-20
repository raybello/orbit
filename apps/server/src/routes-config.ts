import { Hono } from 'hono';
import { dockerProvider } from './docker-provider.js';
import { db, now } from './db.js';
import './db-config.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileHeaders } from './lib/mime.js';
import { Readable } from 'node:stream';
import { env } from './env.js';
import { emitBot, getBotRow, listRoutines, listTasks } from './store.js';
import { computerState } from './computer.js';
import { engineHome, engineInfo, engineKind, forgetEngineOptions, restartEngine, stopOwnScreen, syncAllManagedAuth } from './engine.js';
import { applyModelChoice, asBlock, readDotenv, readYaml, writePrivate, SHARED_ENV } from './hermes-files.js';
import { listMemories } from './engine-memory.js';
import { viewerCount } from './idle.js';
import { optionalBody, requireBody, SharedSettingsSchema, EngineChoiceSchema } from './api/schemas.js';
import { listLibrary } from './core/skill-library.js';
import { isInstanceOwner } from './core/data-files.js';
import { checkSettings, readSharedSettings, saveSharedSettings } from './hermes-settings.js';
import type { BotEngineAuthRow } from '@orbit/contracts';
import type { BotRow } from './infra/bot-repository.js';
import YAML from 'yaml';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

for (const p of ['/bots/*', '/skills/*', '/computer/*', '/config/*']) configApi.use(p, requireUser);

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

/** Message off a caught value, which may be an Error or anything a dependency threw. */
const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

/** A provider/model value from a settings request: trimmed and capped, or null for "the agent's default". */
const engineField = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({
    memories: listMemories(b.id),
    skills: listLibrary(b.user_id).filter((sk) => sk.bots.some((x) => x.botId === b.id && x.allowed)),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    // The agent keeps its own memory and trims its own context; there is nothing for the app to maintain.
    memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 0, lastCompaction: null },
  });
});

// ---------- memory maintenance (now the agent's own job; kept so older clients get an answer) ----------

configApi.post('/bots/:id/memories/consolidate', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ added: [], skipped: 0, considered: 0 });
});

configApi.post('/bots/:id/compact', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ itemsBefore: 0, itemsAfter: 0, compacted: false });
});

configApi.get('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ engine: await engineInfo(b.id) });
});

/** Which model this bot's turns ask for. Empty values go back to the agent's own default. */
configApi.patch('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await optionalBody(c, EngineChoiceSchema, {});
  if (p.provider !== undefined) db.prepare('UPDATE bots SET provider=?, updated_at=? WHERE id=?').run(engineField(p.provider), now(), b.id);
  if (p.model !== undefined) db.prepare('UPDATE bots SET model=?, updated_at=? WHERE id=?').run(engineField(p.model), now(), b.id);
  emitBot(b.id);
  return c.json({ engine: await engineInfo(b.id) });
});

configApi.post('/bots/:id/engine/restart', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!engineKind(b.id)) return c.json({ error: 'This bot has no agent.' }, 409);
  try {
    await restartEngine(b.id);
    forgetEngineOptions(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e) {
    return c.json({ error: messageOf(e).slice(0, 300) }, 502);
  }
});

/** Stop the private screen Hermes runs for this agent, so its computer work comes back to the screen shown here. */
configApi.post('/bots/:id/engine/screen/stop', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await stopOwnScreen(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e) {
    return c.json({ error: messageOf(e).slice(0, 300) }, 409);
  }
});

/** The user gives the screen back after taking control; the bot is told on its next turn. */
configApi.post('/bots/:id/handback', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET handback_at=? WHERE id=?').run(now(), b.id);
  return c.json({ ok: true });
});

/** Which SHARED_ENV keys a bot's .env has non-empty. Never the values themselves. */
function keysPresentFor(home: string): string[] {
  const vars = readDotenv(path.join(home, '.env'));
  return SHARED_ENV.filter((k) => (vars[k] ?? '').trim() !== '');
}

/** One row of the table. A bot whose agent does not answer still gets a row, with status 'unknown'. */
async function engineAuthRow(b: BotRow): Promise<BotEngineAuthRow | null> {
  const engine = engineKind(b.id);
  const home = engineHome(b.id);
  if (!engine || !home) return null;
  let status: BotEngineAuthRow['status'] = 'unknown';
  try { status = (await engineInfo(b.id)).status; } catch { status = 'unknown'; }
  let model: string | null = b.model ?? null;
  let provider: string | null = b.provider ?? null;
  // Most bots have no model of their own: their config names one, so say which model that is rather
  // than showing a blank (or the old 'Default' placeholder the panel used to store).
  if (!model || String(model).trim().toLowerCase() === 'default') {
    try {
      const block = readYaml(path.join(home, 'config.yaml')).model;
      const name = typeof block === 'string' ? block : asBlock(block).default;
      if (typeof name === 'string' && name.trim()) model = name.trim();
      const fromCfg = asBlock(block).provider;
      if (!provider && typeof fromCfg === 'string' && fromCfg.trim()) provider = fromCfg.trim();
    } catch { /* no config yet */ }
  }
  return {
    botId: b.id,
    name: b.name,
    engine,
    provider,
    model,
    status,
    keysPresent: keysPresentFor(home),
  };
}

configApi.get('/config/engine-auth', async (c) => {
  // SELECT * and filter in JS: `kind` and `hidden` are added to the bots table lazily (initRooms,
  // initSubagents), so naming them in the SQL would fail wherever those have not run.
  const bots = (db.prepare("SELECT * FROM bots WHERE user_id=? AND engine IN ('primary','managed') ORDER BY is_primary DESC, created_at ASC").all(c.get('user').id) as BotRow[])
    .filter((r) => !r.hidden && r.kind !== 'room');
  const rows = await Promise.all(bots.map(engineAuthRow));
  return c.json({ bots: rows.filter((r): r is BotEngineAuthRow => r !== null) });
});

configApi.put('/config/engine-auth/:botId', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('botId'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const home = engineHome(b.id);
  if (!home) return c.json({ error: 'This bot has no agent.' }, 409);
  const p = await optionalBody(c, EngineChoiceSchema, {});
  const provider = p.provider === undefined ? undefined : engineField(p.provider);
  // The settings panel shows the word Default when nothing is chosen; saving it back would pin a
  // model id no provider knows and quietly stop the bot answering. It means "no choice".
  const model = p.model === undefined ? undefined : (String(p.model ?? '').trim().toLowerCase() === 'default' ? null : engineField(p.model));

  // The bot's own Hermes reads its model from its config.yaml. A field left out keeps its current
  // value; applyModelChoice then brings the provider's own endpoint, so a switch away from a custom
  // server does not leave its base_url behind.
  if (provider !== undefined || model !== undefined) {
    const cfgFile = path.join(home, 'config.yaml');
    const cfg = readYaml(cfgFile);
    const current = asBlock(cfg.model);
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    applyModelChoice(cfg, provider !== undefined ? provider : text(current.provider), model !== undefined ? model : text(current.default));
    writePrivate(cfgFile, YAML.stringify(cfg));
  }

  if (provider !== undefined) db.prepare('UPDATE bots SET provider=?, updated_at=? WHERE id=?').run(provider, now(), b.id);
  if (model !== undefined) db.prepare('UPDATE bots SET model=?, updated_at=? WHERE id=?').run(model, now(), b.id);
  emitBot(b.id);
  const row = await engineAuthRow(getBotRow(b.id));
  return c.json({ bot: row });
});

/** Bring every managed bot's credentials up to date with the primary agent's. */
configApi.post('/config/engine-auth/sync', async (c) => {
  // A restart is what makes a newly copied key take effect: the gateway read its .env at start.
  const synced = await syncAllManagedAuth({ restart: true });
  // The web app keeps an engine row per bot; a sync can change what each one reports.
  for (const b of db.prepare("SELECT id FROM bots WHERE user_id=? AND engine='managed'").all(c.get('user').id) as { id: string }[]) emitBot(b.id);
  return c.json({ synced });
});

/**
 * The shared Hermes settings hold every model key in plain text, so only the person whose computer
 * runs the primary agent may read or change them (anyone, on a fresh install with no primary yet).
 */
const mayEditSharedSettings = isInstanceOwner;

configApi.get('/config/hermes-settings', (c) => {
  if (!mayEditSharedSettings(c.get('user').id)) return c.json({ error: 'Only the owner of the primary Bot can see these settings.' }, 403);
  return c.json(readSharedSettings());
});

configApi.put('/config/hermes-settings', async (c) => {
  if (!mayEditSharedSettings(c.get('user').id)) return c.json({ error: 'Only the owner of the primary Bot can change these settings.' }, 403);
  const next = await requireBody(c, SharedSettingsSchema);
  const problem = checkSettings(next);
  if (problem) return c.json({ error: problem.message, ...problem }, 400);
  const result = saveSharedSettings(next);
  for (const id of result.updated) emitBot(id);
  return c.json({ ...result, settings: readSharedSettings() });
});

const LIB_ROOT = `${env.botDataDir}/files`;

function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}



/**
 * The absolute path of `rel` under `root`, or null when it escapes the root or is not there.
 * Links are followed before the check, so a link inside the folder cannot point outside it.
 */
function resolveUnder(root: string, rel: string): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const target = fs.realpathSync(rel ? path.join(realRoot, rel) : realRoot);
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return null;
    return target;
  } catch {
    return null;
  }
}






/**
 * A chat attachment. Attachments are Library files, and the Library is this server's disk: image
 * search writes there and the file listing reads there. A Docker bot's own computer never holds
 * them (and may be paused).
 */
configApi.get('/bots/:id/files/raw', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const file = resolveUnder(`${LIB_ROOT}/${b.id}`, rel);
  if (!file) return c.json({ error: 'not found' }, 404);
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return c.json({ error: 'not found' }, 404);
    size = st.size;
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: fileHeaders(rel.split('/').pop()!, size) });
});

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  // Each bot's screen on its own computer, most recently set up first.
  const leases = db.prepare(
    `SELECT cs.bot_id, cs.screen_id, COALESCE(cs.ensured_at, cs.idle_at, 0) AS last_used_at
       FROM computer_screens cs JOIN bots b ON b.id=cs.bot_id WHERE b.user_id=? ORDER BY last_used_at DESC`,
  ).all(userId) as { bot_id: string; screen_id: string; last_used_at: number }[];
  return c.json({
    computer: computerState(userId),
    screens: leases.map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),
    hibernation: { idleMinutes: env.computerIdleTimeoutMin, viewers: viewerCount(userId) },
  });
});

/** Give a bot a clean screen: close what is open and bring its browser back to its home screen. Logins stay. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await dockerProvider.resetScreen(user.id, b.id);
    hub.emit(user.id, { type: 'computer', state: computerState(user.id) });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: messageOf(e).slice(0, 300) }, 502);
  }
});
