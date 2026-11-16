// api-env must be the FIRST import: it isolates env.ts, the DB and the Hermes homes.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';
import YAML from 'yaml';

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A stand-in primary Hermes: mid-turn it reports an unrelated status, then a compaction, then answers. */
const hermes = http.createServer((req, res) => {
  req.resume();
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse('hermes.status', { kind: 'lifecycle', text: 'Waiting for the provider' }));
  res.write(sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Working on it.' }));
  res.write(sse('hermes.status', { kind: 'compacted', text: 'Context compaction complete, continuing turn...' }));
  res.write(sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Done.' }));
  res.end(sse('response.completed', { type: 'response.completed' }));
});
await new Promise<void>((resolve) => hermes.listen(0, '127.0.0.1', resolve));
process.env.HERMES_URL = `http://127.0.0.1:${(hermes.address() as AddressInfo).port}`;
process.env.CONTEXT_COMPACTION_THRESHOLD = '200000';

const { enqueue, runInBotQueue } = await import('../agent/loop.js');
const { engineFor, managedHome } = await import('../engine.js');
const { db } = await import('../db.js');
await import('../db-config.js'); // bot_computers, which a turn and a gateway start both read
// The bots columns index.ts adds at boot (hidden, kind), which the turn's instructions read.
(await import('../agent/subagents.js')).initSubagents();
(await import('../agent/rooms.js')).initRooms();

const USER = 'usr_compaction';
const NOW = 1_700_000_000_000;
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'compaction@test.local', 'Compaction Test', NOW);

function addBot(id: string, engine: 'primary' | 'managed', port: number | null = null) {
  db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, USER, id, engine, port, engine === 'primary' ? 1 : 0, NOW, NOW);
  return id;
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

after(() => {
  hermes.close();
  cleanupTmpEnv();
});

test('a compaction reported mid-turn shows in the conversation as a context-compacted notice', async () => {
  const bot = addBot('bot_compacting', 'primary');

  enqueue(bot, { type: 'user', text: 'Keep going with the report.' });
  await runInBotQueue(bot, async () => {});

  const rows = (db.prepare('SELECT kind, body FROM rows WHERE bot_id=? ORDER BY seq').all(bot) as { kind: string; body: string }[])
    .map((r) => ({ kind: r.kind, body: JSON.parse(r.body) }));
  assert.deepEqual(
    rows.map((r) => (r.kind === 'message' ? `message:${r.body.text}` : r.kind)),
    ['message:Working on it.', 'notice', 'message:Done.'],
    'the notice sits where the compaction happened, and an unrelated status adds nothing',
  );
  assert.deepEqual(rows[1].body, { type: 'notice', kind: 'context-compacted', text: 'Conversation summarized to save context.', tone: 'info' });
});

test('starting a managed bot sets its compaction threshold and keeps its own compression settings', async () => {
  const bot = addBot('bot_budget', 'managed', await closedPort());
  const cfgFile = path.join(managedHome(bot), 'config.yaml');
  fs.mkdirSync(managedHome(bot), { recursive: true });
  fs.writeFileSync(cfgFile, YAML.stringify({ compression: { threshold: 0.6, threshold_tokens: 900_000 } }));

  // HERMES_BIN is /usr/bin/true: the home is written, then the "gateway" exits at once.
  await assert.rejects(engineFor(bot));

  assert.deepEqual(YAML.parse(fs.readFileSync(cfgFile, 'utf8')).compression, { threshold: 0.6, threshold_tokens: 200_000 });
});
