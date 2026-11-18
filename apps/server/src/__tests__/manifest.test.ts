// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.COMPOSIO_API_KEY = '';
// A fixed Library path, so the golden files are the same on every machine.
process.env.BOT_DATA_DIR = '/srv/orbit';

const { db, now } = await import('../db.js');
// The bots table gets `kind`, `members` and `hidden` from these (as the server does at start).
const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();
const { composioIO } = await import('../composio.js');
const { instructionsFor } = await import('../agent/prompt.js');
const { appSheets, MCP_INSTRUCTIONS, SHEET_EXAMPLES } = await import('../agent/app-sheets.js');
const { toolMap } = await import('../agent/tools.js');

after(() => cleanupTmpEnv());

/**
 * The bot instructions (capability manifest) for three set-ups, kept as golden files so a change to
 * them is a reviewed change. Everything they teach must be real: each Composio action and argument
 * exists in the captured schemas, and each app tool exists. They must also stay byte-identical
 * between turns (the prompt cache) and within budget.
 *
 * To accept an intended change: UPDATE_GOLDEN=1 npx tsx --test src/__tests__/manifest.test.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures/composio/schemas');
const GOLDEN = path.join(HERE, 'fixtures/manifest');
const summary = JSON.parse(fs.readFileSync(path.join(FIX, '_summary.json'), 'utf8')) as Record<string, { params: string[] }>;
const toolkitSlugs = JSON.parse(fs.readFileSync(path.join(FIX, '_toolkit-slugs.json'), 'utf8')) as Record<string, string[]>;
const allSlugs = new Set(Object.values(toolkitSlugs).flat());

const USER = 'u_manifest';
db.prepare('INSERT OR IGNORE INTO users(id,name,email,created_at,timezone) VALUES (?,?,?,?,?)').run(USER, 'Ada', 'ada@example.test', now(), 'America/Toronto');
db.prepare("INSERT OR IGNORE INTO bots(id,user_id,name,label,is_primary,engine,created_at,updated_at) VALUES ('bot_m1',?,?,?,1,'managed',?,?)").run(USER, 'Atlas', 'Chief of Staff', now(), now());
db.prepare("INSERT OR IGNORE INTO bots(id,user_id,name,label,is_primary,engine,created_at,updated_at) VALUES ('bot_m2',?,?,?,0,'managed',?,?)").run(USER, 'Scout', 'Research', now(), now());

const withApps = async (apps: string[]) => {
  composioIO.connected = async () => new Set(apps);
  return instructionsFor(USER, 'bot_m1');
};

const SETUPS: [name: string, apps: string[]][] = [
  ['no-apps', []],
  ['gmail-only', ['gmail']],
  ['all-google', ['gmail', 'googlecalendar', 'googlesheets', 'googledocs', 'slack']],
];

for (const [name, apps] of SETUPS) {
  test(`the manifest for ${name} matches its golden file`, async () => {
    const text = await withApps(apps);
    const file = path.join(GOLDEN, `${name}.txt`);
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(GOLDEN, { recursive: true });
      fs.writeFileSync(file, text);
    }
    assert.equal(text, fs.readFileSync(file, 'utf8'), `${name} changed; rerun with UPDATE_GOLDEN=1 if intended`);
  });
}

test('core capabilities are stated, numbered, for every bot', async () => {
  const text = await withApps([]);
  for (const line of ['1. Talk with Ada.', '2. Work with the team.', '3. Use your own computer.', "4. Use Ada's connected apps through Composio", '5. Keep time.', '6. Deliver files.', '7. Track work.']) {
    assert.ok(text.includes(line), line);
  }
  assert.match(text, /Ada's timezone: America\/Toronto\./);
  assert.match(text, /## Approvals/);
});

test('only connected Google apps get a sheet', async () => {
  assert.equal((await withApps([])).includes('## Connected Google apps'), false);
  const gmail = await withApps(['gmail']);
  assert.ok(gmail.includes('### Gmail'));
  assert.equal(gmail.includes('### Google Calendar'), false);
});

test('every app tool the manifest names exists', async () => {
  const text = await withApps(['gmail', 'googlecalendar', 'googlesheets', 'googledocs']) + MCP_INSTRUCTIONS;
  const named = new Set([...text.matchAll(/\b(computer_[a-z_]+|vault_lookup|request_credentials|calendar_list|create_routine|create_event_routine|list_routines|update_routine|delete_routine|save_file|show_file|create_task|update_task|ask_user|stay_silent|list_bots|send_to_bot|post_to_group|create_group|create_bot|update_bot|delete_bot|set_primary_bot|set_checkins|request_app_connection|x_search)\b/g)].map((m) => m[1]));
  const missing = [...named].filter((n) => !toolMap.has(n));
  assert.deepEqual(missing, []);
  assert.ok(named.size >= 25, `the manifest names ${named.size} app tools`);
});

test('every Composio action the manifest names exists, and every argument it teaches is in the schema', async () => {
  const text = appSheets(['gmail', 'googlecalendar', 'googlesheets', 'googledocs'], 'Ada') + MCP_INSTRUCTIONS;
  const slugs = new Set([...text.matchAll(/\b((?:GMAIL|GOOGLECALENDAR|GOOGLESHEETS|GOOGLEDOCS)_[A-Z0-9_]+)\b/g)].map((m) => m[1]));
  assert.deepEqual([...slugs].filter((s) => !allSlugs.has(s)), []);
  const wrong: string[] = [];
  for (const [slug, args] of SHEET_EXAMPLES) {
    assert.ok(summary[slug], `${slug} has no captured schema`);
    for (const a of args) if (!summary[slug].params.includes(a)) wrong.push(`${slug}.${a}`);
  }
  assert.deepEqual(wrong, []);
  // The batch call's own shape, from the router's meta-tool schema.
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, '_meta-tools.json'), 'utf8')) as { name?: string; function?: { name?: string; parameters?: unknown }; parameters?: unknown }[];
  const multi = meta.find((t) => (t.name ?? t.function?.name) === 'COMPOSIO_MULTI_EXECUTE_TOOL')!;
  const item = ((multi.parameters ?? multi.function?.parameters) as { properties: { tools: { items: { properties: Record<string, unknown> } } } }).properties.tools.items.properties;
  assert.ok('tool_slug' in item && 'arguments' in item, 'the manifest teaches tool_slug + arguments');
});

test('the manifest is identical between turns and within budget', async () => {
  const a = await withApps(['gmail', 'googlecalendar', 'googlesheets', 'googledocs']);
  const b = await withApps(['googledocs', 'googlesheets', 'gmail', 'googlecalendar']);
  assert.equal(a, b, 'the order apps come back in does not matter');
  // About 4 characters per token: under 6k tokens with every Google app connected.
  assert.ok(a.length < 24_000, `the manifest is ${a.length} characters`);
});

test('the MCP server gives every Hermes session the short version', () => {
  assert.match(MCP_INSTRUCTIONS, /"tool_slug": "\.\.\.", "arguments"/);
  assert.match(MCP_INSTRUCTIONS, /GMAIL_CREATE_EMAIL_DRAFT/);
  assert.match(MCP_INSTRUCTIONS, /never UPDATE_EVENT/);
  assert.match(MCP_INSTRUCTIONS, /tool_search/);
  assert.ok(MCP_INSTRUCTIONS.split('\n').length <= 15);
});
