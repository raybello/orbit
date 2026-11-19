// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.COMPOSIO_API_KEY = '';

const { db, now } = await import('../db.js');
const { GOOGLE_ACTIONS, GOOGLE_TOOLKIT_VERSION, classifyGoogleCall, isSelectOnly } = await import('../domain/google-actions.js');
const { canonicalComposioArgs, innerToolCalls } = await import('../composio.js');
const { policyFor, mayAlwaysAllow } = await import('../core/policy-service.js');

after(() => cleanupTmpEnv());

/**
 * The approval catalogue for Gmail, Calendar, Sheets and Docs, checked against what Composio really
 * has (the fixtures phase 0 captured) and against the decisions the user made: reads and new drafts
 * or files run, everything that changes existing things asks, and sending email asks every time.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/composio/schemas');
const toolkitSlugs = JSON.parse(fs.readFileSync(path.join(FIXTURES, '_toolkit-slugs.json'), 'utf8')) as Record<string, string[]>;
const summary = JSON.parse(fs.readFileSync(path.join(FIXTURES, '_summary.json'), 'utf8')) as Record<string, { version: string; params: string[] }>;

test('every catalogued action exists in its Composio toolkit', () => {
  const missing = [...GOOGLE_ACTIONS.values()].filter((a) => !toolkitSlugs[a.toolkit]?.includes(a.slug)).map((a) => a.slug);
  assert.deepEqual(missing, []);
});

test('every param name the app relies on is in that action\'s captured schema', () => {
  const wrong: string[] = [];
  for (const a of GOOGLE_ACTIONS.values()) {
    if (!a.params) continue;
    const schema = summary[a.slug];
    assert.ok(schema, `${a.slug} lists params but has no captured schema; run scripts/composio-shapes.mjs schemas`);
    for (const p of a.params) if (!schema.params.includes(p)) wrong.push(`${a.slug}.${p}`);
  }
  assert.deepEqual(wrong, []);
});

test('the catalogue was written against the toolkit version the fixtures were captured from', () => {
  for (const [slug, s] of Object.entries(summary)) assert.equal(s.version, GOOGLE_TOOLKIT_VERSION, slug);
});

test('each action is handled as decided', () => {
  const cases: [slug: string, kind: string, card: string | undefined, allowAlways: boolean][] = [
    ['GMAIL_WHO_AM_I', 'read', undefined, true],
    ['GMAIL_FETCH_EMAILS', 'read', undefined, true],
    ['GMAIL_CREATE_EMAIL_DRAFT', 'auto', 'email', true],
    ['GMAIL_UPDATE_DRAFT', 'auto', 'email', true],
    ['GMAIL_SEND_DRAFT', 'review', 'email', false],
    ['GMAIL_SEND_EMAIL', 'review', 'email', false],
    ['GMAIL_REPLY_TO_THREAD', 'review', 'email', false],
    ['GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'read', undefined, true],
    ['GOOGLECALENDAR_CREATE_EVENT', 'review', 'event', true],
    ['GOOGLECALENDAR_PATCH_EVENT', 'review', 'event', true],
    ['GOOGLECALENDAR_DELETE_EVENT', 'review', 'event', true],
    ['GOOGLESHEETS_CREATE_GOOGLE_SHEET1', 'auto', 'sheet', true],
    ['GOOGLESHEETS_VALUES_UPDATE', 'review', 'sheet', true],
    ['GOOGLESHEETS_DELETE_SHEET', 'review', 'sheet', true],
    ['GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', 'auto', 'doc', true],
    ['GOOGLEDOCS_REPLACE_ALL_TEXT', 'review', 'doc', true],
    ['GOOGLEDOCS_DELETE_CONTENT_RANGE', 'review', 'doc', true],
  ];
  for (const [slug, kind, card, allowAlways] of cases) {
    const a = classifyGoogleCall(slug, {});
    assert.deepEqual([a?.kind, a?.card, a?.allowAlways], [kind, card, allowAlways], slug);
  }
});

test('an action missing from the catalogue is read by its name, and other apps are not covered', () => {
  assert.equal(classifyGoogleCall('GMAIL_LIST_FORWARDING_ADDRESSES', {})?.kind, 'read');
  assert.equal(classifyGoogleCall('GMAIL_MOVE_TO_TRASH', {})?.kind, 'review');
  assert.equal(classifyGoogleCall('GMAIL_MOVE_TO_TRASH', {})?.card, undefined);
  assert.equal(classifyGoogleCall('gmail_send_email', {})?.kind, 'review', 'slug case does not matter');
  assert.equal(classifyGoogleCall('SLACK_SEND_MESSAGE', {}), undefined);
});

test('Sheets SQL runs only when it is a single SELECT', () => {
  const kind = (sql: unknown) => classifyGoogleCall('GOOGLESHEETS_EXECUTE_SQL', { spreadsheet_id: 's', sql })?.kind;
  assert.equal(kind('SELECT * FROM "Sheet1" LIMIT 5'), 'read');
  assert.equal(kind('  select a from t;  '), 'read');
  for (const sql of ['DELETE FROM "Sheet1" WHERE a = 1', 'UPDATE t SET a = 1', 'SELECT 1; DELETE FROM t', 'INSERT INTO t VALUES (1)', '', undefined, 42]) {
    assert.equal(kind(sql), 'review', String(sql));
  }
  assert.equal(isSelectOnly('WITH x AS (DELETE FROM t) SELECT 1'), false);
});

test('inner calls are read whether the bot sends arguments or tool_params', () => {
  assert.deepEqual(innerToolCalls('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [
    { tool_slug: 'GMAIL_SEND_DRAFT', arguments: { draft_id: 'd1' } },
    { tool_slug: 'GOOGLESHEETS_EXECUTE_SQL', tool_params: { sql: 'DELETE FROM t' } },
  ] }), [
    { slug: 'GMAIL_SEND_DRAFT', args: { draft_id: 'd1' } },
    { slug: 'GOOGLESHEETS_EXECUTE_SQL', args: { sql: 'DELETE FROM t' } },
  ]);
  assert.deepEqual(innerToolCalls('COMPOSIO_SEARCH_TOOLS', { queries: [] }), []);
  assert.deepEqual(innerToolCalls('GMAIL_SEND_EMAIL', { subject: 's' }), [{ slug: 'GMAIL_SEND_EMAIL', args: { subject: 's' } }]);
});

// ---------- the gate itself, over the policy table ----------

const USER = 'u_policy';
db.prepare('INSERT OR IGNORE INTO users(id,name,email,created_at) VALUES (?,?,?,?)').run(USER, 'Policy', 'policy@example.test', now());
beforeEach(() => db.prepare('DELETE FROM policies WHERE user_id=?').run(USER));
const store = (tool: string, mode: string) => db.prepare('INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,?)').run(USER, tool, mode);
const multi = (...tools: [string, Record<string, unknown>][]) => ({ tools: tools.map(([tool_slug, args]) => ({ tool_slug, arguments: args })) });

test('reads and new drafts run; a send asks and offers no "Always allow"', () => {
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GMAIL_WHO_AM_I', {}])).decision, 'allow');
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GMAIL_CREATE_EMAIL_DRAFT', { subject: 'x' }])).decision, 'allow');
  const send = policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GMAIL_SEND_DRAFT', { draft_id: 'd' }]));
  assert.deepEqual([send.decision, send.key, send.offerAlways, send.card], ['ask', 'GMAIL_SEND_DRAFT', false, 'email']);
});

test('a stored "Always allow" does not cover sending email', () => {
  store('GMAIL_SEND_DRAFT', 'always_allow');
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GMAIL_SEND_DRAFT', { draft_id: 'd' }])).decision, 'ask');
  assert.equal(mayAlwaysAllow('GMAIL_SEND_DRAFT'), false);
});

test('a stored "Always allow" still covers a calendar change, and "Never" still blocks a read', () => {
  store('GOOGLECALENDAR_CREATE_EVENT', 'always_allow');
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GOOGLECALENDAR_CREATE_EVENT', { summary: 'x' }])).decision, 'allow');
  assert.equal(mayAlwaysAllow('GOOGLECALENDAR_CREATE_EVENT'), true);
  store('GMAIL_FETCH_EMAILS', 'blocked');
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GMAIL_FETCH_EMAILS', {}])).decision, 'block');
});

test('a batch asks for its write, and a send anywhere in it removes "Always allow"', () => {
  const v = policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GMAIL_SEND_EMAIL', { subject: 'x' }], ['GOOGLECALENDAR_CREATE_EVENT', { summary: 'y' }]));
  assert.equal(v.decision, 'ask');
  assert.equal(v.offerAlways, false);
});

test('a destructive Sheets SQL asks; a SELECT runs', () => {
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GOOGLESHEETS_EXECUTE_SQL', { spreadsheet_id: 's', sql: 'SELECT * FROM t' }])).decision, 'allow');
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['GOOGLESHEETS_EXECUTE_SQL', { spreadsheet_id: 's', sql: 'DELETE FROM t' }])).decision, 'ask');
});

test('apps outside the catalogue keep the name-based reading', () => {
  assert.equal(policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['SLACK_LIST_CHANNELS', {}])).decision, 'allow');
  const v = policyFor(USER, 'COMPOSIO_MULTI_EXECUTE_TOOL', multi(['SLACK_SEND_MESSAGE', {}]));
  assert.equal(v.decision, 'ask');
  assert.equal(v.offerAlways, true);
});

test('an email body under the wrong name is moved to the name the action takes', () => {
  assert.deepEqual(
    canonicalComposioArgs('GMAIL_SEND_EMAIL', { recipient_email: 's@x.test', subject: 'Hi', message_body: 'Hello Stacy' }),
    { recipient_email: 's@x.test', subject: 'Hi', body: 'Hello Stacy' },
  );
  assert.deepEqual(canonicalComposioArgs('GMAIL_CREATE_EMAIL_DRAFT', { message_body: 'Draft text' }), { body: 'Draft text' });
  assert.deepEqual(canonicalComposioArgs('GMAIL_REPLY_TO_THREAD', { thread_id: 't1', body: 'Thanks' }), { thread_id: 't1', message_body: 'Thanks' });
});

test('a body already under the right name, or an action outside the catalogue, is left alone', () => {
  const both = { body: 'kept', message_body: 'ignored' };
  assert.deepEqual(canonicalComposioArgs('GMAIL_SEND_EMAIL', both), both);
  const slack = { channel: 'c', message_body: 'hi' };
  assert.equal(canonicalComposioArgs('SLACK_SEND_MESSAGE', slack), slack);
});

test('every action inside a batch call gets its own names', () => {
  const out = canonicalComposioArgs('COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [
      { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@x.test', message_body: 'one' } },
      { tool_slug: 'GMAIL_REPLY_TO_THREAD', arguments: { thread_id: 't', body: 'two' } },
    ],
  });
  assert.deepEqual(innerToolCalls('COMPOSIO_MULTI_EXECUTE_TOOL', out).map((c) => c.args), [
    { recipient_email: 'a@x.test', body: 'one' },
    { thread_id: 't', message_body: 'two' },
  ]);
});
