// api-env must be the FIRST import: it points env.ts at a temp database before env.ts reads process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import type { CalendarResponse, DuplicateDefaults } from '@orbit/contracts';

process.env.COMPOSIO_API_KEY = '';
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();
const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { composioIO } = await import('../composio.js');
const { syncCalendar } = await import('../calendar/mirror.js');
const { rruleToCron } = await import('../calendar/links.js');
const { runRoutine, setRoutineEnqueue, unscheduleRoutine } = await import('../routines.js');

const app = createApp();
const created: string[] = [];
after(() => { for (const id of created) unscheduleRoutine(id); cleanupTmpEnv(); });

/**
 * Duplicating a Google event as an Orbit event: the repeat rule as cron where cron can say it, the
 * link and its offset, following the parent when it moves, pausing when it is cancelled, and the
 * parent's details reaching the bot when the Orbit event runs.
 */

test('a Google repeat rule becomes cron only where cron can say it', () => {
  const at = '2026-11-19T09:30'; // a Thursday
  const ok = (rule: string, cron: string) => assert.deepEqual(rruleToCron([`RRULE:${rule}`], at), { cron }, rule);
  const no = (rule: string, why: RegExp) => { const r = rruleToCron([`RRULE:${rule}`], at); assert.ok('reason' in r && why.test(r.reason), rule); };
  ok('FREQ=DAILY', '30 9 * * *');
  ok('FREQ=WEEKLY', '30 9 * * 4');
  ok('FREQ=WEEKLY;BYDAY=FR,MO,WE', '30 9 * * 1,3,5');
  ok('FREQ=MONTHLY', '30 9 19 * *');
  ok('FREQ=MONTHLY;BYMONTHDAY=1', '30 9 1 * *');
  ok('FREQ=YEARLY', '30 9 19 11 *');
  ok('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU', '30 9 * * 2');
  no('FREQ=WEEKLY;INTERVAL=2', /every 2/);
  no('FREQ=MONTHLY;BYDAY=1MO', /weekday of the month/);
  no('FREQ=WEEKLY;COUNT=10', /ends on a set date/);
  no('FREQ=WEEKLY;UNTIL=20270101T000000Z', /ends on a set date/);
  assert.ok('reason' in rruleToCron(['RRULE:FREQ=WEEKLY', 'EXDATE:20261126T093000Z'], at));
});

type Json = Record<string, any>;
const PRIMARY = 'me@example.test';
const google: Record<string, Json> = {};
const iso = (ms: number) => new Date(ms).toISOString();
const T = Date.now() + 3 * 86_400_000;
google.meet = { id: 'meet', status: 'confirmed', summary: 'Board meeting', location: 'HQ', attendees: [{ email: 'cfo@x.test' }], description: 'Q4 numbers', start: { dateTime: iso(T), timeZone: 'UTC' }, end: { dateTime: iso(T + 3600_000), timeZone: 'UTC' } };
google.inst = { id: 'inst', recurringEventId: 'ser', status: 'confirmed', summary: 'Standup', start: { dateTime: iso(T), timeZone: 'UTC' }, end: { dateTime: iso(T + 900_000), timeZone: 'UTC' } };
const series = { id: 'ser', summary: 'Standup', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH'], start: { dateTime: iso(T), timeZone: 'UTC' } };

composioIO.runAction = async (_u, slug, args) => {
  if (slug === 'GOOGLECALENDAR_LIST_CALENDARS') return { successful: true, data: { calendars: [{ id: PRIMARY, summary: 'Work', primary: true }] }, error: null };
  if (slug === 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS') return { successful: true, data: { events: Object.values(google).map((event) => ({ event, source_calendar_id: PRIMARY })), errors_by_calendar: {} }, error: null };
  if (slug === 'GOOGLECALENDAR_EVENTS_GET' && args.event_id === 'ser') return { successful: true, data: series, error: null };
  return { successful: false, data: null, error: `unexpected ${slug}` };
};

async function signIn(email: string) {
  const r = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const bots = ((await (await app.request('/api/bots', { headers: { cookie } })).json()) as Json).bots as Json[];
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string }).id;
  return { cookie, botId: String(bots[0].id), userId };
}
const req = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const calendar = async (cookie: string) => (await (await req(cookie, 'GET', `/api/calendar?from=${day(-1)}&to=${day(10)}`)).json()) as CalendarResponse;
const routine = (id: string) => db.prepare('SELECT * FROM routines WHERE id=?').get(id) as Json;
const botEvents = (botId: string) => (db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='event' ORDER BY seq").all(botId) as { body: string }[]).map((r) => JSON.parse(r.body).text as string);

test('duplicating a Google event as an Orbit event', async (t) => {
  const { cookie, botId, userId } = await signIn('links@example.test');
  await syncCalendar(userId);
  const key = (title: string) => (async () => (await calendar(cookie)).google!.find((e) => e.title === title)!.key)();
  let rid = '';

  await t.test('the defaults: the event\'s title and time, and the prepare-me prompt', async () => {
    const d = (await (await req(cookie, 'GET', `/api/calendar/google/events/${await key('Board meeting')}/duplicate`)).json()) as DuplicateDefaults;
    assert.deepEqual([d.title, d.start, d.recurring, d.cron], ['Board meeting', iso(T), false, null]);
    assert.match(d.prompt, /^Prepare me for “Board meeting” at .+: check the attendees, related email threads and docs, and send me a short brief\.$/);
  });

  await t.test('a repeating event offers its repeat as cron', async () => {
    const d = (await (await req(cookie, 'GET', `/api/calendar/google/events/${await key('Standup')}/duplicate`)).json()) as DuplicateDefaults;
    assert.equal(d.recurring, true);
    const hm = `${new Date(T).getUTCMinutes()} ${new Date(T).getUTCHours()}`;
    assert.equal(d.cron, `${hm} * * * 1,4`.replace('* * * ', '* * '));
  });

  await t.test('made 15 minutes before its parent, it is linked and shows the parent on the calendar', async () => {
    const r = await req(cookie, 'POST', '/api/routines', { botId, title: 'Prep: Board meeting', prompt: 'Prepare me', eventType: 'one_time', eventDate: iso(T - 15 * 60_000), timezone: 'UTC', parentEventKey: await key('Board meeting') });
    assert.equal(r.status, 201);
    rid = ((await r.json()) as Json).routine.id;
    created.push(rid);
    assert.equal(routine(rid).parent_offset_ms, -15 * 60_000);
    assert.equal(String(routine(rid).parent_sealed).includes('Board'), false, 'the parent snapshot is sealed');
    const ev = (await calendar(cookie)).events.find((e) => e.routineId === rid)!;
    assert.equal(ev.parentTitle, 'Board meeting');
  });

  await t.test('an unknown parent is refused', async () => {
    const r = await req(cookie, 'POST', '/api/routines', { botId, title: 'x', prompt: 'x', eventType: 'one_time', eventDate: iso(T), parentEventKey: 'nope' });
    assert.equal(r.status, 404);
  });

  await t.test('when it runs, the bot gets the parent\'s details', async () => {
    let prompt = '';
    setRoutineEnqueue((_bot, turn) => { prompt = (turn as { prompt: string }).prompt; });
    db.prepare("UPDATE routines SET event_type='recurring' WHERE id=?").run(rid);
    runRoutine(rid);
    db.prepare("UPDATE routines SET event_type='one_time', completed_at=NULL, enabled=1 WHERE id=?").run(rid);
    assert.match(prompt, /made from the user's Google Calendar event “Board meeting”/);
    assert.match(prompt, /Where: HQ/);
    assert.match(prompt, /Guests: cfo@x\.test/);
    assert.match(prompt, /Event notes: Q4 numbers/);
  });

  await t.test('when the parent moves, the one-time Orbit event moves with it and keeps its offset', async () => {
    const moved = T + 2 * 3600_000;
    google.meet = { ...google.meet, start: { dateTime: iso(moved), timeZone: 'UTC' }, end: { dateTime: iso(moved + 3600_000), timeZone: 'UTC' } };
    await syncCalendar(userId);
    assert.equal(routine(rid).event_date, iso(moved - 15 * 60_000));
    assert.ok(botEvents(botId).some((t) => /^Moved “Prep: Board meeting” to .+following the Google event “Board meeting”/.test(t)));
  });

  await t.test('when the parent is cancelled, the Orbit event is paused and the chat says why', async () => {
    google.meet = { ...google.meet, status: 'cancelled' };
    await syncCalendar(userId);
    assert.equal(routine(rid).enabled, 0);
    assert.ok(botEvents(botId).some((t) => t === 'Paused “Prep: Board meeting”: the Google event “Board meeting” it was made from was cancelled.'));
  });
});
