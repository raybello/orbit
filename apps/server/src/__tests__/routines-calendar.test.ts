import './helpers/tmp-env.js'; // must be first: points DB_PATH/HERMES_HOME_PRIMARY at a temp dir
import assert from 'node:assert/strict';
import test from 'node:test';

// Loaded after the temp env exists, so db.ts opens the throwaway database.
const { db, now } = await import('../db.js');
const { createRoutine, runRoutine, unscheduleRoutine, setRoutineEnqueue } = await import('../routines.js');
const { calendarApi, parseCalendarBound } = await import('../routes-calendar.js');
const { issueSessionToken } = await import('../lib/auth.js');

const USER = 'usr_calendar_test';
const OTHER_USER = 'usr_calendar_other';
const BOT = 'bot_calendar_test';
const OTHER_BOT = 'bot_calendar_second';

const t0 = now();
db.prepare('INSERT INTO users(id,email,name,avatar_url,created_at) VALUES (?,?,?,?,?)').run(USER, 'cal@example.test', 'Calendar Tester', null, t0);
db.prepare('INSERT INTO users(id,email,name,avatar_url,created_at) VALUES (?,?,?,?,?)').run(OTHER_USER, 'other@example.test', 'Someone Else', null, t0);
const insertBot = db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)');
insertBot.run(BOT, USER, 'Douglas', t0, t0);
insertBot.run(OTHER_BOT, USER, 'Robin', t0, t0);

// Cron jobs created by createRoutine hold timers; drop them when this file's tests end.
const created = new Set<string>();
test.after(() => {
  for (const id of created) unscheduleRoutine(id);
});

const authHeaders = () => {
  const { token } = issueSessionToken(USER);
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
};

const rowOf = (id: string) => db.prepare('SELECT * FROM routines WHERE id=?').get(id) as any;

test('a one_time routine is stored with its date, enabled, and a one-shot cron', () => {
  const r = createRoutine({
    botId: BOT,
    title: 'Dentist',
    prompt: 'Remind me about the dentist appointment.',
    eventType: 'one_time',
    eventDate: '2026-06-15T14:30:00.000Z',
  });
  created.add(r.id);

  const row = rowOf(r.id);
  assert.equal(row.event_type, 'one_time');
  assert.equal(row.enabled, 1);
  assert.equal(row.event_date, '2026-06-15T14:30:00.000Z');
  assert.equal(row.schedule, '30 14 15 6 *');
  assert.equal(row.calendar_title, 'Dentist');
  assert.equal(row.completed_at, null);

  assert.equal(r.eventType, 'one_time');
  assert.equal(r.calendarTitle, 'Dentist');
  assert.equal(r.completedAt, null);
});

test('a recurring routine keeps its cron and rejects a bad one', () => {
  const r = createRoutine({ botId: BOT, title: 'Standup', prompt: 'Write the standup notes.', eventType: 'recurring', schedule: '0 9 * * 1-5' });
  created.add(r.id);
  const row = rowOf(r.id);
  assert.equal(row.event_type, 'recurring');
  assert.equal(row.schedule, '0 9 * * 1-5');
  assert.equal(row.event_date, null);

  assert.throws(() => createRoutine({ botId: BOT, title: 'Bad', prompt: 'x', eventType: 'recurring', schedule: 'every morning' }), /Invalid cron schedule/);
  assert.throws(() => createRoutine({ botId: BOT, title: 'Bad', prompt: 'x', eventType: 'one_time', eventDate: 'tomorrow' }), /valid ISO eventDate/);
  assert.throws(() => createRoutine({ botId: BOT, title: 'Bad', prompt: '  ', eventType: 'recurring', schedule: '0 9 * * *' }), /prompt/);
});

test('running a one_time routine completes it and disables it', () => {
  const r = createRoutine({ botId: BOT, title: 'Pay rent', prompt: 'Pay the rent.', eventType: 'one_time', eventDate: '2026-04-01T09:00:00.000Z' });
  created.add(r.id);

  const calls: { botId: string; turn: any }[] = [];
  setRoutineEnqueue((botId, turn) => calls.push({ botId, turn }));
  runRoutine(r.id);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].botId, BOT);
  assert.equal(calls[0].turn.type, 'routine');

  const row = rowOf(r.id);
  assert.equal(row.enabled, 0);
  assert.ok(row.completed_at, 'completed_at is set');
  assert.ok(!Number.isNaN(new Date(row.completed_at).getTime()));
});

test('a one_time routine assigned to another bot enqueues there', () => {
  const r = createRoutine({ botId: BOT, title: 'Deck review', prompt: 'Review the deck.', eventType: 'one_time', eventDate: '2026-05-04T16:00:00.000Z' });
  created.add(r.id);
  db.prepare('UPDATE routines SET assigned_bot_id=? WHERE id=?').run(OTHER_BOT, r.id);

  const calls: { botId: string; turn: any }[] = [];
  setRoutineEnqueue((botId, turn) => calls.push({ botId, turn }));
  runRoutine(r.id);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].botId, OTHER_BOT);
});

test('GET /api/calendar expands a recurring routine inside the window only', async () => {
  const r = createRoutine({ botId: BOT, title: 'Weekday standup', prompt: 'Post the standup.', eventType: 'recurring', schedule: '0 9 * * 1-5', timezone: 'UTC' });
  created.add(r.id);

  // Mon 2026-03-02 .. Sat 2026-03-07 => Mon-Fri only.
  const res = await calendarApi.request('/calendar?from=2026-03-02T00:00:00.000Z&to=2026-03-07T00:00:00.000Z', { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { events: any[] };
  const mine = body.events.filter((e) => e.routineId === r.id);

  assert.deepEqual(mine.map((e) => e.start), [
    '2026-03-02T09:00:00.000Z',
    '2026-03-03T09:00:00.000Z',
    '2026-03-04T09:00:00.000Z',
    '2026-03-05T09:00:00.000Z',
    '2026-03-06T09:00:00.000Z',
  ]);
  assert.equal(mine[0].end, '2026-03-02T09:30:00.000Z');
  assert.equal(mine[0].recurrenceRule, '0 9 * * 1-5');
  assert.equal(mine[0].eventType, 'recurring');
  assert.equal(mine[0].botName, 'Douglas');
  assert.equal(mine[0].title, 'Weekday standup');

  // Sorted ascending overall.
  const starts = body.events.map((e) => e.start);
  assert.deepEqual(starts, [...starts].sort());

  // A later week is outside the window entirely.
  const later = await calendarApi.request('/calendar?from=2026-03-16T00:00:00.000Z&to=2026-03-17T00:00:00.000Z', { headers: authHeaders() });
  const laterBody = (await later.json()) as { events: any[] };
  assert.equal(laterBody.events.filter((e) => e.routineId === r.id).length, 1);
});

test('a one_time event appears only inside its own window', async () => {
  const r = createRoutine({ botId: BOT, title: 'Dentist visit', prompt: 'Go to the dentist.', eventType: 'one_time', eventDate: '2026-06-15T14:30:00.000Z' });
  created.add(r.id);

  const window = async (from: string, to: string) => {
    const res = await calendarApi.request(`/calendar?from=${from}&to=${to}`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    return ((await res.json()) as { events: any[] }).events.filter((e) => e.routineId === r.id);
  };

  assert.equal((await window('2026-06-14T00:00:00.000Z', '2026-06-15T00:00:00.000Z')).length, 0);
  assert.equal((await window('2026-06-16T00:00:00.000Z', '2026-06-18T00:00:00.000Z')).length, 0);

  const inside = await window('2026-06-15T00:00:00.000Z', '2026-06-16T00:00:00.000Z');
  assert.equal(inside.length, 1);
  assert.equal(inside[0].start, '2026-06-15T14:30:00.000Z');
  assert.equal(inside[0].end, '2026-06-15T15:00:00.000Z');
  assert.equal(inside[0].recurrenceRule, null);
  assert.equal(inside[0].eventType, 'one_time');
});

test('GET /api/calendar takes bare dates as local day bounds and rejects junk', async () => {
  const from = parseCalendarBound('2026-03-02', 'start', new Date(0))!;
  const to = parseCalendarBound('2026-03-02', 'end', new Date(0))!;
  assert.equal(from.getHours(), 0);
  assert.equal(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(parseCalendarBound('2026-02-31', 'start', new Date(0)), null);
  assert.equal(parseCalendarBound('not-a-date', 'start', new Date(0)), null);

  const bad = await calendarApi.request('/calendar?from=yesterday&to=tomorrow', { headers: authHeaders() });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).error, /from must be/);

  const backwards = await calendarApi.request('/calendar?from=2026-03-05&to=2026-03-01', { headers: authHeaders() });
  assert.equal(backwards.status, 400);

  const anonymous = await calendarApi.request('/calendar?from=2026-03-01&to=2026-03-02');
  assert.equal(anonymous.status, 401);
});

test('GET /api/calendar caps occurrences per routine', async () => {
  const r = createRoutine({ botId: BOT, title: 'Every minute', prompt: 'Ping.', eventType: 'recurring', schedule: '* * * * *', timezone: 'UTC' });
  created.add(r.id);

  // A whole day at one-a-minute is 1440 occurrences; the route must not return them all.
  const res = await calendarApi.request('/calendar?from=2026-03-10T00:00:00.000Z&to=2026-03-11T00:00:00.000Z', { headers: authHeaders() });
  assert.equal(res.status, 200);
  const mine = ((await res.json()) as { events: any[] }).events.filter((e) => e.routineId === r.id);
  assert.equal(mine.length, 200);
  assert.equal(mine[0].start, '2026-03-10T00:00:00.000Z');
  assert.equal(mine[199].start, '2026-03-10T03:19:00.000Z');
});

test('POST /api/routines creates a calendar event and refuses other users\' bots', async () => {
  const res = await calendarApi.request('/routines', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ botId: BOT, title: 'Weekly review', prompt: 'Summarise the week.', eventType: 'recurring', schedule: '0 17 * * 5', timezone: 'UTC' }),
  });
  assert.equal(res.status, 201);
  const { routine } = (await res.json()) as { routine: any };
  created.add(routine.id);
  assert.equal(routine.eventType, 'recurring');
  assert.equal(routine.calendarTitle, 'Weekly review');
  assert.equal(routine.enabled, true);

  const listed = await calendarApi.request('/calendar?from=2026-03-02T00:00:00.000Z&to=2026-03-09T00:00:00.000Z', { headers: authHeaders() });
  const events = ((await listed.json()) as { events: any[] }).events.filter((e) => e.routineId === routine.id);
  assert.deepEqual(events.map((e) => e.start), ['2026-03-06T17:00:00.000Z']);

  const foreign = await calendarApi.request('/routines', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ botId: 'bot_not_mine', title: 'x', prompt: 'x', eventType: 'recurring', schedule: '0 9 * * *' }),
  });
  assert.equal(foreign.status, 404);

  const badCron = await calendarApi.request('/routines', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ botId: BOT, title: 'x', prompt: 'x', eventType: 'recurring', schedule: 'every day' }),
  });
  assert.equal(badCron.status, 400);

  const noPrompt = await calendarApi.request('/routines', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ botId: BOT, eventType: 'one_time', eventDate: '2026-06-15T14:30:00.000Z' }),
  });
  assert.equal(noPrompt.status, 400);
});
