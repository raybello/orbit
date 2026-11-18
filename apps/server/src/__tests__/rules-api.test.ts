// api-env must be the FIRST import: it points env.ts at a temp database before env.ts reads process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { BotRule, CardBody, RuleLogEntry } from '@orbit/contracts';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { mcpToken } = await import('../engine.js');

const app = createApp();
after(() => cleanupTmpEnv());

/**
 * Rules over the two surfaces that matter: the HTTP API a person edits them through, and the MCP
 * endpoint an engine calls tools through. Both are the production routes on a real SQLite file.
 */

type Json = Record<string, any>;

async function send(method: string, path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const json = async (r: Response) => (await r.json()) as Json;

async function signIn(email: string): Promise<{ cookie: string; botId: string }> {
  const r = await send('POST', '/api/auth/dev', { email });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const bots = (await json(await send('GET', '/api/bots', undefined, cookie))).bots as Json[];
  return { cookie, botId: String(bots[0].id) };
}

const rulesOf = async (botId: string, cookie: string) =>
  (await json(await send('GET', `/api/bots/${botId}/rules`, undefined, cookie))) as { rules: BotRule[]; log: RuleLogEntry[] };

async function addRule(botId: string, cookie: string, body: unknown): Promise<BotRule> {
  const r = await send('POST', `/api/bots/${botId}/rules`, body, cookie);
  assert.equal(r.status, 200, `adding ${JSON.stringify(body)}`);
  return (await json(r)).rule as BotRule;
}

async function clearRules(botId: string, cookie: string) {
  for (const r of (await rulesOf(botId, cookie)).rules) await send('DELETE', `/api/bots/${botId}/rules/${r.id}`, undefined, cookie);
}

/** One tool call the way an engine makes it. */
async function callTool(botId: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await app.request(`/mcp/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(botId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(r.status, 200);
  const result = (await json(r)).result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join(''), isError: result.isError === true };
}

type ApprovalCard = Extract<CardBody, { card: 'approval' }>;

const pendingApprovals = (botId: string): ApprovalCard[] =>
  (db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='card' ORDER BY seq").all(botId) as { body: string }[])
    .map((r) => JSON.parse(r.body) as CardBody)
    .filter((b): b is ApprovalCard => b.card === 'approval' && b.status === 'pending');

/** The approval card a call is waiting on. The call raises it a moment after the request lands. */
async function waitForApproval(botId: string): Promise<ApprovalCard> {
  for (let i = 0; i < 200; i++) {
    const [card] = pendingApprovals(botId);
    if (card) return card;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('no approval card appeared');
}

const ROUTINES_OUTPUT = '[]';

test('editing rules over the API', async (t) => {
  const ada = await signIn('ada-rules@example.test');
  const bob = await signIn('bob-rules@example.test');
  const base = `/api/bots/${ada.botId}/rules`;

  await t.test('a bot starts with no rules and an empty log', async () => {
    assert.deepEqual(await rulesOf(ada.botId, ada.cookie), { rules: [], log: [] });
  });

  await t.test('a preset is added as the rule the preset describes', async () => {
    const rule = await addRule(ada.botId, ada.cookie, { preset: 'ask-before-shell' });
    assert.equal(rule.description, 'Ask before running shell commands');
    assert.deepEqual(rule.pattern, { kind: 'computer-shell', matchRegex: '.*' });
    assert.equal(rule.action, 'ask');
    assert.equal(rule.preset, 'ask-before-shell');
    assert.equal(rule.botId, ada.botId);
  });

  await t.test('adding the same preset again answers with the same rule', async () => {
    const first = (await rulesOf(ada.botId, ada.cookie)).rules[0];
    const again = await addRule(ada.botId, ada.cookie, { preset: 'ask-before-shell', action: 'block' });
    assert.equal(again.id, first.id);
    assert.equal(again.action, 'ask', 'the rule that is already there is not rewritten');
    assert.equal((await rulesOf(ada.botId, ada.cookie)).rules.length, 1);
  });

  await t.test('a preset can be added with another action', async () => {
    const rule = await addRule(ada.botId, ada.cookie, { preset: 'ask-before-deleting', action: 'block' });
    assert.equal(rule.action, 'block');
    assert.deepEqual(rule.pattern, { kind: 'composio-hint', hints: ['destructiveHint'] });
  });

  await t.test('a rule of the person\'s own is stored as written', async () => {
    const rule = await addRule(ada.botId, ada.cookie, {
      description: '  Never force-push  ', pattern: { kind: 'computer-shell', matchRegex: 'git push .*--force' }, action: 'block',
    });
    assert.equal(rule.description, 'Never force-push');
    assert.equal(rule.preset, null);
    const stored = (await rulesOf(ada.botId, ada.cookie)).rules.find((r) => r.id === rule.id);
    assert.deepEqual(stored, rule);
  });

  const rejected: { name: string; body: unknown }[] = [
    { name: 'an unknown preset', body: { preset: 'ask-before-everything' } },
    { name: 'an expression that does not compile', body: { description: 'x', pattern: { kind: 'computer-shell', matchRegex: '(' }, action: 'ask' } },
    { name: 'an unknown action', body: { description: 'x', pattern: { kind: 'always' }, action: 'warn' } },
    { name: 'an unknown pattern kind', body: { description: 'x', pattern: { kind: 'everything' }, action: 'ask' } },
    { name: 'an empty description', body: { description: '   ', pattern: { kind: 'always' }, action: 'ask' } },
    { name: 'no pattern', body: { description: 'x', action: 'ask' } },
  ];
  for (const c of rejected) {
    await t.test(`${c.name} is a 400 and stores nothing`, async () => {
      const before = (await rulesOf(ada.botId, ada.cookie)).rules.length;
      const r = await send('POST', base, c.body, ada.cookie);
      assert.equal(r.status, 400);
      assert.equal((await rulesOf(ada.botId, ada.cookie)).rules.length, before);
    });
  }

  await t.test('a rule can change what it does', async () => {
    const custom = (await rulesOf(ada.botId, ada.cookie)).rules.find((r) => r.preset === null)!;
    const r = await send('PATCH', `${base}/${custom.id}`, { action: 'ask' }, ada.cookie);
    assert.equal(r.status, 200);
    assert.equal(((await json(r)).rule as BotRule).action, 'ask');
    const stored = (await rulesOf(ada.botId, ada.cookie)).rules.find((x) => x.id === custom.id)!;
    assert.equal(stored.action, 'ask');
    assert.deepEqual(stored.pattern, custom.pattern, 'what it matches is untouched');
  });

  await t.test('a rule of the person\'s own can change what it matches', async () => {
    const custom = (await rulesOf(ada.botId, ada.cookie)).rules.find((r) => r.preset === null)!;
    const r = await send('PATCH', `${base}/${custom.id}`, { description: 'Never sudo', pattern: { kind: 'computer-shell', matchRegex: '^sudo ' } }, ada.cookie);
    assert.equal(r.status, 200);
    const stored = (await rulesOf(ada.botId, ada.cookie)).rules.find((x) => x.id === custom.id)!;
    assert.equal(stored.description, 'Never sudo');
    assert.deepEqual(stored.pattern, { kind: 'computer-shell', matchRegex: '^sudo ' });
  });

  await t.test('a preset keeps what it matches', async () => {
    const preset = (await rulesOf(ada.botId, ada.cookie)).rules.find((r) => r.preset === 'ask-before-shell')!;
    const r = await send('PATCH', `${base}/${preset.id}`, { pattern: { kind: 'always' } }, ada.cookie);
    assert.equal(r.status, 400);
    const stored = (await rulesOf(ada.botId, ada.cookie)).rules.find((x) => x.id === preset.id)!;
    assert.deepEqual(stored.pattern, preset.pattern);
  });

  await t.test('another account cannot read or change the rules', async () => {
    const rule = (await rulesOf(ada.botId, ada.cookie)).rules[0];
    assert.equal((await send('GET', base, undefined, bob.cookie)).status, 404);
    assert.equal((await send('POST', base, { preset: 'log-file-writes' }, bob.cookie)).status, 404);
    assert.equal((await send('PATCH', `${base}/${rule.id}`, { action: 'log' }, bob.cookie)).status, 404);
    assert.equal((await send('DELETE', `${base}/${rule.id}`, undefined, bob.cookie)).status, 404);
    assert.equal((await send('DELETE', `/api/bots/${bob.botId}/rules/${rule.id}`, undefined, bob.cookie)).status, 404, 'nor through a bot of their own');
    assert.deepEqual((await rulesOf(ada.botId, ada.cookie)).rules.find((r) => r.id === rule.id), rule);
  });

  await t.test('no session, no rules', async () => {
    assert.equal((await send('GET', base, undefined)).status, 401);
    assert.equal((await send('POST', base, { preset: 'log-file-writes' })).status, 401);
  });

  await t.test('a deleted rule is gone, and deleting it again is a 404', async () => {
    const rule = (await rulesOf(ada.botId, ada.cookie)).rules[0];
    assert.equal((await send('DELETE', `${base}/${rule.id}`, undefined, ada.cookie)).status, 200);
    assert.equal((await rulesOf(ada.botId, ada.cookie)).rules.some((r) => r.id === rule.id), false);
    assert.equal((await send('DELETE', `${base}/${rule.id}`, undefined, ada.cookie)).status, 404);
  });

  await t.test('a group chat has no rules', async () => {
    const second = (await json(await send('POST', '/api/bots', { name: 'Scout' }, ada.cookie))).bot as Json;
    const room = await json(await send('POST', '/api/rooms', { name: 'Launch', botIds: [ada.botId, second.id] }, ada.cookie));
    assert.equal((await send('GET', `/api/bots/${room.id}/rules`, undefined, ada.cookie)).status, 404);
  });

  await t.test('deleting a bot takes its rules with it', async () => {
    const scout = ((await json(await send('GET', '/api/bots', undefined, ada.cookie))).bots as Json[]).find((b) => b.name === 'Scout')!;
    await addRule(String(scout.id), ada.cookie, { preset: 'log-file-writes' });
    assert.equal((await send('DELETE', `/api/bots/${scout.id}`, undefined, ada.cookie)).status, 200);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM bot_rules WHERE bot_id=?').get(scout.id) as { n: number }).n, 0);
  });
});

test('rules at the gate every tool call passes', async (t) => {
  const eve = await signIn('eve-rules@example.test');
  const { botId, cookie } = eve;

  await t.test('with no rules a call runs', async () => {
    assert.deepEqual(await callTool(botId, 'list_routines'), { text: ROUTINES_OUTPUT, isError: false });
    assert.deepEqual((await rulesOf(botId, cookie)).log, []);
  });

  await t.test('a block rule stops the call and tells the engine which rule did', async () => {
    const rule = await addRule(botId, cookie, { description: 'Hands off', pattern: { kind: 'always' }, action: 'block' });
    const result = await callTool(botId, 'list_routines');
    assert.notEqual(result.text, ROUTINES_OUTPUT);
    assert.match(result.text, /Hands off/);
    const [entry] = (await rulesOf(botId, cookie)).log;
    assert.equal(entry.ruleId, rule.id);
    assert.equal(entry.outcome, 'blocked');
    assert.equal(entry.tool, 'list_routines');
    assert.equal(pendingApprovals(botId).length, 0, 'a blocked call asks nobody');
    await clearRules(botId, cookie);
  });

  await t.test('a shell rule blocks the command it matches before it reaches the computer', async () => {
    await addRule(botId, cookie, { description: 'No recursive deletes', pattern: { kind: 'computer-shell', matchRegex: 'rm\\s+-rf' }, action: 'block' });
    const result = await callTool(botId, 'computer_shell', { command: 'rm -rf /tmp/build' });
    assert.match(result.text, /No recursive deletes/);
    const [entry] = (await rulesOf(botId, cookie)).log;
    assert.equal(entry.detail, 'rm -rf /tmp/build');
    assert.equal(entry.outcome, 'blocked');
    assert.deepEqual(await callTool(botId, 'list_routines'), { text: ROUTINES_OUTPUT, isError: false }, 'other tools are not the rule\'s business');
    await clearRules(botId, cookie);
  });

  await t.test('a log rule lets the call run and records it', async () => {
    const rule = await addRule(botId, cookie, { description: 'Note everything', pattern: { kind: 'always' }, action: 'log' });
    const before = (await rulesOf(botId, cookie)).log.length;
    assert.deepEqual(await callTool(botId, 'list_routines'), { text: ROUTINES_OUTPUT, isError: false });
    const log = (await rulesOf(botId, cookie)).log;
    assert.equal(log.length, before + 1);
    assert.deepEqual(
      { ruleId: log[0].ruleId, action: log[0].action, tool: log[0].tool, outcome: log[0].outcome },
      { ruleId: rule.id, action: 'log', tool: 'list_routines', outcome: 'ran' },
    );
    await clearRules(botId, cookie);
  });

  await t.test('an ask rule holds the call until the person answers, and no means it never runs', async () => {
    const rule = await addRule(botId, cookie, { description: 'Check with me first', pattern: { kind: 'always' }, action: 'ask' });
    const call = callTool(botId, 'list_routines');
    const card = await waitForApproval(botId);
    assert.deepEqual(card.rule, { id: rule.id, description: 'Check with me first' });
    assert.equal((await send('POST', `/api/approvals/${card.approvalId}`, { decision: 'deny' }, cookie)).status, 200);
    const result = await call;
    assert.notEqual(result.text, ROUTINES_OUTPUT);
    assert.match(result.text, /declined/i);
    assert.equal((await rulesOf(botId, cookie)).log[0].outcome, 'denied');
  });

  await t.test('an ask rule lets the call run once the person allows it', async () => {
    const call = callTool(botId, 'list_routines');
    const card = await waitForApproval(botId);
    assert.equal((await send('POST', `/api/approvals/${card.approvalId}`, { decision: 'allow' }, cookie)).status, 200);
    assert.deepEqual(await call, { text: ROUTINES_OUTPUT, isError: false });
    assert.equal((await rulesOf(botId, cookie)).log[0].outcome, 'ran');
    await clearRules(botId, cookie);
  });

  await t.test('the bot may still ask the person a question under an ask-everything rule', async () => {
    await addRule(botId, cookie, { description: 'Check with me first', pattern: { kind: 'always' }, action: 'ask' });
    const result = await callTool(botId, 'ask_user', { question: 'Tea or coffee?', options: ['Tea', 'Coffee'] });
    assert.match(result.text, /Question shown to the user/);
    assert.equal(pendingApprovals(botId).length, 0);
    await clearRules(botId, cookie);
  });

  await t.test('"Always allow" does not outrank a rule: ask and block still win', async (t2) => {
    const userId = (db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string }).user_id;
    // Slack, not Gmail: sending email may never be always-allowed (domain/google-actions.ts).
    db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, 'SLACK_SEND_MESSAGE');
    const sendMessage = () => callTool(botId, 'SLACK_SEND_MESSAGE', { channel: '#general', text: 'hi' });

    await t2.test('alone, the always-allowed tool goes straight to the app', async () => {
      const result = await sendMessage();
      // No Composio key in this suite: reaching the app at all is what shows nothing held the call.
      assert.equal(result.isError, true);
      assert.match(result.text, /^Tool error/);
      assert.equal(pendingApprovals(botId).length, 0);
    });

    await t2.test('with an ask rule it waits for the person, and the card does not come from the policy', async () => {
      const rule = await addRule(botId, cookie, { preset: 'ask-before-sending' });
      const call = sendMessage();
      const card = await waitForApproval(botId);
      assert.equal(card.rule?.id, rule.id);
      assert.equal(card.tool, 'SLACK_SEND_MESSAGE');
      await send('POST', `/api/approvals/${card.approvalId}`, { decision: 'deny' }, cookie);
      assert.match((await call).text, /declined/i);
      await clearRules(botId, cookie);
    });

    await t2.test('with a block rule it never runs', async () => {
      await addRule(botId, cookie, { description: 'No Slack at all', pattern: { kind: 'composio-tool', tools: ['SLACK_*'] }, action: 'block' });
      const result = await sendMessage();
      assert.equal(result.isError, false);
      assert.match(result.text, /No Slack at all/);
      await clearRules(botId, cookie);
    });
  });

  await t.test('a tag rule reads the tool by its name when the catalog cannot be asked', async () => {
    await addRule(botId, cookie, { preset: 'ask-before-deleting', action: 'block' });
    const result = await callTool(botId, 'GOOGLEDRIVE_DELETE_FILE', { file_id: 'f1' });
    assert.match(result.text, /Ask before deleting anything/);
    assert.equal((await rulesOf(botId, cookie)).log[0].tool, 'GOOGLEDRIVE_DELETE_FILE');
    await clearRules(botId, cookie);
  });

  await t.test('the tool inside a batch call is the one a rule sees', async () => {
    await addRule(botId, cookie, { description: 'No email at all', pattern: { kind: 'composio-tool', tools: ['GMAIL_SEND_EMAIL'] }, action: 'block' });
    const result = await callTool(botId, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }, { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'sam@example.test' } }],
    });
    assert.match(result.text, /No email at all/);
    await clearRules(botId, cookie);
  });
});
