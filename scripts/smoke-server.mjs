#!/usr/bin/env node
/**
 * End-to-end smoke test for the Orbit server's API surface.
 *
 * Starts the built server (apps/server/dist/index.js) against a throwaway SQLite file,
 * exercises the endpoints the desktop and mobile clients depend on, then shuts it down.
 * Plain node:http fetch + child_process; better-sqlite3 (already a server dependency) is used
 * only to plant the fixture rows described below.
 *
 *   node scripts/smoke-server.mjs            # builds nothing; expects `pnpm build` first
 *   PORT=8899 node scripts/smoke-server.mjs  # different port
 *
 * Fixture: the Engine Auth, Files, Calendar, Computers and Skills checks need a *managed* bot —
 * one with a Hermes home of its own. POST /api/bots would provision a real gateway and Docker
 * container for it, which a smoke run has no business doing, so the bot, its home and its computer
 * row are written straight into the throwaway database, the way the server's unit tests do it.
 * Everything lives under the temp dir and is deleted on exit.
 *
 * Exit code is 0 only when every check passes; a failure prints the expected and actual value,
 * the differing paths of a structured body, and the server's log tail.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'apps/server/dist/index.js');
const port = Number(process.env.PORT ?? 8899);
const base = `http://127.0.0.1:${port}`;
const stackToken = `smoke-${crypto.randomBytes(8).toString('hex')}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');
/** A managed bot's Hermes home, the Library/workspace roots and the primary's home: all throwaway. */
const enginesDir = path.join(tmpDir, 'engines');
const botDataDir = path.join(tmpDir, 'bot-data');
const primaryHome = path.join(tmpDir, 'hermes-primary');
for (const dir of [enginesDir, botDataDir, primaryHome]) fs.mkdirSync(dir, { recursive: true });

const MANAGED_BOT = 'bot_smoke_managed';
const MANAGED_NAME = 'Smoke Bot';
/** Markers that must never come back over the API: Engine Auth reports key *names*, not values. */
const PRIMARY_MODEL_KEY = 'sk-smoke-primary-model-key';
const STALE_MODEL_KEY = 'sk-smoke-stale-model-key';
const MANAGED_ONLY_KEY = 'sk-smoke-managed-only-key';
const SKILL = 'smoke_skill';

if (!fs.existsSync(entry)) {
  console.error(`missing ${entry} — run \`pnpm build\` first`);
  process.exit(2);
}

const results = [];
const fmt = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

/** Every differing path between two JSON values, for a failure message that names the field. */
function diffValues(expected, actual, prefix = '', out = []) {
  const isObj = (v) => v !== null && typeof v === 'object';
  if (out.length >= 8) return out;
  if (isObj(expected) && isObj(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    if (Array.isArray(expected)) {
      if (expected.length !== actual.length) out.push(`${prefix || '$'}: ${actual.length} items (expected ${expected.length})`);
      for (let i = 0; i < Math.max(expected.length, actual.length) && out.length < 8; i++) {
        diffValues(expected[i], actual[i], `${prefix}[${i}]`, out);
      }
      return out;
    }
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (out.length >= 8) break;
      diffValues(expected[k], actual[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) out.push(`${prefix || '$'}: ${fmt(actual)} (expected ${fmt(expected)})`);
  return out;
}

/**
 * Record one assertion. `expect` ({ expected, actual }) is optional; when the check fails it is
 * printed as an expected/actual pair, plus the differing paths when both sides are structured.
 */
function check(name, ok, detail = '', expect = undefined) {
  const entry = { name, ok, detail, ...(expect ?? {}) };
  results.push(entry);
  if (ok) {
    console.log(`PASS  ${name}${detail && detail.length <= 120 ? ` — ${detail}` : ''}`);
    return true;
  }
  console.log(`FAIL  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (expect) {
    console.log(`      expected: ${fmt(expect.expected)}`);
    console.log(`      actual:   ${fmt(expect.actual)}`);
    for (const line of diffValues(expect.expected, expect.actual)) console.log(`      diff:     ${line}`);
  }
  return false;
}

/** JSON.stringify equality: enough for the flat values this script asserts, and readable in a diff. */
function checkEqual(name, actual, expected) {
  return check(name, JSON.stringify(actual) === JSON.stringify(expected), '', { expected, actual });
}

async function request(pathname, init = {}) {
  const res = await fetch(base + pathname, { ...init, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

const short = (s, n = 400) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

/** Assert only the status: on a miss the response body is quoted, which is usually the whole story. */
function checkStatus(name, res, want) {
  return check(name, res.status === want, `got ${res.status}: ${short(res.text)}`, {
    expected: `HTTP ${want}`,
    actual: `HTTP ${res.status}`,
  });
}

/** Assert the status and, when it is right, that the body carries the expected keys. */
function checkShape(name, res, want, keys) {
  const body = res.body;
  const ok = res.status === want && keys.every((k) => body !== null && typeof body === 'object' && k in body);
  const got = body !== null && typeof body === 'object' ? Object.keys(body).sort() : body;
  return check(name, ok, ok ? '' : `got ${res.status}: ${short(res.text)}`, {
    expected: `HTTP ${want} with { ${keys.join(', ')} }`,
    actual: got,
  });
}

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    DEV_LOGIN: '1',
    GROKBOT_NO_SCHEDULER: '1',
    STACK_TOKEN: stackToken,
    MCP_BASE_URL: base,
    // Keep every file the server writes inside the temp dir, and give it a primary Hermes home we
    // control: Engine Auth and Skills read that home, so the checks below are deterministic.
    ENGINES_DIR: enginesDir,
    BOT_DATA_DIR: botDataDir,
    HERMES_HOME_PRIMARY: primaryHome,
    // A smoke run must never start a real agent: provisioning the fixture bot would spawn
    // `hermes gateway run` for up to 90 seconds. A binary that exits at once fails the start
    // cleanly, which is what a stack with no gateway should do anyway.
    HERMES_BIN: '/usr/bin/true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

async function waitForHealth(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await request('/api/health');
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stop() {
  if (!child.killed) child.kill('SIGTERM');
}

/** Leave nothing behind, even when the run is cut short (Ctrl-C, a closed stdout pipe). */
function cleanup() {
  stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { cleanup(); process.exit(1); });
}

// ---------- fixtures ----------

/** The primary agent's config.yaml: the source of truth Skills reads, shared by every managed bot. */
function writePrimaryConfig() {
  fs.writeFileSync(
    path.join(primaryHome, 'config.yaml'),
    ['mcp_servers:', `  ${SKILL}:`, '    url: http://127.0.0.1:4000/mcp', '    description: smoke fixture', ''].join('\n'),
  );
}

/**
 * The primary agent's home: one model key in `.env` (Engine Auth reports which keys are there) and,
 * later, a `config.yaml` with an mcp server (Skills reads it). Kept separate from the managed home
 * so `syncManagedAuth` has something to copy.
 */
function seedPrimaryHome() {
  fs.writeFileSync(path.join(primaryHome, '.env'), `DEEPSEEK_API_KEY=${PRIMARY_MODEL_KEY}\n`);
}

/**
 * A managed bot the way `writeHome()` would have left it — its own `.env` (one stale model key the
 * primary also has, one key only it has) and its own `config.yaml` (the app's `hq` server, plus the
 * skill the primary defines) — and a computer row saying its container is running, with a screen.
 */
function writeManagedEnv(deepseekKey) {
  fs.writeFileSync(
    path.join(enginesDir, MANAGED_BOT, '.env'),
    [`DEEPSEEK_API_KEY=${deepseekKey}`, `OPENAI_API_KEY=${MANAGED_ONLY_KEY}`, 'API_SERVER_KEY=smoke-managed-key', ''].join('\n'),
  );
}

function seedManagedBot(userId) {
  const home = path.join(enginesDir, MANAGED_BOT);
  fs.mkdirSync(home, { recursive: true });
  writeManagedEnv(STALE_MODEL_KEY);
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    ['mcp_servers:', '  hq:', `    url: ${base}/mcp/${MANAGED_BOT}`, `  ${SKILL}:`, '    url: http://127.0.0.1:4000/mcp', ''].join('\n'),
  );

  const Database = createRequire(path.join(root, 'apps/server/package.json'))('better-sqlite3');
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const t = Date.now();
    db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(MANAGED_BOT, userId, MANAGED_NAME, 'managed', 8791, t, t);
    db.prepare('INSERT INTO bot_computers(bot_id,kind,state,updated_at) VALUES (?,?,?,?)')
      .run(MANAGED_BOT, 'docker', 'running', t);
    db.prepare('INSERT INTO computer_screens(bot_id,screen_id,display_index,vnc_port,cdp_port,ensured_at) VALUES (?,?,?,?,?,?)')
      .run(MANAGED_BOT, 'screen-7', 7, 6907, 9307, t);
  } finally {
    db.close();
  }
}

const readManagedFile = (name) => fs.readFileSync(path.join(enginesDir, MANAGED_BOT, name), 'utf8');

try {
  if (!(await waitForHealth())) {
    console.error('server never became healthy:\n' + log.slice(-2000));
    stop();
    process.exit(2);
  }

  const health = await request('/api/health');
  check('GET /api/health', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));
  check('health reports a version', typeof health.body?.version === 'string');

  const verified = await request('/api/health', { headers: { 'x-orbit-stack-token': stackToken } });
  check('health marks a matching stack token', verified.body?.stackToken === 'verified');
  const wrong = await request('/api/health', { headers: { 'x-orbit-stack-token': 'nope' } });
  check('health ignores a wrong stack token', wrong.body?.stackToken === undefined);

  const probeNoAuth = await request('/api/desktop/probe');
  check('desktop probe needs the stack token', probeNoAuth.status === 401, String(probeNoAuth.status));
  const probe = await request('/api/desktop/probe', { headers: { 'x-orbit-stack-token': stackToken } });
  check('desktop probe answers with the token', probe.status === 200 && probe.body?.ok === true, JSON.stringify(probe.body));

  const signIn = await request('/api/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@orbit.test', name: 'Smoke' }),
  });
  check('POST /api/auth/sign-in mints a token', signIn.status === 200 && typeof signIn.body?.token === 'string');
  const bearer = signIn.body?.token ? { Authorization: `Bearer ${signIn.body.token}` } : {};

  const bots = await request('/api/bots', { headers: bearer });
  check('GET /api/bots with a bearer token', bots.status === 200 && Array.isArray(bots.body?.bots) && bots.body.bots.length > 0,
    `${bots.status} ${bots.body?.bots?.length ?? 0} bots`);
  const botId = bots.body?.bots?.[0]?.id;

  if (botId) {
    const rows = await request(`/api/bots/${botId}/rows`, { headers: bearer });
    check('GET /api/bots/:id/rows', rows.status === 200 && Array.isArray(rows.body?.rows));
  }

  const cfgWithout = await request('/api/desktop/config', { headers: bearer });
  check('desktop config is gated on x-orbit-desktop', cfgWithout.status === 403, String(cfgWithout.status));
  const cfg = await request('/api/desktop/config', { headers: { ...bearer, 'x-orbit-desktop': '1' } });
  check('GET /api/desktop/config', cfg.status === 200 && typeof cfg.body?.updateCheckUrl === 'string', JSON.stringify(cfg.body));

  const push = await request('/api/push/register', {
    method: 'POST',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ token: `ExponentPushToken[smoke-${Date.now()}]`, platform: 'ios' }),
  });
  check('POST /api/push/register', push.status === 200 && push.body?.ok === true);
  const badPush = await request('/api/push/register', {
    method: 'POST',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'x', platform: 'symbian' }),
  });
  check('push rejects an unknown platform', badPush.status === 400, String(badPush.status));
  const unpush = await request('/api/push/register', { method: 'DELETE', headers: bearer });
  check('DELETE /api/push/register', unpush.status === 200 && unpush.body?.ok === true);

  // SSE: the hello frame carries a seq and ?since replays buffered events.
  const controller = new AbortController();
  const sse = await fetch(`${base}/api/events?since=0`, { headers: bearer, signal: controller.signal });
  check('GET /api/events?since=0 opens', sse.status === 200 && String(sse.headers.get('content-type')).includes('text/event-stream'));
  let frames = '';
  const reader = sse.body.getReader();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      frames += new TextDecoder().decode(value);
      if (frames.includes('"type":"ping"')) break;
    }
  } catch { /* aborted by the timer */ }
  clearTimeout(timer);
  controller.abort();
  const hello = frames.split('\n').find((l) => l.startsWith('data: ') && l.includes('"hello"'));
  check('SSE sends a hello frame with a seq', Boolean(hello && /"seq":\d+/.test(hello)), hello ?? '(no frame)');

  // The screen's Retry button calls this. In a stack with no Orgo computer it used to 500,
  // because the handler went straight to Orgo instead of the bot's own Docker computer.
  const ensureComputer = await request('/api/computer/ensure', { method: 'POST', headers: bearer });
  check(
    'POST /api/computer/ensure answers without an Orgo computer',
    ensureComputer.status === 200 && ensureComputer.body?.computer?.status === 'running',
    `${ensureComputer.status} ${JSON.stringify(ensureComputer.body?.computer?.status)}`,
  );

  // ---------- fixture: one managed bot with its own Hermes home and a running computer ----------
  const me = await request('/api/auth/me', { headers: bearer });
  const userId = me.body?.user?.id;
  check('GET /api/auth/me names the signed-in user', typeof userId === 'string', short(me.text));
  const primaryBotId = bots.body?.bots?.find((b) => b.isPrimary)?.id;
  check('the roster marks a primary bot', typeof primaryBotId === 'string',
    JSON.stringify(bots.body?.bots?.map((b) => [b.id, b.isPrimary])));
  if (userId) {
    seedPrimaryHome();
    seedManagedBot(userId);
  }

  // ---------- App Settings → Engine Auth ----------
  const engineAuth = await request('/api/config/engine-auth', { headers: bearer });
  checkShape('GET /api/config/engine-auth', engineAuth, 200, ['bots']);
  const authRows = Array.isArray(engineAuth.body?.bots) ? engineAuth.body.bots : [];
  checkEqual('engine-auth lists the primary and the managed bot', authRows.map((r) => r.engine), ['primary', 'managed']);
  check(
    'every engine-auth row names its bot and the keys it holds',
    authRows.length === 2 && authRows.every((r) =>
      typeof r.botId === 'string' && typeof r.name === 'string' && Array.isArray(r.keysPresent) && r.keysPresent.every((k) => typeof k === 'string')),
    short(engineAuth.text),
  );
  checkEqual('the primary row reports the shared model key',
    authRows.find((r) => r.engine === 'primary')?.keysPresent, ['DEEPSEEK_API_KEY']);
  checkEqual('the managed row reports its own keys too',
    authRows.find((r) => r.engine === 'managed')?.keysPresent, ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY']);
  check(
    'every engine-auth row has a known status',
    authRows.every((r) => ['ready', 'starting', 'stopped', 'error', 'unknown'].includes(r.status)),
    authRows.map((r) => `${r.engine}=${r.status}`).join(' '),
  );
  check('engine-auth never returns a key value', !engineAuth.text.includes('sk-smoke'),
    engineAuth.text.includes('sk-smoke') ? 'the response body leaked a secret' : '');

  // Asking for the table also kick-starts a bot that is not up, in the background. Let that settle
  // before writing to the bot's home, or the provisioning pass would race the next fixture write.
  let settled = engineAuth;
  for (let i = 0; i < 40 && settled.body?.bots?.find((r) => r.engine === 'managed')?.status === 'starting'; i++) {
    await new Promise((r) => setTimeout(r, 250));
    settled = await request('/api/config/engine-auth', { headers: bearer });
  }
  checkEqual('a managed bot that cannot start settles on error, not on starting',
    settled.body?.bots?.find((r) => r.engine === 'managed')?.status, 'error');

  // Rotate the primary's key and leave the bot behind: what `sync` exists to repair.
  writeManagedEnv(STALE_MODEL_KEY);
  const sync = await request('/api/config/engine-auth/sync', { method: 'POST', headers: bearer });
  checkShape('POST /api/config/engine-auth/sync', sync, 200, ['synced']);
  check('sync reports a count', typeof sync.body?.synced === 'number' && sync.body.synced >= 0, short(sync.text));
  checkEqual('sync reports the one managed bot it repaired', sync.body?.synced, 1);
  const syncedEnv = readManagedFile('.env');
  check(
    'sync copies the rotated primary key into the managed .env',
    syncedEnv.includes(`DEEPSEEK_API_KEY=${PRIMARY_MODEL_KEY}`) && !syncedEnv.includes(STALE_MODEL_KEY),
    syncedEnv.split('\n').filter((l) => l.startsWith('DEEPSEEK')).map((l) => l.replace(/=.*/, '=…')).join(' '),
  );
  check('sync leaves a key only the bot has alone', syncedEnv.includes(`OPENAI_API_KEY=${MANAGED_ONLY_KEY}`));

  // ---------- Files ----------
  const files = await request('/api/files', { headers: bearer });
  checkShape('GET /api/files', files, 200, ['files', 'total', 'page', 'pageSize']);
  checkEqual('files starts as one empty page', {
    files: files.body?.files,
    total: files.body?.total,
    page: files.body?.page,
    pageSize: files.body?.pageSize,
  }, { files: [], total: 0, page: 1, pageSize: 50 });

  // A message that carries an attachment: what `show_file` or a screenshot leaves behind. The file
  // lives in the bot's Library and the message names it, which is exactly what the Files view reads.
  const NOTE = 'smoke-notes.txt';
  const NOTE_TEXT = 'hello from the smoke run\n';
  fs.mkdirSync(path.join(botDataDir, 'files', MANAGED_BOT), { recursive: true });
  fs.writeFileSync(path.join(botDataDir, 'files', MANAGED_BOT, NOTE), NOTE_TEXT);
  {
    const Database = createRequire(path.join(root, 'apps/server/package.json'))('better-sqlite3');
    const db = new Database(dbPath);
    try {
      db.pragma('busy_timeout = 5000');
      db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(MANAGED_BOT, 1, 1, 1, 'message', JSON.stringify({
          type: 'message',
          role: 'assistant',
          text: 'Here is the file you asked for.',
          files: [{ path: NOTE, filename: NOTE, mediaType: 'text/plain' }],
        }), Date.now());
    } finally {
      db.close();
    }
  }

  const withFile = await request('/api/files', { headers: bearer });
  checkShape('GET /api/files after an attachment lands', withFile, 200, ['files', 'total']);
  const attachment = (withFile.body?.files ?? []).find((f) => f.type === 'attachment');
  checkEqual('the attachment is listed with its name and size', {
    botId: attachment?.botId,
    botName: attachment?.botName,
    filename: attachment?.filename,
    type: attachment?.type,
    size: attachment?.size,
  }, {
    botId: MANAGED_BOT,
    botName: MANAGED_NAME,
    filename: NOTE,
    type: 'attachment',
    size: Buffer.byteLength(NOTE_TEXT),
  });
  check('the attachment carries a text media type', String(attachment?.mediaType).startsWith('text/plain'),
    String(attachment?.mediaType));
  const attachmentsOnly = await request('/api/files?type=attachment', { headers: bearer });
  checkEqual('the Attachments filter returns just that file', {
    total: attachmentsOnly.body?.total,
    types: [...new Set((attachmentsOnly.body?.files ?? []).map((f) => f.type))],
  }, { total: 1, types: ['attachment'] });
  if (attachment?.id) {
    const download = await fetch(`${base}${attachment.downloadUrl}`, { headers: bearer });
    const text = await download.text();
    check('the attachment downloads through its downloadUrl', download.status === 200 && text === NOTE_TEXT,
      `${download.status} ${short(text, 60)}`);
  } else {
    check('the attachment downloads through its downloadUrl', false, 'no attachment to download', { expected: 'a listed attachment', actual: null });
  }

  // ---------- Calendar: create a one-time event, then find it in its window ----------
  const emptyWindow = await request('/api/calendar?from=2026-01-01&to=2026-12-31', { headers: bearer });
  checkShape('GET /api/calendar', emptyWindow, 200, ['events']);
  checkEqual('a fresh calendar has no events', emptyWindow.body?.events, []);

  const EVENT_START = '2026-09-09T15:00:00.000Z';
  const created = await request('/api/routines', {
    method: 'POST',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({
      botId: MANAGED_BOT,
      title: 'Smoke one-time event',
      prompt: 'Say hello on the calendar smoke run.',
      eventType: 'one_time',
      eventDate: EVENT_START,
      timezone: 'UTC',
    }),
  });
  checkStatus('POST /api/routines', created, 201);
  const routine = created.body?.routine;
  checkEqual('the new routine is a one-time event with its date', {
    eventType: routine?.eventType,
    calendarTitle: routine?.calendarTitle,
    eventDate: routine?.eventDate,
    botId: routine?.botId,
  }, { eventType: 'one_time', calendarTitle: 'Smoke one-time event', eventDate: EVENT_START, botId: MANAGED_BOT });

  const day = await request('/api/calendar?from=2026-09-09T00:00:00.000Z&to=2026-09-10T00:00:00.000Z', { headers: bearer });
  checkStatus("GET /api/calendar for the event's day", day, 200);
  const inDay = (day.body?.events ?? []).filter((e) => e.routineId === routine?.id);
  checkEqual('the created event appears on its day, once', inDay.length, 1);
  checkEqual('the calendar entry carries the event fields', inDay[0], {
    routineId: routine?.id,
    botId: MANAGED_BOT,
    botName: MANAGED_NAME,
    title: 'Smoke one-time event',
    start: EVENT_START,
    end: '2026-09-09T15:30:00.000Z',
    recurrenceRule: null,
    eventType: 'one_time',
    completedAt: null,
  });

  const year = await request('/api/calendar?from=2026-01-01&to=2026-12-31', { headers: bearer });
  checkStatus('GET /api/calendar for the whole year', year, 200);
  checkEqual('the whole-year window shows the event too',
    (year.body?.events ?? []).filter((e) => e.routineId === routine?.id).length, 1);
  const before = await request('/api/calendar?from=2026-01-01T00:00:00.000Z&to=2026-09-09T00:00:00.000Z', { headers: bearer });
  checkEqual('a window that ends before the event does not show it',
    (before.body?.events ?? []).filter((e) => e.routineId === routine?.id).length, 0);

  // ---------- Computers ----------
  const computers = await request('/api/computers', { headers: bearer });
  checkShape('GET /api/computers', computers, 200, ['computers']);
  const compRows = Array.isArray(computers.body?.computers) ? computers.body.computers : [];
  check(
    'every computer row has a bot, a kind and a status',
    compRows.length > 0 && compRows.every((r) => typeof r.botId === 'string' && typeof r.botName === 'string' &&
      ['docker', 'orgo', 'none'].includes(r.kind) && ['awake', 'sleeping', 'starting', 'unknown'].includes(r.status)),
    short(computers.text),
  );
  const mine = compRows.find((r) => r.botId === MANAGED_BOT);
  checkEqual("the managed bot's running container reads as awake with a screen", {
    kind: mine?.kind,
    status: mine?.status,
    vncAvailable: mine?.vncAvailable,
    screenId: mine?.screenId,
  }, { kind: 'docker', status: 'awake', vncAvailable: true, screenId: 'screen-7' });

  // ---------- Skills: the primary is read-only, a managed bot can toggle one off and on ----------
  const noSkills = await request('/api/skills', { headers: bearer });
  checkShape('GET /api/skills', noSkills, 200, ['skills']);
  checkEqual('a primary home with no mcp_servers lists no skills', noSkills.body?.skills, []);
  writePrimaryConfig();

  const off = await request(`/api/skills/${MANAGED_BOT}/${SKILL}`, {
    method: 'PUT',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  checkStatus('PUT /api/skills/:managedBotId/:skillName', off, 200);
  const offBots = off.body?.skill?.bots ?? [];
  checkEqual('the skill reads off for the managed bot afterwards', {
    name: off.body?.skill?.name,
    managed: offBots.find((b) => b.botId === MANAGED_BOT)?.enabled,
    primary: offBots.find((b) => b.botId === primaryBotId)?.enabled,
  }, { name: SKILL, managed: false, primary: true });
  const offConfig = readManagedFile('config.yaml');
  check('the managed config.yaml no longer lists the skill', !offConfig.includes(SKILL), offConfig.replace(/\n/g, ' | '));
  check('the rest of the managed config.yaml is kept', offConfig.includes('hq:'), '');

  const primaryOff = await request(`/api/skills/${primaryBotId}/${SKILL}`, {
    method: 'PUT',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  checkStatus('PUT /api/skills/:primaryBotId/:skillName is refused', primaryOff, 409);

  const badBody = await request(`/api/skills/${MANAGED_BOT}/${SKILL}`, {
    method: 'PUT',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'no' }),
  });
  checkStatus('a skill toggle needs a boolean', badBody, 400);

  const on = await request(`/api/skills/${MANAGED_BOT}/${SKILL}`, {
    method: 'PUT',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  checkStatus('PUT /api/skills/:managedBotId/:skillName restores it', on, 200);
  checkEqual('the restored skill reads on', (on.body?.skill?.bots ?? []).find((b) => b.botId === MANAGED_BOT)?.enabled, true);
  check('the managed config.yaml lists the skill again', readManagedFile('config.yaml').includes(SKILL));

  const skills = await request('/api/skills', { headers: bearer });
  const listed = (skills.body?.skills ?? []).find((s) => s.name === SKILL);
  checkEqual('GET /api/skills reports the skill and who has it', {
    count: skills.body?.skills?.length,
    type: listed?.type,
    description: listed?.description,
    primaryEnabled: listed?.primaryEnabled,
    bots: listed?.bots?.map((b) => [b.botId, b.enabled]),
  }, {
    count: 1,
    type: 'http',
    description: 'smoke fixture',
    primaryEnabled: true,
    bots: [[primaryBotId, true], [MANAGED_BOT, true]],
  });

  const anon = await request('/api/bots');
  check('unauthenticated /api/bots is 401', anon.status === 401, String(anon.status));
} catch (e) {
  check('the smoke run finished without throwing', false, short(e?.stack ?? e, 1200));
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`\n${failed.length} failed: ${failed.map((r) => r.name).join('; ')}`);
  console.log('\nserver log tail:\n' + log.slice(-3000));
  process.exit(1);
}
