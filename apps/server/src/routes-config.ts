import { Hono } from 'hono';
import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import { mediaTypeFor } from './lib/mime.js';
import { Readable } from 'node:stream';
import { env } from './env.js';
import { emitBot, getBotRow, listRoutines, listTasks } from './store.js';
import { computerState, readyScreen } from './computer.js';
import { computerKindFor, providerFor } from './computer-provider-registry.js';
import { box, type Box } from './box.js';
import { dockerBox } from './docker/docker-box.js';
import { getComputer } from './computer-store.js';
import { orgo } from './orgo.js';
import { openTerminal } from './desk.js';
import { engineHome, engineInfo, engineKind, forgetEngineOptions, restartEngine, stopOwnScreen, syncAllManagedAuth } from './engine.js';
import { asBlock, readDotenv, readYaml, writePrivate, SHARED_ENV } from './hermes-files.js';
import { listMemories } from './engine-memory.js';
import { idleConfig, viewerCount } from './idle.js';
import { optionalBody, SkillBodySchema, EngineChoiceSchema, EngineLoginSchema, FileDownloadSchema } from './api/schemas.js';
import type { BotEngineAuthRow, LibraryFile, Skill } from '@orbit/contracts';
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

/** A `skills` row: the table's first three columns, plus the ones db.ts adds later. */
interface SkillRow {
  id: string;
  bot_id: string;
  name: string;
  description: string | null;
  body: string;
  created_at: number;
  updated_at: number | null;
}

const toSkill = (s: SkillRow): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const listSkills = (botId: string) => (db.prepare('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId) as SkillRow[]).map(toSkill);

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({
    memories: listMemories(b.id),
    skills: listSkills(b.id),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    // The agent keeps its own memory and trims its own context; there is nothing for the app to maintain.
    memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 0, lastCompaction: null },
  });
});

function cleanSkill(p: Record<string, unknown>, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    out.body = body.slice(0, 20_000);
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await optionalBody(c, SkillBodySchema, {}));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, s.name, s.body, s.description ?? '', now(), now());
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(id) as SkillRow) });
});

const ownSkill = (userId: string, id: string) =>
  db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId) as SkillRow | undefined;

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await optionalBody(c, SkillBodySchema, {}), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(s.name ?? cur.name, s.body ?? cur.body, s.description ?? cur.description ?? '', now(), cur.id);
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(cur.id) as SkillRow) });
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true });
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

/**
 * Sign in to a model provider (a Claude, ChatGPT or Grok subscription, or an API key). Hermes does
 * the sign-in itself; we open its command in a terminal on the bot's screen, where the user
 * finishes it through the live view.
 */
configApi.post('/bots/:id/engine/login', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const home = engineHome(b.id);
  if (!home) return c.json({ error: 'This bot has no agent.' }, 409);
  // The agent's files are on the machine this server runs on; a terminal on another machine cannot reach them.
  if (computerKindFor(b.id) === 'docker') {
    return c.json({ error: 'Sign-in opens a terminal on the computer where the agent lives, and this Bot has a computer of its own. Use the model settings instead.' }, 409);
  }
  if (!box.local) return c.json({ error: 'Sign-in opens a terminal on the computer. It works once the app runs on that computer.' }, 409);
  const { provider } = await optionalBody(c, EngineLoginSchema, {});
  if (provider !== undefined && !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(provider)) return c.json({ error: 'bad provider' }, 400);
  const hermes = `HERMES_HOME=${box.quote(home)} ${box.quote(env.hermesBin)}`;
  // Claude subscriptions sign in with OAuth; without the flag Hermes asks for an API key.
  const cmd = !provider ? `${hermes} model` : `${hermes} auth add ${provider}${provider === 'anthropic' ? ' --type oauth' : ''}`;
  try {
    const s = await readyScreen(user.id, b.id);
    await openTerminal(s.screenId, cmd, provider ? `Sign in: ${provider}` : 'Choose a model');
    forgetEngineOptions(b.id);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: messageOf(e).slice(0, 300) }, 502);
  }
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

  // The bot's own Hermes reads its model from its config.yaml, so patch those two fields there.
  // The rest of the file (providers, base_url, toolsets, mcp_servers) is its own and is left alone.
  if (provider !== undefined || model !== undefined) {
    const cfgFile = path.join(home, 'config.yaml');
    const cfg = readYaml(cfgFile);
    const m = { ...asBlock(cfg.model) };
    if (provider !== undefined) { if (provider) m.provider = provider; else delete m.provider; }
    if (model !== undefined) { if (model) m.default = model; else delete m.default; }
    cfg.model = m;
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

const LIB_ROOT = `${env.botDataDir}/files`;

function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Parse `ls -la --time-style=+%s` output. */
export function parseLs(out: string): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === 'l') name = name.replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    files.push({ name, size: Number(m[2]), modifiedAt: Number(m[3]) * 1000, isDir: m[1] === 'd' });
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

/** A Docker bot's files live on its own computer, at its home folder. */
const CONTAINER_HOME = '/home/bot';

/**
 * Where the Library tab reads a bot's filesystem from.
 *
 * A Docker bot is browsed through its own container: that is the tree the agent sees, and it is
 * there while the computer runs (the panel offers to start it). A local-box server reads the
 * Library folder from its own disk; the shared computer lists the same folder over its box.
 */
type LibrarySource =
  | { kind: 'docker'; box: Box }
  | { kind: 'local'; root: string }
  | { kind: 'missing' }
  | { kind: 'orgo' };

function librarySource(botId: string): LibrarySource {
  if (computerKindFor(botId) === 'docker') {
    const container = getComputer(botId)?.container_id;
    return container ? { kind: 'docker', box: dockerBox(container) } : { kind: 'missing' };
  }
  if (box.local) return { kind: 'local', root: `${LIB_ROOT}/${botId}` };
  return { kind: 'orgo' };
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

/** One directory as the explorer shows it: folders first, then names. */
function listDirectory(root: string, rel: string): LibraryFile[] {
  const dir = resolveUnder(root, rel);
  if (!dir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries.map((e) => {
    let size = 0; let modifiedAt = 0; let isDir = e.isDirectory();
    try {
      const st = fs.statSync(path.join(dir, e.name));
      size = st.size; modifiedAt = st.mtimeMs; isDir = st.isDirectory();
    } catch { /* a link that points nowhere counts as an empty file */ }
    return { name: e.name, size, modifiedAt, isDir };
  });
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/** One directory inside a Docker bot's computer, through the same box its desk uses. */
async function listInContainer(b: Box, rel: string): Promise<{ status: 'ok' | 'asleep' | 'error'; files: LibraryFile[]; error?: string }> {
  const dir = rel ? `${CONTAINER_HOME}/${rel}` : CONTAINER_HOME;
  try {
    const r = await b.bash(`ls -la --time-style=+%s -- ${shq(dir)} 2>&1`, 20);
    if (r.exit_code === 0) return { status: 'ok', files: parseLs(r.output ?? '') };
    const out = (r.output ?? '').slice(0, 300);
    // A folder that is gone reads as empty; anything else means the computer is not answering.
    if (/No such file or directory/.test(out)) return { status: 'ok', files: [] };
    return { status: 'asleep', files: [] };
  } catch {
    // `docker exec` refuses a stopped container: the panel offers to start it.
    return { status: 'asleep', files: [] };
  }
}

configApi.get('/bots/:id/files', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  const wake = c.req.query('wake') === '1';
  try {
    let source = librarySource(b.id);
    if ((source.kind === 'missing' || source.kind === 'docker') && wake) {
      // Starting the computer is what creates the container the browser reads through.
      await providerFor(b.id).ensureComputer(b.id).catch(() => {});
      source = librarySource(b.id);
    }
    if (source.kind === 'missing') return c.json({ status: 'asleep', path: rel, root: CONTAINER_HOME, files: [] });

    if (source.kind === 'local') {
      fs.mkdirSync(source.root, { recursive: true });
      return c.json({ status: 'ok', path: rel, root: source.root, files: listDirectory(source.root, rel) });
    }
    if (source.kind === 'docker') {
      const listed = await listInContainer(source.box, rel);
      return c.json({ status: listed.status, path: rel, root: CONTAINER_HOME, files: listed.files, ...(listed.error ? { error: listed.error } : {}) });
    }

    if (computerState(user.id).status !== 'running') return c.json({ status: 'asleep', path: rel, files: [] });
    const root = `${LIB_ROOT}/${b.id}`;
    const dir = `${root}${rel ? `/${rel}` : ''}`;
    const r = await box.bash(`mkdir -p ${shq(root)} && ls -la --time-style=+%s ${shq(dir)} 2>&1`, 30);
    if (r.exit_code !== 0) return c.json({ status: 'error', path: rel, files: [], error: (r.output ?? '').slice(0, 300) });
    return c.json({ status: 'ok', path: rel, files: parseLs(r.output ?? '') });
  } catch (e) {
    return c.json({ status: 'error', path: rel, files: [], error: messageOf(e).slice(0, 300) });
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path } = await optionalBody(c, FileDownloadSchema, {});
  const rel = safeRel(path);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const source = librarySource(b.id);
  // A computer this server can read (its own disk or the bot's container): serve it directly.
  if (source.kind === 'docker' || source.kind === 'local') {
    return c.json({ url: `/api/bots/${b.id}/files/raw?path=${encodeURIComponent(rel)}` });
  }
  if (source.kind === 'missing') return c.json({ error: 'computer unavailable' }, 409);
  try {
    if (!env.orgoComputerId) return c.json({ error: 'computer unavailable' }, 409);
    const r = (await orgo.exportFile(env.orgoComputerId, `${LIB_ROOT}/${b.id}/${rel}`)) as
      | { url?: string; file?: { url?: string }; download_url?: string }
      | null
      | undefined;
    const url = r?.url ?? r?.file?.url ?? r?.download_url;
    if (!url) return c.json({ error: 'export returned no link' }, 502);
    return c.json({ url });
  } catch (e) {
    return c.json({ error: messageOf(e).slice(0, 300) }, 502);
  }
});

/** How a file is served: images, audio, video and PDFs open in the browser, the rest download. */
function fileHeaders(name: string, size: number): Record<string, string> {
  const mediaType = mediaTypeFor(name);
  const inline = mediaType.startsWith('image/') || mediaType.startsWith('audio/') || mediaType.startsWith('video/') || mediaType === 'application/pdf';
  return {
    'content-type': mediaType,
    'content-length': String(size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
  };
}

configApi.get('/bots/:id/files/raw', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const name = rel.split('/').pop()!;
  const source = librarySource(b.id);

  if (source.kind === 'docker') {
    // Base64 through an exec is the only way out of a container without a copied temp file, so
    // keep it to files a browser preview can use.
    const MAX = 32 * 1024 * 1024;
    const target = `${CONTAINER_HOME}/${rel}`;
    // -1 means "not a file"; 0 is a real, empty file.
    const probe = await source.box.bash(`if [ -f ${shq(target)} ]; then stat -c %s -- ${shq(target)}; else echo -1; fi`, 15).catch(() => null);
    const size = Number((probe?.output ?? '-1').trim());
    if (!Number.isFinite(size) || size < 0) return c.json({ error: 'not found' }, 404);
    if (size > MAX) return c.json({ error: 'file is too large to stream from the computer' }, 413);
    const buf = await source.box.readFile(target).catch(() => null);
    if (!buf) return c.json({ error: 'not found' }, 404);
    return new Response(new Uint8Array(buf), { headers: fileHeaders(name, buf.length) });
  }

  if (source.kind !== 'local') return c.json({ error: 'not found' }, 404);
  const file = resolveUnder(source.root, rel);
  if (!file) return c.json({ error: 'not found' }, 404);
  try {
    if (!fs.statSync(file).isFile()) return c.json({ error: 'not found' }, 404);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: fileHeaders(name, fs.statSync(file).size),
  });
});

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  const leases = db.prepare('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? ORDER BY last_used_at DESC').all(userId) as { bot_id: string; screen_id: string; last_used_at: number }[];
  return c.json({
    computer: computerState(userId),
    screens: leases.map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),
    hibernation: { idleMinutes: idleConfig.idleMin, viewers: viewerCount(userId), dryRun: idleConfig.dryRun },
  });
});

/** Give a bot a clean screen: close what is open and bring its browser back to its home screen. Logins stay. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await providerFor(b.id).resetScreen(user.id, b.id);
    hub.emit(user.id, { type: 'computer', state: computerState(user.id) });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: messageOf(e).slice(0, 300) }, 502);
  }
});
