import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { cleanupTmpEnv, enginesDir, primaryHome, tmpRoot } from './helpers/tmp-env.js';

// tmp-env.js has already redirected DB_PATH / ENGINES_DIR / HERMES_HOME_PRIMARY at a temp dir, so
// these modules see a private database and home. Loaded dynamically so nothing reads env too early.
const { env } = await import('../env.js');
const { db } = await import('../db.js');
const { getSkillEntries, mcpServerType, readMcpServers, setMcpServerEnabled } = await import('../skills-config.js');
const { skillsApi } = await import('../routes-skills.js');

// What the primary agent's Hermes config holds: two real skills plus the app's own hq connection.
const PRIMARY_SERVERS = {
  github: {
    url: 'https://mcp.github.example/sse',
    headers: { Authorization: 'Bearer test-token' },
    description: 'Search repos, issues and pull requests',
  },
  'local-tools': { command: 'npx', args: ['-y', 'local-tools-mcp'] },
  hq: { url: 'http://127.0.0.1:8787/mcp/bot_primary', headers: { Authorization: 'Bearer hq-token' }, timeout: 1800 },
};

const USER = 'usr_skills_test';
const PRIMARY = 'bot_primary';
const RESEARCHER = 'bot_researcher';
const WRITER = 'bot_writer';

const managedConfigPath = (botId: string) => path.join(enginesDir, botId, 'config.yaml');
const primaryConfigPath = path.join(primaryHome, 'config.yaml');

function writeYamlFile(file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(value));
}

function seed() {
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(USER, 'skills@test.local', 'Skills Tester', Date.now());
  const bot = (id: string, name: string, engine: string, isPrimary: number, createdAt: number) =>
    db
      .prepare('INSERT OR REPLACE INTO bots(id,user_id,name,engine,is_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, USER, name, engine, isPrimary, createdAt, createdAt);
  bot(PRIMARY, 'Doug', 'primary', 1, 1);
  bot(RESEARCHER, 'Researcher', 'managed', 0, 2);
  bot(WRITER, 'Writer', 'managed', 0, 3);

  writeYamlFile(primaryConfigPath, { model: { name: 'deepseek-flash' }, mcp_servers: PRIMARY_SERVERS });

  writeYamlFile(managedConfigPath(RESEARCHER), {
    model: { name: 'deepseek-flash' },
    agent: { reasoning_effort: 'medium' },
    terminal: { cwd: path.join(tmpRoot, 'files', RESEARCHER) },
    platform_toolsets: { api_server: ['hermes-api-server'] },
    mcp_servers: { github: PRIMARY_SERVERS.github, 'local-tools': PRIMARY_SERVERS['local-tools'], hq: PRIMARY_SERVERS.hq },
  });

  // This bot never inherited local-tools: inheritance is a snapshot, not a mirror.
  writeYamlFile(managedConfigPath(WRITER), {
    model: { name: 'deepseek-flash' },
    mcp_servers: { github: PRIMARY_SERVERS.github, hq: PRIMARY_SERVERS.hq },
  });
}

seed();
test.after(() => cleanupTmpEnv());

test('the temp home is the one env.ts sees', () => {
  assert.equal(env.hermesHome, primaryHome);
  assert.equal(env.enginesDir, enginesDir);
  assert.ok(env.dbPath.startsWith(tmpRoot), 'the database must live in the temp dir');
});

test('readMcpServers and mcpServerType read a Hermes config the way Hermes writes it', () => {
  assert.deepEqual(Object.keys(readMcpServers(primaryConfigPath)), ['github', 'local-tools', 'hq']);
  assert.deepEqual(readMcpServers(path.join(tmpRoot, 'nope.yaml')), {}, 'a missing config has no servers');

  writeYamlFile(path.join(tmpRoot, 'empty.yaml'), { model: { name: 'x' } });
  assert.deepEqual(readMcpServers(path.join(tmpRoot, 'empty.yaml')), {}, 'no mcp_servers key means none');

  assert.equal(mcpServerType({ url: 'https://example.test/mcp' }), 'http');
  assert.equal(mcpServerType({ command: 'npx', args: ['x'] }), 'stdio');
  assert.equal(mcpServerType({}), 'unknown');
  assert.equal(mcpServerType(null), 'unknown');
});

test('getSkillEntries reports every primary skill with per-bot enabled flags', () => {
  const skills = getSkillEntries(USER);
  assert.deepEqual(skills.map((s) => s.name), ['github', 'local-tools'], 'primary order, and only primary servers');

  const github = skills[0];
  assert.equal(github.type, 'http');
  assert.equal(github.url, 'https://mcp.github.example/sse');
  assert.equal(github.description, 'Search repos, issues and pull requests');
  assert.equal(github.primaryEnabled, true);
  assert.deepEqual(github.bots, [
    { botId: PRIMARY, botName: 'Doug', enabled: true },
    { botId: RESEARCHER, botName: 'Researcher', enabled: true },
    { botId: WRITER, botName: 'Writer', enabled: true },
  ]);

  const local = skills[1];
  assert.equal(local.type, 'stdio');
  assert.equal(local.url, null);
  assert.equal(local.description, null);
  assert.equal(local.primaryEnabled, true);
  assert.deepEqual(local.bots, [
    { botId: PRIMARY, botName: 'Doug', enabled: true },
    { botId: RESEARCHER, botName: 'Researcher', enabled: true },
    { botId: WRITER, botName: 'Writer', enabled: false },
  ]);
});

test("the app's own hq server is never reported and cannot be toggled", () => {
  assert.equal(getSkillEntries(USER).some((s) => s.name === 'hq'), false);
  assert.throws(() => setMcpServerEnabled(RESEARCHER, 'hq', false), /cannot be changed/);
});

test('disabling a skill deletes just that entry and keeps every other key', () => {
  const before = YAML.parse(fs.readFileSync(managedConfigPath(RESEARCHER), 'utf8'));
  setMcpServerEnabled(RESEARCHER, 'github', false);

  const after = YAML.parse(fs.readFileSync(managedConfigPath(RESEARCHER), 'utf8'));
  assert.deepEqual(Object.keys(after.mcp_servers), ['local-tools', 'hq'], 'github is gone, hq stays');
  const { mcp_servers: _a, ...restAfter } = after;
  const { mcp_servers: _b, ...restBefore } = before;
  assert.deepEqual(restAfter, restBefore, 'model, agent, terminal and toolsets are untouched');

  const skills = getSkillEntries(USER);
  assert.equal(skills[0].bots.find((b) => b.botId === RESEARCHER)?.enabled, false);
  assert.equal(skills[0].bots.find((b) => b.botId === PRIMARY)?.enabled, true, 'the primary stays on');
  assert.equal(skills[0].bots.find((b) => b.botId === WRITER)?.enabled, true);
  assert.equal(fs.statSync(managedConfigPath(RESEARCHER)).mode & 0o777, 0o600, 'config stays private');
});

test('re-enabling restores the entry from the primary config', () => {
  setMcpServerEnabled(RESEARCHER, 'github', true);

  const servers = readMcpServers(managedConfigPath(RESEARCHER));
  assert.deepEqual(servers.github, PRIMARY_SERVERS.github, 'restored verbatim from the primary, headers and all');
  assert.deepEqual(Object.keys(servers).sort(), ['github', 'hq', 'local-tools']);

  const github = getSkillEntries(USER)[0];
  assert.equal(github.bots.find((b) => b.botId === RESEARCHER)?.enabled, true);
  assert.equal(github.bots.find((b) => b.botId === WRITER)?.enabled, true);
});

test('enabling a skill the primary agent does not define throws and changes nothing', () => {
  const file = managedConfigPath(WRITER);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => setMcpServerEnabled(WRITER, 'not-a-skill', true), /does not define a skill named "not-a-skill"/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is left exactly as it was');
});

test('the primary bot is read-only in both directions', () => {
  const file = primaryConfigPath;
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => setMcpServerEnabled(PRIMARY, 'github', false), /read-only/);
  assert.throws(() => setMcpServerEnabled(PRIMARY, 'local-tools', true), /read-only/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, "the primary agent's config is never written");
});

// ---------- the HTTP surface the Skills view talks to ----------

const TOKEN = 'test-skills-session';
db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(
  TOKEN,
  USER,
  Date.now(),
  Date.now() + 3600_000,
);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = (_body?: unknown) => ({ ...auth, 'content-type': 'application/json' });

test('GET /skills answers { skills } for the signed-in user', async () => {
  const res = await skillsApi.request('/skills', { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.skills.map((s: any) => s.name), ['github', 'local-tools']);
  assert.equal(body.skills[0].primaryEnabled, true);
  assert.equal(body.skills[0].bots.length, 3);
});

test('GET /skills needs a session', async () => {
  const res = await skillsApi.request('/skills');
  assert.equal(res.status, 401);
});

test('PUT /skills/:botId/:skillName toggles the bot and returns the updated skill', async () => {
  const off = await skillsApi.request(`/skills/${WRITER}/github`, {
    method: 'PUT',
    headers: json({ enabled: false }),
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(off.status, 200);
  const { skill } = await off.json();
  assert.equal(skill.name, 'github');
  assert.equal(skill.bots.find((b: any) => b.botId === WRITER).enabled, false);
  assert.equal(readMcpServers(managedConfigPath(WRITER)).github, undefined);

  const on = await skillsApi.request(`/skills/${WRITER}/github`, {
    method: 'PUT',
    headers: json({ enabled: true }),
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).skill.bots.find((b: any) => b.botId === WRITER).enabled, true);
});

test('PUT /skills answers 404, 400 and 409 for the things the UI can get wrong', async () => {
  const body = JSON.stringify({ enabled: false });

  const missing = await skillsApi.request(`/skills/bot_someone_else/github`, { method: 'PUT', headers: json({ enabled: false }), body });
  assert.equal(missing.status, 404, "another user's bot is not found");

  const badBody = await skillsApi.request(`/skills/${WRITER}/github`, { method: 'PUT', headers: json({ enabled: 'yes' }), body: JSON.stringify({ enabled: 'yes' }) });
  assert.equal(badBody.status, 400);

  const primary = await skillsApi.request(`/skills/${PRIMARY}/github`, { method: 'PUT', headers: json({ enabled: false }), body });
  assert.equal(primary.status, 409);
  assert.match((await primary.json()).error, /read-only/);
});
