import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

/**
 * Acceptance run for the research-on-your-own-computer tools.
 *
 * It talks to a running Orbit server over the same HTTP surface the app uses: the MCP endpoint for
 * the tools, and /api/files for what the person sees. Every assertion is about a real artifact:
 * a tab that exists, a file on disk, a row in the Files page, a screenshot.
 *
 *   BASE=http://127.0.0.1:60825 SESSION_SECRET=... npx tsx scripts/e2e-research.ts
 *
 * SESSION_SECRET is the stack's secret (stack/.env); mcpToken derives the per-bot bearer from it.
 * The script imports env.ts, so DB_PATH is pointed at a throwaway file first: the running server's
 * database is only ever read through HTTP, never opened here.
 */

process.env.DB_PATH ??= path.join(os.tmpdir(), `orbit-e2e-research-${process.pid}.db`);
process.env.HERMES_HOME_PRIMARY ??= path.join(os.tmpdir(), 'orbit-e2e-research-home');

const BASE = (process.env.BASE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const EMAIL = process.env.EMAIL ?? 'owner@orbit.local';

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required: it is the stack .env value that signs MCP tokens.');
  process.exit(2);
}

const { mcpToken } = await import('../src/engine.js');

type Json = Record<string, any>;

let passed = 0;
const pass = (what: string) => {
  passed++;
  console.log(`  ok  ${what}`);
};
const fail = (what: string, e: unknown): never => {
  console.error(`  FAIL  ${what}\n        ${String((e as { message?: unknown } | null)?.message ?? e)}`);
  process.exitCode = 1;
  throw e;
};
const check = async (what: string, fn: () => Promise<void>) => {
  try {
    await fn();
    pass(what);
  } catch (e) {
    fail(what, e);
  }
};

/** A signed-in cookie for the person's account, via the dev sign-in the desktop stack enables. */
async function signIn(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  assert.equal(res.status, 200, `dev sign-in failed: ${JSON.stringify(body)}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^grokbot_session=/, 'dev sign-in set no session cookie');
  return cookie;
}

async function api(cookie: string, p: string): Promise<Json> {
  const res = await fetch(`${BASE}${p}`, { headers: { cookie } });
  assert.equal(res.status, 200, `GET ${p} answered ${res.status}`);
  return (await res.json()) as Json;
}

/** One JSON-RPC call to the app's MCP endpoint for a bot. */
async function rpc(botId: string, method: string, params: unknown): Promise<Json> {
  const res = await fetch(`${BASE}/mcp/${encodeURIComponent(botId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(botId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.status, 200, `MCP ${method} answered ${res.status}`);
  const body = (await res.json()) as Json;
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result as Json;
}

/** A tool call, as its text output. MCP wraps every answer in one text block per result. */
async function tool(bot: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await rpc(bot, 'tools/call', { name, arguments: args });
  assert.ok(Array.isArray(r.content), `tools/call ${name} returned no content`);
  const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
}

/** Parse a tool's JSON answer, with the tool's own text as the failure message when it is not JSON. */
function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what} did not answer JSON: ${text.slice(0, 400)}`);
  }
}

const hqFiles = (text: string) => [...text.matchAll(/\[hq-file:([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/g)].map((m) => ({ path: m[1], name: m[2], mime: m[3] }));

console.log(`Orbit research e2e → ${BASE}`);

const cookie = await signIn();
const { bots } = (await api(cookie, '/api/bots')) as { bots: Json[] };
const computers = ((await api(cookie, '/api/computers')) as { computers: Json[] }).computers;
const withComputer = new Set(computers.filter((c) => c.kind === 'docker').map((c) => c.botId));
const agent = bots.find((b) => b.kind !== 'room' && withComputer.has(b.id) && !b.isPrimary)
  ?? bots.find((b) => b.kind !== 'room' && withComputer.has(b.id));
assert.ok(agent, 'no Bot with a Docker computer is on this server');

const botId = String(agent.id);
const botName = String(agent.name);
console.log(`Bot: ${botName} (${botId}), primary=${Boolean(agent.isPrimary)}`);

await check('tools/list carries the research and team tools', async () => {
  const { tools } = await rpc(botId, 'tools/list', {});
  const names = new Set((tools as { name: string }[]).map((t) => t.name));
  for (const n of ['computer_web_search', 'computer_image_search', 'computer_video_search', 'computer_browser', 'computer_read_page', 'computer_screenshot', 'list_bots']) {
    assert.ok(names.has(n), `${n} is missing from tools/list`);
  }
});

await check('computer_browser lists tabs, then opens a new one', async () => {
  const before = parseJson<{ tabs: Json[] }>(await tool(botId, 'computer_browser', { action: 'list' }), 'computer_browser list');
  assert.ok(Array.isArray(before.tabs), 'no tabs array');
  const opened = parseJson<{ opened: { id: string; url: string } }>(await tool(botId, 'computer_browser', { action: 'open', url: 'https://example.com/' }), 'computer_browser open');
  assert.ok(opened.opened?.id, 'opening a tab returned no id');
  const after = parseJson<{ tabs: Json[] }>(await tool(botId, 'computer_browser', { action: 'list' }), 'computer_browser list');
  assert.ok(after.tabs.some((t) => t.id === opened.opened.id), 'the new tab is not in the list');
  assert.ok(after.tabs.length >= before.tabs.length + 1, `tab count did not grow (${before.tabs.length} → ${after.tabs.length})`);
});

await check('computer_web_search returns results from a real results page', async () => {
  const text = await tool(botId, 'computer_web_search', { query: 'Nous Research Hermes agent', limit: 5 });
  const body = parseJson<{ engine: string; results: { title: string; url: string }[]; tab: { id: string } }>(text, 'computer_web_search');
  assert.ok(body.results.length >= 1, `no results: ${text.slice(0, 300)}`);
  assert.ok(body.results.every((r) => /^https?:/.test(r.url)), 'a result had no http url');
  assert.match(body.engine, /google|duckduckgo|bing/);
  console.log(`        engine=${body.engine} results=${body.results.length} first=${body.results[0]?.title.slice(0, 60)}`);
});

await check('computer_image_search saves Google Images into the Library', async () => {
  const text = await tool(botId, 'computer_image_search', { query: 'red panda', count: 2 });
  const files = hqFiles(text);
  assert.ok(files.length >= 1, `no files marked in: ${text.slice(0, 500)}`);
  for (const f of files) assert.match(f.path, /^images\//, 'an image was not saved under images/');
  const listed = (await api(cookie, `/api/files?botId=${encodeURIComponent(botId)}&type=library&pageSize=200`)) as { files: Json[] };
  for (const f of files) {
    const entry = listed.files.find((x) => x.path === f.path);
    assert.ok(entry, `${f.path} is not in the Files page listing`);
    assert.ok(Number(entry.size) > 1024, `${f.path} is only ${entry.size} bytes`);
    assert.match(String(entry.mediaType), /^image\//);
    const raw = await fetch(`${BASE}${entry.downloadUrl}`, { headers: { cookie } });
    assert.equal(raw.status, 200, `${f.path} did not download`);
    assert.match(raw.headers.get('content-type') ?? '', /^image\//);
  }
  console.log(`        saved=${files.map((f) => f.name).join(', ')}`);
});

await check('computer_screenshot lands in the Library as a PNG', async () => {
  const text = await tool(botId, 'computer_screenshot');
  const [shot] = hqFiles(text);
  assert.ok(shot, `no screenshot marker in: ${text.slice(0, 300)}`);
  assert.match(shot.path, /^screenshots\/.*\.png$/);
  const listed = (await api(cookie, `/api/files?botId=${encodeURIComponent(botId)}&type=library&pageSize=200`)) as { files: Json[] };
  assert.ok(listed.files.some((f) => f.path === shot.path), 'the screenshot is not in the Files page listing');
});

await check('computer_video_search reads a real YouTube results page', async () => {
  const text = await tool(botId, 'computer_video_search', { query: 'open source LLM', limit: 3 });
  const body = parseJson<{ videos: { title: string; url: string }[] }>(text, 'computer_video_search');
  assert.ok(body.videos.length >= 1, `no videos: ${text.slice(0, 300)}`);
  assert.ok(body.videos.every((v) => /^https?:/.test(v.url)));
  console.log(`        videos=${body.videos.length} first=${body.videos[0]?.title.slice(0, 60)}`);
});

await check('computer_read_page reads the tab it opened', async () => {
  const text = await tool(botId, 'computer_read_page', { url: 'https://example.com/', max_chars: 500 });
  assert.match(text, /Example Domain/i);
});

await check('only a primary Bot can change the team', async () => {
  if (agent.isPrimary) {
    console.log('        (this Bot is primary; the refusal gate needs a non-primary caller)');
    return;
  }
  const text = await tool(botId, 'create_bot', { name: 'Should Not Exist' });
  assert.match(text, /Only a primary Bot/i);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' with failures above' : ''}`);
