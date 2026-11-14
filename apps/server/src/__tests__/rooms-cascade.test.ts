import './helpers/tmp-env.js'; // must be first: points DB_PATH/HERMES_HOME_PRIMARY at a temp dir
import assert from 'node:assert/strict';
import test from 'node:test';

// Loaded after the temp env exists, so db.ts opens the throwaway database.
const { db, now } = await import('../db.js');
const { initRooms, buildGroupTurn, dispatchBotMentions, dispatchRoomMessage, postToRoom, MAX_BOT_CHAIN_DEPTH } = await import('../agent/rooms.js');
const { toolMap } = await import('../agent/tools.js');
const { appendRow } = await import('../store.js');
const { cleanupTmpEnv } = await import('./helpers/tmp-env.js');

initRooms();

const USER = 'usr_rooms_cascade';
const ROOM = 'room_cascade_test';
const SCOUT = 'bot_cascade_scout';
const BARBIE = 'bot_cascade_barbie';
const DOUG = 'bot_cascade_doug';
const ANN = 'bot_cascade_ann_marie';
const OUTSIDER = 'bot_cascade_zelda';

const t0 = now();
db.prepare('INSERT INTO users(id,email,name,avatar_url,created_at) VALUES (?,?,?,?,?)').run(USER, 'cascade@example.test', 'Cascade Tester', null, t0);
const insertBot = db.prepare("INSERT INTO bots(id,user_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)");
insertBot.run(SCOUT, USER, 'Scout', 'agent', t0, t0);
insertBot.run(BARBIE, USER, 'Barbie', 'agent', t0, t0);
insertBot.run(DOUG, USER, 'Doug', 'agent', t0, t0);
insertBot.run(ANN, USER, 'Ann Marie', 'agent', t0, t0);
insertBot.run(OUTSIDER, USER, 'Zelda', 'agent', t0, t0);
db.prepare("INSERT INTO bots(id,user_id,name,kind,members,created_at,updated_at) VALUES (?,?,?,'room',?,?,?)")
  .run(ROOM, USER, 'Research Team', JSON.stringify([SCOUT, BARBIE, DOUG, ANN]), t0, t0);

test.after(() => cleanupTmpEnv());

/** Every dispatch in one test, in the order postToRoom/dispatchBotMentions made them. */
function recording() {
  const calls: { botId: string; turn: any }[] = [];
  return { calls, enqueue: (botId: string, turn: any) => calls.push({ botId, turn }) };
}

const roomRowCount = () => (db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(ROOM) as any).n;

const toolCtx = (botId: string, enqueue: (botId: string, turn: any) => void, groupDepth = 0) => ({
  userId: USER,
  botId,
  enqueueBotMessage: () => {},
  depth: 0,
  enqueue,
  groupDepth,
});

test.beforeEach(() => {
  db.prepare('DELETE FROM rows WHERE bot_id=?').run(ROOM);
});

// ---------- dispatchBotMentions ----------

test('an @mention of a peer enqueues exactly that bot one hop deeper', () => {
  const { calls, enqueue } = recording();
  const ids = dispatchBotMentions(ROOM, SCOUT, 'I pulled the numbers. @Barbie can you check the narrative?', 0, enqueue);

  assert.deepEqual(ids, [BARBIE]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].botId, BARBIE);
  assert.equal(calls[0].turn.type, 'system');
  assert.equal(calls[0].turn._groupDepth, 1);
  assert.match(calls[0].turn.text, /You were @mentioned by Scout\./);
});

test('the last hop is dispatched, and nothing is dispatched at the chain limit', () => {
  const last = recording();
  dispatchBotMentions(ROOM, SCOUT, '@Barbie over to you', MAX_BOT_CHAIN_DEPTH - 1, last.enqueue);
  assert.deepEqual(last.calls.map((c) => [c.botId, c.turn._groupDepth]), [[BARBIE, MAX_BOT_CHAIN_DEPTH]]);

  for (const depth of [MAX_BOT_CHAIN_DEPTH, MAX_BOT_CHAIN_DEPTH + 1]) {
    const { calls, enqueue } = recording();
    const ids = dispatchBotMentions(ROOM, SCOUT, '@Barbie are you there?', depth, enqueue);
    assert.deepEqual(ids, [], `depth ${depth} must not dispatch`);
    assert.equal(calls.length, 0, `depth ${depth} must not enqueue`);
  }
});

test('a self-mention is ignored', () => {
  const { calls, enqueue } = recording();
  assert.deepEqual(dispatchBotMentions(ROOM, SCOUT, '@Scout here is my summary', 0, enqueue), []);

  // A self-mention alongside a peer only dispatches the peer.
  assert.deepEqual(dispatchBotMentions(ROOM, SCOUT, '@Scout @Doug splitting this with you', 0, enqueue), [DOUG]);
  assert.deepEqual(calls.map((c) => c.botId), [DOUG]);
});

test('a mention of a bot outside the room is ignored', () => {
  const { calls, enqueue } = recording();
  assert.deepEqual(dispatchBotMentions(ROOM, SCOUT, '@Zelda can you sanity-check this?', 0, enqueue), []);
  assert.equal(calls.length, 0);
});

test('two @mentions in one message both dispatch', () => {
  const { calls, enqueue } = recording();
  const ids = dispatchBotMentions(ROOM, DOUG, '@Barbie and @Scout, can you two settle this?', 0, enqueue);

  assert.deepEqual([...ids].sort(), [BARBIE, SCOUT].sort());
  assert.equal(calls.length, 2);
  assert.deepEqual([...calls.map((c) => c.botId)].sort(), [BARBIE, SCOUT].sort());
});

test('duplicate mentions of the same bot dispatch it once', () => {
  const { calls, enqueue } = recording();
  const ids = dispatchBotMentions(ROOM, SCOUT, '@Barbie @barbie @BARBIE same question as before', 0, enqueue);

  assert.deepEqual(ids, [BARBIE]);
  assert.equal(calls.length, 1);
});

test('a member whose name has a space matches on the whole name', () => {
  const { calls, enqueue } = recording();
  const ids = dispatchBotMentions(ROOM, SCOUT, '@Ann Marie can you take the summary?', 0, enqueue);

  assert.deepEqual(ids, [ANN]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].turn._groupDepth, 1);
});

// ---------- buildGroupTurn ----------

test('a chained group turn carries the room, the reason, and its depth', () => {
  const { calls, enqueue } = recording();
  dispatchBotMentions(ROOM, SCOUT, '@Doug take it', 1, enqueue);
  const turn = calls[0].turn;

  assert.equal(turn._groupDepth, 2);
  assert.match(turn.text, /\[Group chat "Research Team"\] Members: Scout, Barbie, Doug, Ann Marie\./);
  assert.match(turn.text, /You were @mentioned by Scout\./);
  assert.match(turn.text, /post_to_group with group_name "Research Team"/);
  assert.match(turn.text, /@mention them/);
  assert.match(turn.text, /stay_silent/);
  // Depth 2 is the last hop before the limit: the bot is told to wrap up.
  assert.match(turn.text, /near the chain limit/);
});

test('a depth-0 turn is a general group turn with no wrap-up warning', () => {
  const general = buildGroupTurn(ROOM, 0);
  assert.equal(general._groupDepth, 0);
  assert.match(general.text, /The user addressed the whole group\./);
  assert.doesNotMatch(general.text, /near the chain limit/);

  // Being @mentioned at depth 0 is the user's doing, not a peer's.
  const userPing = buildGroupTurn(ROOM, 0, { mentioned: true });
  assert.match(userPing.text, /You were @mentioned\./);
  assert.doesNotMatch(userPing.text, /near the chain limit/);
});

test('the group turn carries the last 20 messages, oldest first', () => {
  for (let i = 0; i < 25; i++) {
    const n = String(i).padStart(2, '0');
    appendRow(ROOM, 'message', { type: 'message', role: 'assistant', text: `line-${n}`, from: { kind: 'bot', id: SCOUT, name: 'Scout' } } as any);
  }
  const turn = buildGroupTurn(ROOM, 1);

  // The newest 20 are kept: line-05 … line-24, and the first five have aged out.
  assert.match(turn.text, /Scout: line-24/);
  assert.match(turn.text, /Scout: line-05/);
  assert.doesNotMatch(turn.text, /line-04/);
  assert.doesNotMatch(turn.text, /line-00/);
  assert.ok(turn.text.indexOf('line-05') < turn.text.indexOf('line-24'), 'oldest first');
});

// ---------- tool handlers ----------

test('stay_silent posts nothing and dispatches nobody', async () => {
  const before = roomRowCount();
  const { calls, enqueue } = recording();
  const tool = toolMap.get('stay_silent');
  assert.ok(tool);

  const res = await tool.impl({ reason: 'nothing worth adding' }, toolCtx(SCOUT, enqueue, 1));

  assert.equal(res.endTurn, true);
  assert.equal(calls.length, 0);
  assert.equal(roomRowCount(), before);
});

test('post_to_group dispatches a mentioned peer at the turn depth plus one', async () => {
  const { calls, enqueue } = recording();
  const tool = toolMap.get('post_to_group');
  assert.ok(tool);

  const res = await tool.impl({ group_name: 'Research Team', text: '@Doug can you pull the Q3 chart?' }, toolCtx(BARBIE, enqueue, 1));

  assert.equal(res.output, 'Posted to the group.');
  assert.equal(res.endTurn, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].botId, DOUG);
  assert.equal(calls[0].turn._groupDepth, 2);
  assert.equal(roomRowCount(), 1);
});

test('post_to_group keeps its error text and dispatches nothing when the bot is not a member', async () => {
  const { calls, enqueue } = recording();
  const tool = toolMap.get('post_to_group');
  assert.ok(tool);

  const res = await tool.impl({ group_name: 'Research Team', text: '@Doug hello' }, toolCtx(OUTSIDER, enqueue, 0));

  assert.equal(res.output, `You're not a member of "Research Team".`);
  assert.equal(res.endTurn, false);
  assert.equal(calls.length, 0);
});

// ---------- user-initiated dispatch ----------

test('a user message dispatches only the members it @mentions, at depth 0', () => {
  const { calls, enqueue } = recording();
  dispatchRoomMessage(ROOM, 'Morning all — @Barbie can you start us off?', enqueue);

  assert.deepEqual(calls.map((c) => c.botId), [BARBIE]);
  assert.equal(calls[0].turn._groupDepth, 0);
  assert.match(calls[0].turn.text, /You were @mentioned\./);
});

test('a user message with no @mention goes to the group at depth 0', () => {
  const { calls, enqueue } = recording();
  dispatchRoomMessage(ROOM, 'What does everyone think about the Q3 numbers?', enqueue);

  assert.deepEqual(calls.map((c) => c.botId), [SCOUT, BARBIE, DOUG]);
  assert.ok(calls.every((c) => c.turn._groupDepth === 0));
  assert.ok(calls.every((c) => /The user addressed the whole group\./.test(c.turn.text)));
});

test('postToRoom appends the message and bumps the group unread count', () => {
  const { calls, enqueue } = recording();
  const unreadBefore = (db.prepare('SELECT unread FROM bots WHERE id=?').get(ROOM) as any).unread;

  const out = postToRoom(SCOUT, 'Research Team', 'Draft is in the doc. @Barbie please review.', 0, enqueue);

  assert.equal(out, 'Posted to the group.');
  assert.equal(roomRowCount(), 1);
  assert.equal((db.prepare('SELECT unread FROM bots WHERE id=?').get(ROOM) as any).unread, unreadBefore + 1);
  assert.deepEqual(calls.map((c) => c.botId), [BARBIE]);
  assert.equal(calls[0].turn._groupDepth, 1);
});

