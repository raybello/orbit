import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import type { InitiativeLevel } from '@orbit/contracts';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { db, now } = await import('../db.js');
const { createApp } = await import('../api/app.js');
const { issueSessionToken } = await import('../lib/auth.js');
const { appendRow } = await import('../store.js');
const { createRoutine, runRoutine, setRoutineEnqueue, unscheduleRoutine } = await import('../routines.js');
const { recordRoutineOutcome, scheduledRunAllowed } = await import('../initiative-store.js');
const { allows, briefingCron, briefingSchedule } = await import('../domain/initiative.js');
const proactive = await import('../proactive.js');
type Trigger = import('../core/turn-queue.js').Trigger;

const app = createApp();
const HOUR = 3_600_000;

/** Every turn the scheduler queued, in order. */
const turns: { botId: string; trigger: Trigger }[] = [];
proactive.setProactiveEnqueue((botId, trigger) => turns.push({ botId, trigger }));
setRoutineEnqueue((botId, trigger) => turns.push({ botId, trigger }));
const routineIds = new Set<string>();

let n = 0;
/** A fresh person with a primary Bot (and a second, later primary that must never get anything). */
function person(level: InitiativeLevel = 'proactive', joinedAt = now()) {
  const id = `usr_init_${++n}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, 'Pat', joinedAt);
  const bot = `bot_init_${n}`;
  const later = `bot_init_${n}_b`;
  db.prepare('INSERT INTO bots(id,user_id,name,is_primary,initiative,created_at,updated_at) VALUES (?,?,?,1,?,?,?)').run(bot, id, 'Atlas', level, joinedAt, joinedAt);
  db.prepare('INSERT INTO bots(id,user_id,name,is_primary,created_at,updated_at) VALUES (?,?,?,1,?,?)').run(later, id, 'Robin', joinedAt + 1, joinedAt + 1);
  return { userId: id, botId: bot, laterPrimary: later };
}

const authed = (userId: string) => ({ authorization: `Bearer ${issueSessionToken(userId).token}`, 'content-type': 'application/json' });
const systemTexts = (botId: string) => turns.filter((t) => t.botId === botId && t.trigger.type === 'system').map((t) => (t.trigger as { text: string }).text);

function failedRoutine(botId: string, name: string) {
  const r = createRoutine({ botId, title: name, prompt: 'Do the thing.', eventType: 'recurring', schedule: '0 9 * * *' });
  routineIds.add(r.id);
  runRoutine(r.id);
  recordRoutineOutcome(r.id, 'failed');
  return r;
}

beforeEach(() => { turns.length = 0; });
after(() => {
  for (const id of routineIds) unscheduleRoutine(id);
  for (const { routine_id } of db.prepare('SELECT routine_id FROM morning_briefings WHERE routine_id IS NOT NULL').all() as { routine_id: string }[]) unscheduleRoutine(routine_id);
  cleanupTmpEnv();
});

test('each level lets through exactly the unsolicited acts the plan gives it', () => {
  const kinds = ['checkin', 'briefing', 'card_waiting', 'user_idle', 'routine_failed', 'connection_expired'] as const;
  const allowed = (level: InitiativeLevel) => kinds.filter((k) => allows(level, k));
  assert.deepEqual(allowed('proactive'), [...kinds]);
  assert.deepEqual(allowed('reactive'), ['routine_failed', 'connection_expired']);
  assert.deepEqual(allowed('off'), []);
});

test('a briefing time round-trips through its cron and keeps the day field', () => {
  assert.equal(briefingCron('08:00'), '0 8 * * 1-5');
  assert.equal(briefingCron('7:5'), null);
  assert.equal(briefingCron('24:00'), null);
  assert.deepEqual(briefingSchedule('30 6 * * *'), { time: '06:30', days: '*' });
  assert.equal(briefingSchedule('*/15 8 * * *'), null, 'not a time of day');
  assert.equal(briefingSchedule('0 8 1 * *'), null, 'monthly is not a daily time');
});

test('a failed routine reaches the first primary Bot once, as an alert, and never again', () => {
  const p = person();
  failedRoutine(p.botId, 'Inbox sweep');

  proactive.initiativeTick(now());
  const texts = systemTexts(p.botId);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /\[alert\] The routine "Inbox sweep" \(Atlas\) failed on its last run/);
  assert.equal(systemTexts(p.laterPrimary).length, 0, 'only the first primary acts on initiative');

  proactive.initiativeTick(now() + 10 * 60_000);
  assert.equal(systemTexts(p.botId).length, 1, 'the same failed run is not reported twice');
});

test('a run that succeeds or is still going is not a failure', () => {
  const p = person();
  const r = createRoutine({ botId: p.botId, title: 'Digest', prompt: 'Digest.', eventType: 'recurring', schedule: '0 9 * * *' });
  routineIds.add(r.id);
  runRoutine(r.id);
  proactive.initiativeTick(now());
  recordRoutineOutcome(r.id, 'ok');
  proactive.initiativeTick(now());
  assert.equal(systemTexts(p.botId).length, 0);
});

test('a card left waiting over an hour is noticed; one outside the current conversation is not', () => {
  const p = person();
  const t0 = now();
  appendRow(p.botId, 'card', { type: 'card', card: 'question', question: 'Which hotel should I book?', options: [], status: 'pending' });
  db.prepare('UPDATE bots SET generation = generation + 1 WHERE id=?').run(p.botId);
  appendRow(p.botId, 'card', { type: 'card', card: 'question', question: 'Old question', options: [], status: 'pending' });
  db.prepare('UPDATE bots SET generation = generation - 1 WHERE id=?').run(p.botId);

  proactive.initiativeTick(t0 + 30 * 60_000);
  assert.equal(systemTexts(p.botId).length, 0, 'thirty minutes is not long enough');

  proactive.initiativeTick(t0 + 2 * HOUR);
  const texts = systemTexts(p.botId);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Atlas has been waiting on the user for 2h: Which hotel should I book\?/);
  assert.doesNotMatch(texts[0], /Old question/);
  assert.doesNotMatch(texts[0], /\[alert\] Atlas/, 'a waiting card is not an alert');
});

test('a long silence is noticed after the configured hours, once per silence, and 0 turns it off', async () => {
  const joined = now();
  const p = person('proactive', joined);
  const put = await app.request('/api/initiative', { method: 'PUT', headers: authed(p.userId), body: JSON.stringify({ idleHours: 3 }) });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { idleHours: number }).idleHours, 3);

  proactive.initiativeTick(joined + 2 * HOUR);
  assert.equal(systemTexts(p.botId).length, 0);
  proactive.initiativeTick(joined + 4 * HOUR);
  assert.match(systemTexts(p.botId).join('\n'), /has not sent a message in over 3 hours/);
  proactive.initiativeTick(joined + 9 * HOUR);
  assert.equal(systemTexts(p.botId).length, 1, 'one nudge per stretch of silence');

  const q = person('proactive', joined);
  proactive.setInitiativeSettings(q.userId, { idleHours: 0 });
  proactive.initiativeTick(joined + 100 * HOUR);
  assert.equal(systemTexts(q.botId).length, 0);
});

test('reactive passes only alerts, and off passes nothing', () => {
  const t0 = now();
  for (const level of ['reactive', 'off'] as const) {
    const p = person(level, t0 - 100 * HOUR);
    appendRow(p.botId, 'card', { type: 'card', card: 'question', question: 'Waiting', options: [], status: 'pending' });
    failedRoutine(p.botId, 'Weekly report');
    proactive.initiativeTick(t0 + 2 * HOUR);
    const texts = systemTexts(p.botId);
    if (level === 'reactive') {
      assert.equal(texts.length, 1);
      assert.match(texts[0], /Weekly report/);
      assert.doesNotMatch(texts[0], /Waiting|has not sent a message/);
    } else {
      assert.equal(texts.length, 0);
    }
  }
});

test('a signal waits while the person is mid-conversation and goes out afterwards', () => {
  const p = person();
  const t0 = now();
  appendRow(p.botId, 'message', { type: 'message', role: 'user', text: 'hi' });
  assert.equal(proactive.emitInitiativeSignal(p.userId, { kind: 'connection_expired', connectionId: 'ca_1', toolkit: 'gmail', toolkitName: 'Gmail' }, t0 + 60_000), 'queued');
  assert.equal(systemTexts(p.botId).length, 0, 'held while the person is chatting');

  proactive.initiativeTick(t0 + 30 * 60_000);
  const texts = systemTexts(p.botId);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /\[alert\] The Gmail connection expired/);
});

test('emitInitiativeSignal is idempotent and respects the level', () => {
  const p = person('proactive', now() - 100 * HOUR);
  proactive.setInitiativeSettings(p.userId, { idleHours: 0 });
  const expired = { kind: 'connection_expired', connectionId: 'ca_2', toolkit: 'slack' } as const;
  assert.equal(proactive.emitInitiativeSignal(p.userId, expired), 'queued');
  assert.equal(proactive.emitInitiativeSignal(p.userId, expired), 'duplicate');
  proactive.initiativeTick(now());
  assert.equal(systemTexts(p.botId).length, 1);
  assert.match(systemTexts(p.botId)[0], /The slack connection expired/);

  const off = person('off');
  assert.equal(proactive.emitInitiativeSignal(off.userId, { ...expired, connectionId: 'ca_3' }), 'suppressed');
  assert.equal(proactive.emitInitiativeSignal('usr_nobody', expired), 'no-primary');
});

test('a signal queued before the level dropped is dropped, not held for later', () => {
  const p = person('proactive');
  appendRow(p.botId, 'message', { type: 'message', role: 'user', text: 'busy' });
  const t0 = now();
  proactive.emitInitiativeSignal(p.userId, { kind: 'card_waiting', botId: p.botId, botName: 'Atlas', generation: 1, seq: 99, title: 'x', since: t0 - 2 * HOUR }, t0);
  db.prepare("UPDATE bots SET initiative='reactive' WHERE id=?").run(p.botId);
  proactive.initiativeTick(t0 + HOUR);
  db.prepare("UPDATE bots SET initiative='proactive' WHERE id=?").run(p.botId);
  proactive.initiativeTick(t0 + 2 * HOUR);
  assert.equal(systemTexts(p.botId).filter((t) => t.includes(': x')).length, 0);
});

test('scheduled check-ins follow the level; "check in now" is the person asking', () => {
  const p = person('reactive', now() - 100 * HOUR);
  proactive.fireCheckin(p.userId);
  assert.equal(systemTexts(p.botId).length, 0);
  proactive.fireCheckin(p.userId, 0, true);
  assert.equal(systemTexts(p.botId).length, 1);
  assert.match(systemTexts(p.botId)[0], /^\[check-in\]/);
});

test('every person gets one Morning Briefing, off, at 8am on weekdays, and a deleted one stays deleted', async () => {
  const p = person();
  proactive.setCheckins(p.userId, { timezone: 'Europe/Paris' });
  proactive.seedMorningBriefings();
  proactive.seedMorningBriefings();

  const briefings = db.prepare("SELECT * FROM routines WHERE bot_id=? AND name='Morning Briefing'").all(p.botId) as { id: string; enabled: number; schedule: string; timezone: string }[];
  assert.equal(briefings.length, 1, 'seeding twice makes one');
  assert.equal(briefings[0].enabled, 0);
  assert.equal(briefings[0].schedule, '0 8 * * 1-5');
  assert.equal(briefings[0].timezone, 'Europe/Paris');
  assert.equal((db.prepare("SELECT COUNT(*) c FROM routines WHERE bot_id=?").get(p.laterPrimary) as { c: number }).c, 0, 'only the first primary gets one');

  const get = await app.request('/api/initiative', { headers: authed(p.userId) });
  assert.deepEqual((await get.json() as { briefing: unknown }).briefing, { routineId: briefings[0].id, enabled: false, time: '08:00', timezone: 'Europe/Paris' });

  // What DELETE /api/routines/:id does to the table (the route also needs the trigger scheduler, which this suite does not start).
  db.prepare('DELETE FROM routines WHERE id=?').run(briefings[0].id);
  proactive.seedMorningBriefings();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM routines WHERE bot_id=? AND name='Morning Briefing'").get(p.botId) as { c: number }).c, 0);

  const on = await app.request('/api/initiative', { method: 'PUT', headers: authed(p.userId), body: JSON.stringify({ briefing: { enabled: true, time: '07:30', timezone: 'America/New_York' } }) });
  assert.equal(on.status, 200);
  const settings = (await on.json()) as { briefing: { routineId: string; enabled: boolean; time: string; timezone: string } };
  assert.equal(settings.briefing.enabled, true);
  assert.equal(settings.briefing.time, '07:30');
  assert.equal(settings.briefing.timezone, 'America/New_York');
  assert.equal((db.prepare('SELECT schedule FROM routines WHERE id=?').get(settings.briefing.routineId) as { schedule: string }).schedule, '30 7 * * 1-5');
});

test('changing the briefing time keeps its days, and bad input is refused', async () => {
  const p = person();
  proactive.seedMorningBriefings();
  const { routineId } = proactive.getInitiativeSettings(p.userId).briefing;
  db.prepare("UPDATE routines SET schedule='0 8 * * *' WHERE id=?").run(routineId);

  const put = (body: unknown) => app.request('/api/initiative', { method: 'PUT', headers: authed(p.userId), body: JSON.stringify(body) });
  assert.equal((await put({ briefing: { time: '06:45' } })).status, 200);
  assert.equal((db.prepare('SELECT schedule FROM routines WHERE id=?').get(routineId) as { schedule: string }).schedule, '45 6 * * *');

  assert.equal((await put({ briefing: { time: '6:45pm' } })).status, 400);
  assert.equal((await put({ briefing: { timezone: 'Mars/Olympus' } })).status, 400);
  assert.equal((await put({ idleHours: -1 })).status, 400);
  assert.equal((await put({ idleHours: 1.5 })).status, 400);
});

test("a scheduled briefing waits on its Bot's level; the briefing prompt carries open tasks and waiting cards", () => {
  const p = person('proactive');
  proactive.seedMorningBriefings();
  const { routineId } = proactive.getInitiativeSettings(p.userId).briefing;
  const other = createRoutine({ botId: p.botId, title: 'Other', prompt: 'Other.', eventType: 'recurring', schedule: '0 9 * * *' });
  routineIds.add(other.id);

  assert.equal(scheduledRunAllowed(routineId!), true);
  db.prepare("UPDATE bots SET initiative='reactive' WHERE id=?").run(p.botId);
  assert.equal(scheduledRunAllowed(routineId!), false);
  assert.equal(scheduledRunAllowed(other.id), true, 'other routines are not gated');

  db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES ('tsk_init_1',?,'Sign the lease','needs_input',?,?)").run(p.laterPrimary, now(), now());
  appendRow(p.botId, 'card', { type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'to read mail', status: 'pending' });
  runRoutine(routineId!);
  const run = turns.find((t) => t.trigger.type === 'routine');
  assert.ok(run && run.trigger.type === 'routine');
  assert.match(run.trigger.prompt, /Open tasks:\n- Sign the lease \(Robin, needs the user\)/);
  assert.match(run.trigger.prompt, /Waiting on the user:\n- Atlas: Connect Gmail/);
});

test('PATCH /api/bots/:id sets the initiative level and refuses anything else', async () => {
  const p = person();
  const patch = (initiative: string) => app.request(`/api/bots/${p.botId}`, { method: 'PATCH', headers: authed(p.userId), body: JSON.stringify({ initiative }) });
  const ok = await patch('reactive');
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { bot: { initiative: string } }).bot.initiative, 'reactive');
  assert.equal((await patch('loud')).status, 400);
  const bots = (await (await app.request('/api/bots', { headers: authed(p.userId) })).json()) as { bots: { id: string; initiative: string }[] };
  assert.equal(bots.bots.find((b) => b.id === p.botId)?.initiative, 'reactive');
  assert.equal(bots.bots.find((b) => b.id === p.laterPrimary)?.initiative, 'proactive', 'new bots default to proactive');
});

test('a restarted server does not repeat a signal the last one delivered', async () => {
  const p = person();
  failedRoutine(p.botId, 'Nightly backup');
  proactive.initiativeTick(now());
  assert.equal(systemTexts(p.botId).length, 1);

  // A second module instance keeps none of the first one's memory, as after a restart; the database file is the same.
  const restarted = (await import(`../proactive.js?restart=${Date.now()}`)) as typeof proactive;
  assert.notEqual(restarted, proactive, 'a fresh module instance');
  restarted.setProactiveEnqueue((botId, trigger) => turns.push({ botId, trigger }));
  restarted.initiativeTick(now() + 10 * 60_000);
  assert.equal(systemTexts(p.botId).length, 1);
});
