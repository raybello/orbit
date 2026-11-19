// api-env must be the FIRST import: it runs tmp-env.ts (which points env.ts at a temp DB before env.ts
// snapshots process.env) and then sets the few values an app-level suite needs. Everything that reads
// env.ts is imported dynamically below, after that module body has run.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { CardBody } from '@orbit/contracts';

// What index.ts would have run before serving. createApp() deliberately starts no background work, but
// its routes read the `kind` / `hidden` columns these two migrations add, so they run here first.
const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { env } = await import('../env.js');
const { COLORS, SHAPES } = await import('../core/avatar.js');

const app = createApp();

/**
 * The API over real HTTP: every case below goes through createApp().request(), the same fetch-shaped
 * surface the web client, the desktop app and the phone talk to, backed by a real SQLite file in a
 * mkdtemp (helpers/api-env.ts). Nothing is mocked and no server is started: the routes, the
 * middleware, the error handler and the database are the production ones, so a status or a stored
 * value asserted here is what a client would actually see.
 */

type Json = Record<string, any>;

const jsonBody = async (r: Response): Promise<Json> => (await r.json()) as Json;

/** One request with an optional session cookie. */
async function call(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  return app.request(path, { ...init, headers });
}

/** A request with a JSON body (omitted when `body` is undefined, as a body-less DELETE is). */
async function send(method: string, path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** The `grokbot_session` cookie a sign-in sets, as a Cookie request header would carry it. */
function sessionCookie(r: Response): string {
  const raw = r.headers.get('set-cookie') ?? '';
  const pair = raw.split(';')[0] ?? '';
  assert.match(pair, /^grokbot_session=[^;]+$/, `expected a session cookie, got ${JSON.stringify(raw)}`);
  return pair;
}

/** The user's roster, as GET /api/bots answers it. */
async function roster(cookie: string): Promise<Json[]> {
  const r = await call('/api/bots', {}, cookie);
  assert.equal(r.status, 200);
  return (await jsonBody(r)).bots as Json[];
}

const rowCount = (botId: string) =>
  (db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(botId) as { n: number }).n;

/** How many stored user messages carry exactly `text` (the route writes one per answered question). */
const countUserTexts = (botId: string, text: string) =>
  (db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message'").all(botId) as { body: string }[])
    .map((r) => JSON.parse(r.body) as { role?: string; text?: string })
    .filter((b) => b.role === 'user' && b.text === text).length;

/**
 * Arrange a pending card the way the agent loop would: a `rows` row at the bot's current generation
 * and next_seq, then next_seq advanced. Tests write this directly because no HTTP route creates cards
 * — they are made by a model turn, and the interesting behaviour is deciding them.
 */
function insertCard(botId: string, body: CardBody): number {
  const bot = db.prepare('SELECT generation, next_seq FROM bots WHERE id=?').get(botId) as { generation: number; next_seq: number };
  db.transaction(() => {
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(
      botId, bot.generation, bot.next_seq, bot.next_seq, 'card', JSON.stringify(body), Date.now(),
    );
    db.prepare('UPDATE bots SET next_seq = next_seq + 1 WHERE id=?').run(botId);
  })();
  return bot.next_seq;
}

/** The card as it is stored now, at the bot's current generation. */
function cardAt(botId: string, seq: number): CardBody {
  const row = db
    .prepare('SELECT body FROM rows WHERE bot_id=? AND generation=(SELECT generation FROM bots WHERE id=?) AND seq=?')
    .get(botId, botId, seq) as { body: string } | undefined;
  assert.ok(row, `row ${seq} of ${botId} should still exist`);
  return JSON.parse(row.body) as CardBody;
}

test('the Orbit API over real HTTP and a real database', async (t) => {
  let userOne = '';
  let userTwo = '';
  let primaryBotId = '';
  let secondBotId = '';

  await t.test('1. GET /api/health is public and reports a live server', async () => {
    const r = await call('/api/health');
    assert.equal(r.status, 200);
    const body = await jsonBody(r);
    assert.equal(body.ok, true);
    assert.equal(body.engine, 'hermes');
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptimeMs, 'number');
    assert.equal(body.stackToken, undefined, 'no stack token was offered, so none is claimed');
  });

  await t.test('2. POST /api/auth/dev signs in and creates exactly one primary bot', async () => {
    const r = await send('POST', '/api/auth/dev', { email: 'ada@example.test' });
    assert.equal(r.status, 200);
    assert.deepEqual(await jsonBody(r), { ok: true });
    userOne = sessionCookie(r);

    const bots = await roster(userOne);
    assert.equal(bots.length, 1, 'a new account starts with one bot, not none');
    const [first] = bots;
    assert.ok(first);
    assert.equal(first.isPrimary, true);
    assert.equal(first.name, env.primaryBotName);
    assert.match(String(first.id), /^bot_/);
    primaryBotId = String(first.id);
  });

  await t.test('3. GET /api/bots without a session is 401 and carries no data', async () => {
    const r = await call('/api/bots');
    assert.equal(r.status, 401);
    const body = await jsonBody(r);
    assert.equal(body.bots, undefined, 'an unauthorised answer carries no roster');
    assert.deepEqual(body, { error: 'unauthenticated' });
  });

  await t.test('4. POST /api/bots adds a second bot with a palette avatar', async () => {
    const r = await send('POST', '/api/bots', { name: 'Second', mode: 'personal' }, userOne);
    assert.equal(r.status, 200);
    const bot = (await jsonBody(r)).bot as Json;
    assert.match(String(bot.id), /^bot_/);
    assert.equal(bot.name, 'Second');
    assert.equal(bot.mode, 'personal');
    assert.equal(bot.isPrimary, false);
    assert.ok(SHAPES.includes(bot.avatarShape), `avatarShape ${bot.avatarShape} is a palette shape`);
    assert.ok(COLORS.includes(bot.avatarColor), `avatarColor ${bot.avatarColor} is a palette colour`);
    secondBotId = String(bot.id);

    const bots = await roster(userOne);
    assert.equal(bots.length, 2);
    assert.deepEqual(bots.map((b) => b.id).sort(), [primaryBotId, secondBotId].sort());
  });

  await t.test('5. POST /api/bots with a non-string name is a field-specific 400', async () => {
    const before = (await roster(userOne)).length;
    const r = await send('POST', '/api/bots', { name: 123 }, userOne);
    assert.equal(r.status, 400);
    assert.match(String((await jsonBody(r)).error), /^invalid name:/);
    assert.equal((await roster(userOne)).length, before, 'a rejected body creates no bot');
  });

  await t.test('6. PATCH /api/bots/:id renames the bot and GET reflects it', async () => {
    const r = await send('PATCH', `/api/bots/${secondBotId}`, { label: 'Renamed' }, userOne);
    assert.equal(r.status, 200);
    assert.equal((await jsonBody(r)).bot.label, 'Renamed');
    const patched = (await roster(userOne)).find((b) => b.id === secondBotId);
    assert.equal(patched?.label, 'Renamed');
  });

  await t.test('7. POST /api/bots/:id/messages with whitespace is 400 empty and writes no row', async () => {
    const before = rowCount(secondBotId);
    const r = await send('POST', `/api/bots/${secondBotId}/messages`, { text: '   ' }, userOne);
    assert.equal(r.status, 400);
    assert.deepEqual(await jsonBody(r), { error: 'empty' });
    assert.equal(rowCount(secondBotId), before, 'an empty message must not reach the transcript');
  });

  await t.test('8. a second account sees only its own bots and cannot read or patch the first account’s', async () => {
    const r = await send('POST', '/api/auth/dev', { email: 'grace@example.test' });
    assert.equal(r.status, 200, 'the second account can sign in while the first owns two bots');
    userTwo = sessionCookie(r);

    const mine = await roster(userTwo);
    assert.equal(mine.length, 1, 'the roster is per account, not global');
    assert.equal(mine[0].isPrimary, true);
    assert.notEqual(mine[0].id, primaryBotId);
    assert.notEqual(mine[0].id, secondBotId);

    const rows = await call(`/api/bots/${primaryBotId}/rows`, {}, userTwo);
    assert.equal(rows.status, 404, 'another account’s transcript must not be readable');
    assert.deepEqual(await jsonBody(rows), { error: 'not found' });

    const patch = await send('PATCH', `/api/bots/${primaryBotId}`, { label: 'Taken' }, userTwo);
    assert.equal(patch.status, 404);

    const untouched = (await roster(userOne)).find((b) => b.id === primaryBotId);
    assert.equal(untouched?.label, env.primaryBotLabel, 'the refused PATCH wrote nothing');
  });

  await t.test('9. cards decide over HTTP and persist the card machine’s own statuses', async () => {
    const questionSeq = insertCard(primaryBotId, {
      type: 'card', card: 'question', question: 'Where should I book the room?',
      options: ['Berlin', 'Lisbon'], status: 'pending',
    });
    const connectSeq = insertCard(primaryBotId, {
      type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail',
      reason: 'Read the thread', status: 'pending',
    });
    const draftSeq = insertCard(primaryBotId, {
      type: 'card', card: 'draft', channel: 'email', to: 'sam@example.test',
      subject: 'Re: offsite', text: 'Works for me.', approvalId: 'apr_draft', status: 'pending',
    });

    const answer = 'Berlin, near the station';
    const first = await send('POST', `/api/bots/${primaryBotId}/cards/${questionSeq}/answer`, { answer }, userOne);
    assert.equal(first.status, 200);
    assert.deepEqual(await jsonBody(first), { ok: true });
    assert.equal(cardAt(primaryBotId, questionSeq).status, 'answered');
    const answered = cardAt(primaryBotId, questionSeq);
    assert.equal(answered.card === 'question' ? answered.answer : undefined, answer, 'the stored card carries the answer');
    assert.equal(countUserTexts(primaryBotId, answer), 1, 'the answer is one user message in the transcript');

    const again = await send('POST', `/api/bots/${primaryBotId}/cards/${questionSeq}/answer`, { answer }, userOne);
    assert.equal(again.status, 200, 'a second tap is idempotent success');
    assert.equal(cardAt(primaryBotId, questionSeq).status, 'answered');
    assert.equal(countUserTexts(primaryBotId, answer), 1, 'and appends no second user message');

    const skipped = await send('POST', `/api/bots/${primaryBotId}/cards/${connectSeq}/dismiss`, undefined, userOne);
    assert.equal(skipped.status, 200);
    assert.equal(cardAt(primaryBotId, connectSeq).status, 'skipped', 'a connect card is skipped, not dismissed');

    const discarded = await send('POST', `/api/bots/${primaryBotId}/cards/${draftSeq}/dismiss`, undefined, userOne);
    assert.equal(discarded.status, 200);
    assert.equal(cardAt(primaryBotId, draftSeq).status, 'discarded', 'a dismissed draft is discarded, never dismissed');

    // An approval card has no dismiss move at all, so the machine refuses it — after the card exists,
    // so the row's untouched status is provable rather than inferred.
    const approvalSeq = insertCard(primaryBotId, {
      type: 'card', card: 'approval', approvalId: 'apr_pending', title: 'Send the email',
      detail: '', tool: 'GMAIL_SEND_EMAIL', args: {}, status: 'pending',
    });
    const refused = await send('POST', `/api/bots/${primaryBotId}/cards/${approvalSeq}/dismiss`, undefined, userOne);
    assert.equal(refused.status, 400, 'illegal card move is a bad request, not a 500');
    assert.match(String((await jsonBody(refused)).error), /does not allow 'dismiss'/);
    assert.equal(cardAt(primaryBotId, approvalSeq).status, 'pending', 'a refused move writes nothing');
  });

  await t.test('10. POST /api/approvals/:id for an unknown approval is 404', async () => {
    const r = await send('POST', '/api/approvals/does-not-exist', { decision: 'allow' }, userOne);
    assert.equal(r.status, 404);
    assert.deepEqual(await jsonBody(r), { error: 'not found' });
  });

  await t.test('11. PATCH /api/routines/:id for an unknown routine is 404', async () => {
    const r = await send('PATCH', '/api/routines/does-not-exist', { enabled: true }, userOne);
    assert.equal(r.status, 404);
    assert.deepEqual(await jsonBody(r), { error: 'not found' });
  });

  await t.test('12. POST /api/bots/:id/screen/control rejects an unknown action', async () => {
    const r = await send('POST', `/api/bots/${primaryBotId}/screen/control`, { action: 'nope' }, userOne);
    assert.equal(r.status, 400);
    assert.deepEqual(await jsonBody(r), { error: "action must be 'take' or 'give'" });
  });

  await t.test('13. DELETE /api/push/register accepts a request with no body', async () => {
    const r = await call('/api/push/register', { method: 'DELETE' }, userOne);
    assert.equal(r.status, 200, 'a body-less DELETE must not be a parse error');
    assert.deepEqual(await jsonBody(r), { ok: true });
  });

  await t.test('14. a draft action on a card that is not a draft is 404 with the draft error', async () => {
    const seq = insertCard(primaryBotId, { type: 'card', card: 'question', question: 'Which day?', options: ['Mon'], status: 'pending' });
    const r = await send('POST', `/api/bots/${primaryBotId}/cards/${seq}/draft`, { action: 'discard' }, userOne);
    assert.equal(r.status, 404);
    assert.deepEqual(await jsonBody(r), { error: 'Not a Gmail draft card.' });
  });

  await t.test('15. calendar action failures answer with the calendar error’s own status', async () => {
    const gone = await call('/api/calendar/google/events/no-such-key', { method: 'DELETE' }, userOne);
    assert.equal(gone.status, 404);
    assert.deepEqual(await jsonBody(gone), { error: 'That event is no longer in your calendar.' });
    const noCal = await send('POST', '/api/calendar/google/events', { fields: { summary: 'Standup', description: '', location: '', start: '2026-12-01T09:00', end: '2026-12-01T09:30', allDay: false, timezone: 'UTC', attendees: [], meet: false } }, userOne);
    assert.equal(noCal.status, 404);
    assert.deepEqual(await jsonBody(noCal), { error: 'That calendar is not connected.' });
  });

  await t.test('16. the error boundary maps each domain error once and hides unknown ones', async () => {
    const { ReviewEditError } = await import('../review/types.js');
    const { IllegalCardMoveError } = await import('../core/card-service.js');
    const { BotAdminError } = await import('../bot-admin.js');
    const { TeamFullError } = await import('../core/bot-service.js');
    const probe = createApp();
    const throwers: Record<string, () => never> = {
      review: () => { throw new ReviewEditError('An event needs a title.'); },
      card: () => { throw new IllegalCardMoveError('approval', 'pending', 'dismiss'); },
      admin: () => { throw new BotAdminError(404, 'No such bot.'); },
      full: () => { throw new TeamFullError(4); },
      bug: () => { throw new Error('secret internals'); },
    };
    probe.post('/__boom/:kind', (c) => throwers[c.req.param('kind')]());
    const hit = (kind: string) => probe.request(`/__boom/${kind}`, { method: 'POST' });

    const review = await hit('review');
    assert.equal(review.status, 400);
    assert.deepEqual(await jsonBody(review), { error: 'An event needs a title.' });
    const card = await hit('card');
    assert.equal(card.status, 400);
    assert.match(String((await jsonBody(card)).error), /does not allow 'dismiss'/);
    const admin = await hit('admin');
    assert.equal(admin.status, 404);
    assert.deepEqual(await jsonBody(admin), { error: 'No such bot.' });
    const full = await hit('full');
    assert.equal(full.status, 409);
    assert.match(String((await jsonBody(full)).error), /team is full/);
    const bug = await hit('bug');
    assert.equal(bug.status, 500);
    assert.equal(await bug.text(), 'Internal Server Error', 'an unknown failure keeps its message hidden');
  });
});

after(() => {
  cleanupTmpEnv();
});
