// tmp-env must be the FIRST import: it points env.ts at a temp DB and Hermes homes.
import { cleanupTmpEnv, primaryHome } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.XAI_BASE_URL = 'https://us.api.x.ai/v1/';
process.env.XAI_API_KEY = 'xai-test-key';

const { toolMap } = await import('../agent/tools/index.js');
const { managedHome, syncManagedAuth } = await import('../engine.js');
const { readDotenv } = await import('../hermes-files.js');
const { db } = await import('../db.js');

const USER = 'usr_xaiwiring';
const NOW = 1_700_000_000_000;

after(() => cleanupTmpEnv());

test('x_search calls the configured xAI region with a hashed safety identifier', async () => {
  const realFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'found it' }] }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await toolMap.get('x_search')!.impl({ query: 'what is new' }, { userId: USER, botId: 'bot_x', depth: 0, enqueueBotMessage: () => {} });
    assert.equal(result.output, 'found it');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://us.api.x.ai/v1/responses', 'the trailing slash is dropped and the region is honored');
  assert.equal(calls[0].body.safety_identifier, createHash('sha256').update(USER).digest('hex'));
  assert.ok(!JSON.stringify(calls[0].body).includes(USER), 'the raw user id never leaves the server');
  assert.equal(calls[0].body.store, false);
});

test('a managed bot inherits XAI_BASE_URL so its Hermes model calls use the same region', () => {
  db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'xai@test.local', 'xAI Test', NOW);
  db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('bot_region', USER, 'Region', 'managed', 8701, 0, NOW, NOW);
  fs.writeFileSync(path.join(primaryHome, '.env'), 'XAI_API_KEY=xai-primary\n');
  fs.writeFileSync(path.join(primaryHome, 'config.yaml'), '{}\n');
  fs.mkdirSync(managedHome('bot_region'), { recursive: true });
  fs.writeFileSync(path.join(managedHome('bot_region'), '.env'), 'API_SERVER_KEY=k\n');

  const synced = syncManagedAuth('bot_region');

  const vars = readDotenv(path.join(managedHome('bot_region'), '.env'));
  assert.equal(vars.XAI_BASE_URL, 'https://us.api.x.ai/v1/');
  assert.ok(synced.includes('XAI_BASE_URL'));
});
