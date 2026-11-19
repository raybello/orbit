// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

process.env.COMPOSIO_API_KEY = '';

const { db } = await import('../db.js');
const { mcpApi } = await import('../mcp.js');
const { mcpToken } = await import('../engine.js');
after(cleanupTmpEnv);

const USER = 'usr_mcpprimary';
const NOW = Date.now();

function primaryIs(id: string) {
  db.prepare('DELETE FROM bots').run();
  db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'mcp@test.local', 'MCP Test', NOW);
  db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, USER, id, 'primary', null, 1, NOW, NOW);
}

const listTools = (slug: string, token: string) => mcpApi.request(`/${slug}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});

test('/mcp/primary keeps working with the same token when the primary bot is replaced', async () => {
  primaryIs('bot_first');
  const first = await listTools('primary', mcpToken('primary'));
  assert.equal(first.status, 200);
  const names = ((await first.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(names.includes('send_to_bot') && names.includes('list_bots'), 'the team tools are served');

  primaryIs('bot_second');
  assert.equal((await listTools('primary', mcpToken('primary'))).status, 200, 'a reset database needs no new token');
  assert.equal((await listTools('bot_first', mcpToken('bot_first'))).status, 401, 'a bot-id URL dies with its bot');
});

test('/mcp/primary refuses any other token', async () => {
  primaryIs('bot_third');
  assert.equal((await listTools('primary', mcpToken('bot_third'))).status, 401);
  assert.equal((await listTools('primary', 'nope')).status, 401);
});
