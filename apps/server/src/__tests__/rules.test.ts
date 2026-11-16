import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RULE_PRESETS, type BotRule, type RuleAction, type RulePattern, type RulePresetId } from '@orbit/contracts';
import { evaluateRules, hintsFromSlug, RulePatternSchema, strictest, type ToolCall } from '../domain/rules.js';
import type { Decision } from '../agent/tools.js';

/**
 * The rule engine is a pure function, so every case is a row: the rules a bot has, the call it makes,
 * and the decision the person who wrote those rules would expect.
 */

let n = 0;
const rule = (action: RuleAction, pattern: RulePattern, description = `rule ${n + 1}`): BotRule => ({
  id: `rule_${++n}`, botId: 'bot_1', description, pattern, action, preset: null, createdAt: n,
});

const composio = (...tools: [slug: string, ...hints: string[]][]): ToolCall => ({
  kind: 'composio', tools: tools.map(([slug, ...hints]) => ({ slug, hints })),
});
const shell = (command: string): ToolCall => ({ kind: 'shell', command });
const app = (tool: string): ToolCall => ({ kind: 'app', tool });

const sendEmail = composio(['GMAIL_SEND_EMAIL', 'createHint']);
const readInbox = composio(['GMAIL_FETCH_EMAILS', 'readOnlyHint']);
const deleteFile = composio(['GOOGLEDRIVE_DELETE_FILE', 'destructiveHint']);
const tweet = composio(['TWITTER_CREATION_OF_A_POST', 'createHint']);

describe('which calls a pattern matches', () => {
  const cases: { name: string; pattern: RulePattern; call: ToolCall; matches: boolean }[] = [
    { name: 'a tool slug, exactly', pattern: { kind: 'composio-tool', tools: ['GMAIL_SEND_EMAIL'] }, call: sendEmail, matches: true },
    { name: 'a tool slug, whatever its case', pattern: { kind: 'composio-tool', tools: ['gmail_send_email'] }, call: sendEmail, matches: true },
    { name: 'another tool of the same app', pattern: { kind: 'composio-tool', tools: ['GMAIL_SEND_EMAIL'] }, call: readInbox, matches: false },
    { name: 'a slug that only starts the same', pattern: { kind: 'composio-tool', tools: ['GMAIL_SEND'] }, call: sendEmail, matches: false },
    { name: 'a wildcard across apps', pattern: { kind: 'composio-tool', tools: ['*_SEND*'] }, call: composio(['SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL']), matches: true },
    { name: 'a wildcard that does not fit', pattern: { kind: 'composio-tool', tools: ['*_SEND*'] }, call: readInbox, matches: false },
    { name: 'the second tool of a batch', pattern: { kind: 'composio-tool', tools: ['GMAIL_SEND_EMAIL'] }, call: composio(['GMAIL_FETCH_EMAILS'], ['GMAIL_SEND_EMAIL']), matches: true },
    { name: 'a tool pattern against a shell command', pattern: { kind: 'composio-tool', tools: ['*'] }, call: shell('ls'), matches: false },

    { name: 'a tag the tool carries', pattern: { kind: 'composio-hint', hints: ['destructiveHint'] }, call: deleteFile, matches: true },
    { name: 'a tag the tool does not carry', pattern: { kind: 'composio-hint', hints: ['destructiveHint'] }, call: sendEmail, matches: false },
    { name: 'any one of several tags', pattern: { kind: 'composio-hint', hints: ['updateHint', 'createHint'] }, call: sendEmail, matches: true },
    { name: 'a tag inside the named toolkits', pattern: { kind: 'composio-hint', hints: ['createHint'], toolkits: ['twitter', 'linkedin'] }, call: tweet, matches: true },
    { name: 'a tag outside the named toolkits', pattern: { kind: 'composio-hint', hints: ['createHint'], toolkits: ['twitter', 'linkedin'] }, call: sendEmail, matches: false },
    { name: 'a toolkit whose name only starts another', pattern: { kind: 'composio-hint', hints: ['createHint'], toolkits: ['git'] }, call: composio(['GITHUB_CREATE_AN_ISSUE', 'createHint']), matches: false },
    { name: 'a toolkit with an underscore in its name', pattern: { kind: 'composio-hint', hints: ['createHint'], toolkits: ['microsoft_teams'] }, call: composio(['MICROSOFT_TEAMS_CREATE_CHAT', 'createHint']), matches: true },
    { name: 'a tag pattern against an app tool', pattern: { kind: 'composio-hint', hints: ['createHint'] }, call: app('save_file'), matches: false },

    { name: 'any shell command', pattern: { kind: 'computer-shell', matchRegex: '.*' }, call: shell('ls -la'), matches: true },
    { name: 'a command the expression finds', pattern: { kind: 'computer-shell', matchRegex: 'rm\\s+-rf' }, call: shell('cd /tmp && rm  -rf build'), matches: true },
    { name: 'a command the expression does not find', pattern: { kind: 'computer-shell', matchRegex: 'rm\\s+-rf' }, call: shell('ls -la'), matches: false },
    { name: 'a shell pattern against a connected app', pattern: { kind: 'computer-shell', matchRegex: '.*' }, call: sendEmail, matches: false },
    { name: 'a shell pattern against another app tool', pattern: { kind: 'computer-shell', matchRegex: '.*' }, call: app('computer_click'), matches: false },

    { name: 'always, a connected app', pattern: { kind: 'always' }, call: readInbox, matches: true },
    { name: 'always, a shell command', pattern: { kind: 'always' }, call: shell('ls'), matches: true },
    { name: 'always, an app tool', pattern: { kind: 'always' }, call: app('save_file'), matches: true },
    { name: 'always, a connected-app meta tool with nothing to run', pattern: { kind: 'always' }, call: composio(), matches: true },
    { name: 'always, the bot asking the person a question', pattern: { kind: 'always' }, call: app('ask_user'), matches: false },
    { name: 'always, the bot staying silent', pattern: { kind: 'always' }, call: app('stay_silent'), matches: false },
    { name: 'always, the bot asking for an app connection', pattern: { kind: 'always' }, call: app('request_app_connection'), matches: false },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const r = rule('ask', c.pattern);
      const verdict = evaluateRules([r], c.call);
      assert.equal(verdict.decision, c.matches ? 'ask' : 'allow');
      assert.deepEqual(verdict.matched, c.matches ? [r] : []);
    });
  }
});

describe('what the matching rules decide', () => {
  const ask = () => rule('ask', { kind: 'always' });
  const block = () => rule('block', { kind: 'always' });
  const log = () => rule('log', { kind: 'always' });
  const miss = (action: RuleAction) => rule(action, { kind: 'computer-shell', matchRegex: 'never' });

  const cases: { name: string; rules: BotRule[]; decision: Decision; decider: number | null; matched: number[] }[] = [
    { name: 'no rules allow', rules: [], decision: 'allow', decider: null, matched: [] },
    { name: 'a rule that does not match allows', rules: [miss('block')], decision: 'allow', decider: null, matched: [] },
    { name: 'log lets the call run and is recorded', rules: [log()], decision: 'allow', decider: null, matched: [0] },
    { name: 'ask asks', rules: [ask()], decision: 'ask', decider: 0, matched: [0] },
    { name: 'block blocks', rules: [block()], decision: 'block', decider: 0, matched: [0] },
    { name: 'block wins over an earlier ask', rules: [ask(), block()], decision: 'block', decider: 1, matched: [0, 1] },
    { name: 'block wins over a later ask', rules: [block(), ask()], decision: 'block', decider: 0, matched: [0, 1] },
    { name: 'ask wins over log', rules: [log(), ask()], decision: 'ask', decider: 1, matched: [0, 1] },
    { name: 'the first of two asks is the one named', rules: [ask(), ask()], decision: 'ask', decider: 0, matched: [0, 1] },
    { name: 'a block that misses does not count', rules: [miss('block'), ask(), log()], decision: 'ask', decider: 1, matched: [1, 2] },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const verdict = evaluateRules(c.rules, app('save_file'));
      assert.equal(verdict.decision, c.decision);
      assert.equal(verdict.decidedBy?.rule ?? null, c.decider === null ? null : c.rules[c.decider]);
      assert.deepEqual(verdict.matched, c.matched.map((i) => c.rules[i]));
    });
  }

  test('the verdict names the connected-app tool that triggered it', () => {
    const r = rule('ask', { kind: 'composio-tool', tools: ['GMAIL_SEND_EMAIL'] });
    const batch = composio(['GMAIL_FETCH_EMAILS'], ['GMAIL_SEND_EMAIL']);
    assert.equal(evaluateRules([r], batch).decidedBy?.tool, 'GMAIL_SEND_EMAIL');
  });

  test('a shell verdict names no connected-app tool', () => {
    const r = rule('block', { kind: 'computer-shell', matchRegex: 'sudo' });
    assert.equal(evaluateRules([r], shell('sudo reboot')).decidedBy?.tool, null);
  });
});

describe('a rule next to the approval policy', () => {
  const decisions: Decision[] = ['allow', 'ask', 'block'];
  const expected: Record<Decision, Record<Decision, Decision>> = {
    allow: { allow: 'allow', ask: 'ask', block: 'block' },
    ask: { allow: 'ask', ask: 'ask', block: 'block' },
    block: { allow: 'block', ask: 'block', block: 'block' },
  };
  for (const policy of decisions) {
    for (const rules of decisions) {
      test(`policy ${policy} and rules ${rules} give ${expected[policy][rules]}`, () => {
        assert.equal(strictest(policy, rules), expected[policy][rules]);
      });
    }
  }
});

describe('the presets', () => {
  const preset = (id: RulePresetId): BotRule => {
    const p = RULE_PRESETS.find((x) => x.id === id);
    assert.ok(p, `preset ${id} exists`);
    return rule(p.action, p.pattern, p.description);
  };

  const cases: { preset: RulePresetId; call: ToolCall; decision: Decision; logged?: boolean }[] = [
    { preset: 'ask-before-sending', call: sendEmail, decision: 'ask' },
    { preset: 'ask-before-sending', call: composio(['SLACK_SEND_MESSAGE']), decision: 'ask' },
    { preset: 'ask-before-sending', call: composio(['GMAIL_REPLY_TO_THREAD']), decision: 'ask' },
    { preset: 'ask-before-sending', call: readInbox, decision: 'allow' },
    { preset: 'ask-before-posting', call: tweet, decision: 'ask' },
    { preset: 'ask-before-posting', call: composio(['LINKEDIN_CREATE_LINKED_IN_POST', 'createHint']), decision: 'ask' },
    { preset: 'ask-before-posting', call: composio(['TWITTER_RECENT_SEARCH', 'readOnlyHint']), decision: 'allow' },
    { preset: 'ask-before-posting', call: composio(['NOTION_CREATE_PAGE', 'createHint']), decision: 'allow' },
    { preset: 'ask-before-deleting', call: deleteFile, decision: 'ask' },
    { preset: 'ask-before-deleting', call: sendEmail, decision: 'allow' },
    { preset: 'log-file-writes', call: composio(['GOOGLEDRIVE_EDIT_FILE', 'updateHint']), decision: 'allow', logged: true },
    { preset: 'log-file-writes', call: readInbox, decision: 'allow', logged: false },
    { preset: 'ask-before-shell', call: shell('ls'), decision: 'ask' },
    { preset: 'ask-before-shell', call: app('computer_click'), decision: 'allow' },
  ];

  for (const c of cases) {
    const what = c.call.kind === 'composio' ? c.call.tools.map((t) => t.slug).join('+') : c.call.kind === 'shell' ? `shell: ${c.call.command}` : c.call.tool;
    test(`${c.preset} on ${what} gives ${c.decision}`, () => {
      const verdict = evaluateRules([preset(c.preset)], c.call);
      assert.equal(verdict.decision, c.decision);
      if (c.logged !== undefined) assert.equal(verdict.matched.length, c.logged ? 1 : 0);
    });
  }

  test('every preset is a pattern the server would accept', () => {
    for (const p of RULE_PRESETS) assert.equal(RulePatternSchema.safeParse(p.pattern).success, true, p.id);
  });
});

describe('tags guessed from a slug when the catalog cannot be asked', () => {
  const cases: [slug: string, hints: string[]][] = [
    ['GOOGLEDRIVE_DELETE_FILE', ['destructiveHint']],
    ['GMAIL_MOVE_TO_TRASH', ['destructiveHint', 'updateHint']],
    ['NOTION_UPDATE_PAGE', ['updateHint']],
    ['GMAIL_SEND_EMAIL', ['createHint']],
    ['GITHUB_CREATE_AN_ISSUE', ['createHint']],
    ['GMAIL_FETCH_EMAILS', []],
    ['SLACK_LIST_CHANNELS', []],
    ['notion_update_page', ['updateHint']],
  ];
  for (const [slug, hints] of cases) {
    test(`${slug} reads as ${hints.join(', ') || 'no write'}`, () => assert.deepEqual(hintsFromSlug(slug), hints));
  }
});

describe('which patterns are accepted at the boundary', () => {
  const cases: { name: string; pattern: unknown; ok: boolean }[] = [
    { name: 'a tool list', pattern: { kind: 'composio-tool', tools: ['GMAIL_SEND_EMAIL', '*_SEND*'] }, ok: true },
    { name: 'an empty tool list', pattern: { kind: 'composio-tool', tools: [] }, ok: false },
    { name: 'a tool that is not a slug', pattern: { kind: 'composio-tool', tools: ['(a+)+$'] }, ok: false },
    { name: 'tags', pattern: { kind: 'composio-hint', hints: ['destructiveHint'] }, ok: true },
    { name: 'tags with toolkits', pattern: { kind: 'composio-hint', hints: ['createHint'], toolkits: ['twitter'] }, ok: true },
    { name: 'a tag that does not exist', pattern: { kind: 'composio-hint', hints: ['readOnlyHint'] }, ok: false },
    { name: 'no tags', pattern: { kind: 'composio-hint', hints: [] }, ok: false },
    { name: 'a shell expression', pattern: { kind: 'computer-shell', matchRegex: 'rm\\s+-rf' }, ok: true },
    { name: 'a shell expression that does not compile', pattern: { kind: 'computer-shell', matchRegex: '(' }, ok: false },
    { name: 'an empty shell expression', pattern: { kind: 'computer-shell', matchRegex: '' }, ok: false },
    { name: 'always', pattern: { kind: 'always' }, ok: true },
    { name: 'an unknown kind', pattern: { kind: 'everything' }, ok: false },
    { name: 'a field from another kind', pattern: { kind: 'always', matchRegex: '.*' }, ok: false },
    { name: 'not an object', pattern: 'always', ok: false },
  ];
  for (const c of cases) {
    test(c.name, () => assert.equal(RulePatternSchema.safeParse(c.pattern).success, c.ok));
  }
});
