#!/usr/bin/env node
/**
 * End-to-end smoke test for the Orbit server's API surface.
 *
 * Starts the built server (apps/server/dist/index.js) against a throwaway SQLite file,
 * exercises the endpoints the desktop and mobile clients depend on, then shuts it down.
 * No dependencies: plain node:http fetch + child_process.
 *
 *   node scripts/smoke-server.mjs            # builds nothing; expects `pnpm build` first
 *   PORT=8899 node scripts/smoke-server.mjs  # different port
 *
 * Exit code is 0 only when every check passes.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

if (!fs.existsSync(entry)) {
  console.error(`missing ${entry} — run \`pnpm build\` first`);
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(pathname, init = {}) {
  const res = await fetch(base + pathname, { ...init, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
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

  const anon = await request('/api/bots');
  check('unauthenticated /api/bots is 401', anon.status === 401, String(anon.status));
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('server log tail:\n' + log.slice(-1500));
  process.exit(1);
}
