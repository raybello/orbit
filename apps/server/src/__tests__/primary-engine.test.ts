// api-env must be the FIRST import: it isolates env.ts, the DB and the Hermes homes, and makes
// HERMES_BIN `true` so a gateway start writes the home and then fails at once.
import { cleanupTmpEnv } from './helpers/api-env.js';
import { enginesDir, primaryHome } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';

const { assignEngine, engineFor, engineRecord, mcpToken } = await import('../engine.js');
const { readDotenv, readYaml } = await import('../hermes-files.js');
const { env } = await import('../env.js');
const { db } = await import('../db.js');
await import('../db-config.js');

const USER = 'usr_primary_engine';
const NOW = 1_700_000_000_000;
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'primary@test.local', 'Primary Test', NOW);

function addAgent(id: string): string {
  db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,NULL,NULL,?,?,?)')
    .run(id, USER, id, id === 'bot_atlas' ? 1 : 0, NOW, NOW);
  return id;
}

/** A gateway already running on a port: it answers health and accepts only `key`. */
function fakeGateway(key: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    if (req.url === '/v1/models' && req.headers.authorization === `Bearer ${key}`) return void res.writeHead(200).end('{}');
    res.writeHead(401).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

after(() => cleanupTmpEnv());

test('the first agent becomes the primary engine: its own home, a well-known port and /mcp/primary', () => {
  const primary = addAgent('bot_atlas');
  const managed = addAgent('bot_nova');
  assert.equal(assignEngine(primary), 'primary');
  assert.equal(assignEngine(managed), 'managed');

  const p = engineRecord(primary)!;
  assert.equal(p.home, primaryHome);
  assert.equal(p.home, path.join(enginesDir, 'primary'), 'stable across bot ids');
  assert.equal(p.port, env.primaryEnginePort);
  assert.deepEqual(p.hq, { url: `http://127.0.0.1:${env.port}/mcp/primary`, token: mcpToken('primary') });

  const m = engineRecord(managed)!;
  assert.equal(m.home, path.join(enginesDir, managed));
  assert.notEqual(m.port, p.port);
  assert.deepEqual(m.hq, { url: `http://127.0.0.1:${env.port}/mcp/${managed}`, token: mcpToken(managed) });
});

test('starting the primary writes its home: hq on /mcp/primary, its own API key, its imported persona kept', async () => {
  fs.mkdirSync(primaryHome, { recursive: true });
  fs.writeFileSync(path.join(primaryHome, 'SOUL.md'), 'I am the imported persona.\n');
  fs.writeFileSync(path.join(primaryHome, '.env'), 'DEEPSEEK_API_KEY=sk-own\nTELEGRAM_BOT_TOKEN=keep-me\n');

  // `true` exits at once, so the start fails after the home is written.
  await assert.rejects(engineFor('bot_atlas'));

  const hq = (readYaml(path.join(primaryHome, 'config.yaml')).mcp_servers as Record<string, any>).hq;
  assert.equal(hq.url, `http://127.0.0.1:${env.port}/mcp/primary`);
  assert.equal(hq.headers.Authorization, `Bearer ${mcpToken('primary')}`);

  const vars = readDotenv(path.join(primaryHome, '.env'));
  assert.match(vars.API_SERVER_KEY, /^[0-9a-f]{48}$/);
  assert.equal(vars.API_SERVER_PORT, String(engineRecord('bot_atlas')!.port));
  assert.equal(vars.API_SERVER_HOST, '127.0.0.1');
  assert.equal(vars.DEEPSEEK_API_KEY, 'sk-own', 'the primary keeps its own model key');
  assert.equal(vars.TELEGRAM_BOT_TOKEN, 'keep-me', 'keys the person added by hand stay');
  assert.equal(fs.readFileSync(path.join(primaryHome, 'SOUL.md'), 'utf8'), 'I am the imported persona.\n');
});

test('a primary gateway already running is adopted with the key from its home', async () => {
  const key = readDotenv(path.join(primaryHome, '.env')).API_SERVER_KEY;
  const gateway = await fakeGateway(key);
  try {
    const port = (gateway.address() as AddressInfo).port;
    db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(port, 'bot_atlas');
    const engine = await engineFor('bot_atlas');
    assert.deepEqual(engine, { kind: 'primary', url: `http://127.0.0.1:${port}`, key, home: primaryHome });
  } finally {
    gateway.close();
  }
});
