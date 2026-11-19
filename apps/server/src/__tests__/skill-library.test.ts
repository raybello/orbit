// api-env must be the FIRST import: it points env.ts at a temp database before env.ts reads process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

process.env.COMPOSIO_API_KEY = '';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { mcpToken } = await import('../engine.js');
const { expandForBot } = await import('../core/skill-library.js');
const { githubIO } = await import('../core/github-skills.js');
const { migrateBotSkills } = await import('../db-config.js');
const { instructionsFor } = await import('../agent/prompt.js');

const app = createApp();
after(() => cleanupTmpEnv());

/**
 * The shared skill library end to end: skills written in the app, by a Bot and from GitHub; which
 * Bots have each one; `/<name>` in a turn; and the person's library staying their own.
 */

type Json = Record<string, any>;

async function signIn(email: string) {
  const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const bots = ((await (await app.request('/api/bots', { headers: { cookie } })).json()) as Json).bots as Json[];
  const userId = (db.prepare('SELECT user_id FROM bots WHERE id=?').get(bots[0].id) as { user_id: string }).user_id;
  return { cookie, botId: String(bots[0].id), userId };
}

const addBot = (userId: string, id: string, name = id) => {
  const t = Date.now();
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, userId, name, 'managed', t, t);
  return id;
};

const send = async (method: string, path: string, body: unknown, cookie: string) => {
  const r = await app.request(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Json };
};

async function tool(botId: string, name: string, args: Json): Promise<string> {
  const r = await app.request(`/mcp/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(botId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await r.json()) as Json).result.content.map((c: { text: string }) => c.text).join('');
}

/** A fake GitHub: a repo is a map of path → file text at one commit. */
const SHA = 'a'.repeat(40);
let repos: Record<string, { branch: string; files: Record<string, string> }> = {};
let rateLimited = false;
githubIO.json = async (path) => {
  if (rateLimited) return { status: 403, body: { message: 'API rate limit exceeded' } };
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path.split('?')[0])!;
  const repo = repos[`${m[1]}/${m[2]}`];
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const rest = m[3] ?? '';
  if (!rest) return { status: 200, body: { default_branch: repo.branch } };
  const commit = /^\/commits\/(.+)$/.exec(rest);
  if (commit) return decodeURIComponent(commit[1]) === repo.branch || commit[1] === SHA ? { status: 200, body: { sha: SHA } } : { status: 422, body: { message: 'No commit found' } };
  if (rest === `/git/trees/${SHA}`) return { status: 200, body: { tree: Object.entries(repo.files).map(([p, t]) => ({ path: p, type: 'blob', size: Buffer.byteLength(t) })) } };
  return { status: 404, body: {} };
};
githubIO.raw = async (owner, name, commit, path) => {
  const t = commit === SHA ? repos[`${owner}/${name}`]?.files[path] : undefined;
  return t === undefined ? null : Buffer.from(t);
};

const A = await signIn('lib-a@test.local');
const B = await signIn('lib-b@test.local');
const E = await signIn('lib-e@test.local');

const md = (name: string, description: string, body = 'Do the thing.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

test('skills written in the app: checked, shared with every Bot, and refused on a name clash', async () => {
  const { cookie, botId: atlas, userId } = A;
  const quill = addBot(userId, 'bot_lib_quill', 'Quill');

  for (const [body, why] of [
    [{ name: 'Weekly Report', content: md('x', 'y') }, /lowercase letters/],
    [{ name: 'empty', content: '---\nname: empty\ndescription: d\n---\n' }, /Write the instructions/],
    [{ name: 'nodesc', content: 'Steps only.' }, /Say what the skill is for/],
    [{ name: 'badyaml', content: '---\nname: [x\n---\nsteps' }, /not valid YAML/],
  ] as const) {
    const r = await send('POST', '/api/skill-library', body, cookie);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }

  const made = await send('POST', '/api/skill-library', { name: 'weekly-report', content: md('ignored', 'Every Monday report', '1. Pull the numbers.\n2. Write three bullets.') }, cookie);
  assert.equal(made.status, 200);
  const s = made.body.skill;
  assert.equal(s.description, 'Every Monday report', 'the frontmatter description is used when none is given');
  assert.match(s.content, /^---\nname: weekly-report\n/, 'the stored SKILL.md carries the library name');
  assert.deepEqual(s.source, { type: 'manual' });
  assert.equal(s.createdBy.kind, 'user');
  assert.ok(s.bots.every((b: Json) => b.allowed), 'a new skill is every Bot\'s');

  const clash = await send('POST', '/api/skill-library', { name: 'weekly-report', content: 'Other steps.', description: 'd' }, cookie);
  assert.equal(clash.status, 409);

  assert.match(expandForBot(quill, 'Do /weekly-report now').text, /<skill name="weekly-report">\n1\. Pull the numbers\.\n2\. Write three bullets\.\n<\/skill>/);
  assert.match(expandForBot(atlas, '/weekly-report').text, /Pull the numbers/);
});

test('turning a skill off for one Bot, and "only selected Bots", decide who has it, new Bots included', async () => {
  const { cookie, userId } = B;
  const quill = addBot(userId, 'bot_acc_quill', 'Quill');
  const scout = addBot(userId, 'bot_acc_scout', 'Scout');
  const { body: { skill } } = await send('POST', '/api/skill-library', { name: 'tone', content: 'Be brief.', description: 'House tone' }, cookie);

  const off = await send('PUT', `/api/skill-library/${skill.id}/access/${quill}`, { allowed: false }, cookie);
  assert.equal(off.status, 200);
  assert.equal(off.body.skill.bots.find((b: Json) => b.botId === quill).allowed, false);
  assert.equal(expandForBot(quill, '/tone').text, '/tone', 'a Bot without the skill gets the message as typed');
  assert.match(expandForBot(scout, '/tone').text, /Be brief/);
  assert.match(await tool(quill, 'read_skill', { name: 'tone' }), /You have no skill named tone/);
  assert.doesNotMatch(await instructionsFor(userId, quill), /- tone: House tone/);
  assert.match(await instructionsFor(userId, scout), /## Skills\n- tone: House tone/);

  const late = addBot(userId, 'bot_acc_late', 'Late');
  assert.match(expandForBot(late, '/tone').text, /Be brief/, 'a Bot made later gets an every-Bot skill');

  const sel = await send('PATCH', `/api/skill-library/${skill.id}`, { availability: 'selected' }, cookie);
  assert.equal(sel.body.skill.availability, 'selected');
  assert.deepEqual(sel.body.skill.bots.filter((b: Json) => !b.allowed).map((b: Json) => b.botName), ['Quill'], 'switching keeps who has it today');
  const newer = addBot(userId, 'bot_acc_newer', 'Newer');
  assert.equal(expandForBot(newer, '/tone').text, '/tone', 'a Bot made after "only selected" does not get it');

  await send('PATCH', `/api/skill-library/${skill.id}`, { availability: 'all' }, cookie);
  assert.match(expandForBot(newer, '/tone').text, /Be brief/);
  assert.equal(expandForBot(quill, '/tone').text, '/tone', 'an explicit "off" survives switching back to every Bot');

  const edited = await send('PATCH', `/api/skill-library/${skill.id}`, { content: '---\ndescription: Newer tone\n---\nBe very brief.' }, cookie);
  assert.equal(edited.body.skill.description, 'Newer tone');
  assert.match(expandForBot(scout, '/tone').text, /Be very brief/);

  assert.equal((await send('DELETE', `/api/skill-library/${skill.id}`, undefined, cookie)).status, 200);
  assert.equal(expandForBot(scout, '/tone').text, '/tone');
});

test('a Bot adds a skill for the whole team, and reads skills it has with their files', async () => {
  const { cookie, botId: atlas, userId } = B;
  const quill = 'bot_acc_scout';

  assert.match(await tool(quill, 'create_skill', { name: 'Invoice Chase', description: 'Chasing an unpaid invoice', instructions: '1. Check the due date.\n2. Write a polite nudge.' }), /Added the skill invoice-chase/);
  const lib = (await send('GET', '/api/skill-library', undefined, cookie)).body.skills as Json[];
  const made = lib.find((s) => s.name === 'invoice-chase')!;
  assert.deepEqual(made.createdBy, { kind: 'bot', id: quill, name: 'Scout' });
  assert.ok(made.bots.every((b: Json) => b.allowed));
  assert.match(await tool(atlas, 'read_skill', { name: '/invoice-chase' }), /Write a polite nudge/, 'another Bot has it at once');
  assert.match(await tool(atlas, 'create_skill', { name: 'invoice-chase', description: 'x', instructions: 'y' }), /already a skill named invoice-chase/);
  assert.match(await tool(atlas, 'create_skill', { name: 'blank', description: 'x', instructions: '' }), /Write the instructions/);

  const listed = JSON.parse(await tool(atlas, 'list_skills', {})) as Json[];
  assert.deepEqual(listed.find((s) => s.name === 'invoice-chase'), { name: 'invoice-chase', description: 'Chasing an unpaid invoice', source: 'written in the app', added_by: 'Bot Scout' });
  const id = ((await send('GET', '/api/skill-library', undefined, cookie)).body.skills as Json[]).find((s) => s.name === 'invoice-chase')!.id;
  await send('PUT', `/api/skill-library/${id}/access/${atlas}`, { allowed: false }, cookie);
  assert.doesNotMatch(await tool(atlas, 'list_skills', {}), /invoice-chase/, 'a skill turned off is not listed');
});

test('list_tools shows a Bot its own tools, the apps it may use and its MCP servers', async () => {
  const { botId } = B;
  db.prepare("INSERT OR IGNORE INTO bot_app_revocations(bot_id,toolkit,created_at) VALUES (?, 'gmail', 1)").run(botId);
  const out = JSON.parse(await tool(botId, 'list_tools', {})) as Json;
  const names = (out.app_tools as Json[]).map((t) => t.name);
  for (const n of ['list_tools', 'list_skills', 'read_skill', 'create_skill', 'send_to_bot', 'calendar_list']) assert.ok(names.includes(n), n);
  assert.ok((out.app_tools as Json[]).every((t) => typeof t.does === 'string' && t.does.length > 0 && t.does.length <= 200));
  assert.deepEqual(out.apps_turned_off_for_you, ['gmail']);
  assert.ok(Array.isArray(out.mcp_servers) && !out.mcp_servers.includes('hq'), "the bot's own app connection is not listed as a server");
});

test('installing from GitHub checks the repo, ref and SKILL.md first, and keeps where it came from', async () => {
  const { cookie, botId: atlas } = E;
  repos = {
    'acme/skills': {
      branch: 'main',
      files: {
        'README.md': '# Skills',
        'skills/pdf/SKILL.md': md('pdf', 'Read and fill PDF forms', 'Run scripts/fill.py.'),
        'skills/pdf/scripts/fill.py': 'print("filled")',
        'skills/pdf/.github/ci.yml': 'ignored',
        'skills/brand/SKILL.md': md('brand', 'House brand rules'),
        'skills/broken/SKILL.md': '---\nname: Not Valid\ndescription: d\n---\nsteps',
      },
    },
    'acme/single': { branch: 'trunk', files: { 'SKILL.md': md('solo', 'One skill at the root'), 'notes.md': 'extra' } },
    'acme/empty': { branch: 'main', files: { 'README.md': 'nothing here' } },
    'acme/heavy': { branch: 'main', files: { 'SKILL.md': md('heavy', 'Too big'), 'blob.bin': 'x'.repeat(300 * 1024) } },
  };
  const inspect = (source: string) => send('POST', '/api/skill-library/github/inspect', { source }, cookie);
  const install = (source: string, pick?: string) => send('POST', '/api/skill-library/github', { source, ...(pick ? { pick } : {}) }, cookie);

  const many = await inspect('https://github.com/acme/skills');
  assert.equal(many.status, 200);
  assert.deepEqual(many.body.candidates.map((c: Json) => [c.path, c.name, c.files]), [['skills/brand', 'brand', 0], ['skills/pdf', 'pdf', 1]], 'an invalid SKILL.md is not offered');
  assert.equal(many.body.commit, SHA);

  assert.equal((await install('acme/skills')).status, 409, 'several skills need a pick');
  const pdf = await install('acme/skills', 'skills/pdf');
  assert.equal(pdf.status, 200);
  assert.deepEqual(pdf.body.skill.source, { type: 'github', repo: 'acme/skills', ref: 'main', commit: SHA, path: 'skills/pdf', url: `https://github.com/acme/skills/tree/${SHA}/skills/pdf` });
  assert.equal(pdf.body.skill.createdBy.kind, 'user');
  assert.deepEqual(pdf.body.skill.files, [{ path: 'scripts/fill.py', size: 15 }], 'supporting files come along; dot-folders do not');
  assert.match(await tool(atlas, 'read_skill', { name: 'pdf' }), /scripts\/fill\.py/);
  assert.equal(await tool(atlas, 'read_skill', { name: 'pdf', file: 'scripts/fill.py' }), 'print("filled")');
  // What a live Bot sent: the file under file_path. Every spelling reaches the same file.
  for (const args of [{ name: 'pdf', file_path: 'scripts/fill.py' }, { name: 'pdf', path: './scripts/fill.py' }, { name: 'pdf/scripts/fill.py' }]) {
    assert.equal(await tool(atlas, 'read_skill', args), 'print("filled")', JSON.stringify(args));
  }
  assert.equal((await install('acme/skills/skills/pdf')).status, 409, 'the same skill twice is a name clash');

  const solo = await install('https://github.com/acme/single');
  assert.equal(solo.body.skill.source.ref, 'trunk', 'the default branch is used when none is named');
  assert.deepEqual(solo.body.skill.files.map((f: Json) => f.path), ['notes.md']);

  for (const [source, status, why] of [
    ['acme/missing', 400, /no public GitHub repository acme\/missing/],
    ['https://github.com/acme/skills/tree/nope/skills/pdf', 400, /no branch, tag or commit named nope/],
    ['acme/empty', 400, /No SKILL\.md in acme\/empty/],
    ['acme/skills/skills/broken', 400, /lowercase letters/],
    ['acme/heavy', 400, /blob\.bin is larger than 256 KB/],
    ['not a repo', 400, /Not a GitHub repository/],
  ] as const) {
    const r = source === 'acme/heavy' || source === 'acme/skills/skills/broken' ? await install(source) : await inspect(source);
    assert.equal(r.status, status, source);
    assert.match(r.body.error, why, source);
  }
  rateLimited = true;
  assert.match((await inspect('acme/skills')).body.error, /rate-limiting/);
  rateLimited = false;
  const names = ((await send('GET', '/api/skill-library', undefined, cookie)).body.skills as Json[]).map((s) => s.name);
  assert.deepEqual(names, ['pdf', 'solo'], 'nothing was installed by a refused source');
});

test("a person's library is their own", async () => {
  const { cookie: mine } = A;
  const { cookie: theirs, botId: theirBot } = E;
  const id = ((await send('GET', '/api/skill-library', undefined, mine)).body.skills as Json[])[0].id;
  assert.equal((await send('PATCH', `/api/skill-library/${id}`, { content: 'mine now' }, theirs)).status, 404);
  assert.equal((await send('DELETE', `/api/skill-library/${id}`, undefined, theirs)).status, 404);
  assert.equal((await send('PUT', `/api/skill-library/${id}/access/${theirBot}`, { allowed: false }, mine)).status, 404, 'not someone else\'s Bot either');
  assert.ok(!((await send('GET', '/api/skill-library', undefined, theirs)).body.skills as Json[]).some((x) => x.id === id));
  assert.equal(expandForBot(theirBot, '/weekly-report').text, '/weekly-report');
});

test('skills that belonged to one Bot move into the library as that Bot\'s, under a usable name', async () => {
  const { userId, botId } = A;
  db.exec('CREATE TABLE skills (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)');
  db.prepare('INSERT INTO skills VALUES (?,?,?,?,?,?,?)').run('skl_old1', botId, 'Weekly Report', 'Old steps.', '', 1, 1);
  db.prepare('INSERT INTO skills VALUES (?,?,?,?,?,?,?)').run('skl_old2', botId, 'Prep for a sales call', 'Read the CRM first.', 'Before a call', 2, 2);

  migrateBotSkills();

  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='skills'").get(), undefined, 'the old table is gone');
  const moved = db.prepare("SELECT name, description, availability FROM skill_library WHERE user_id=? AND id LIKE 'skl_old%' ORDER BY id").all(userId);
  assert.deepEqual(moved, [
    { name: 'weekly-report-2', description: 'Weekly Report', availability: 'selected' },
    { name: 'prep-for-a-sales-call', description: 'Before a call', availability: 'selected' },
  ], 'a name already in the library gets a suffix; an empty description falls back to the old title');
  assert.match(expandForBot(botId, '/prep-for-a-sales-call').text, /Read the CRM first/);
  migrateBotSkills();
});
