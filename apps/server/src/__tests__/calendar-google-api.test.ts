// api-env must be the FIRST import: it points env.ts at a temp database before env.ts reads process.env.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import type { CalendarResponse } from '@orbit/contracts';

process.env.COMPOSIO_API_KEY = '';
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();
const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { mcpToken } = await import('../engine.js');
const { composioIO } = await import('../composio.js');
const { syncCalendar } = await import('../calendar/mirror.js');

const app = createApp();
after(() => cleanupTmpEnv());

/**
 * One calendar for Google and Orbit, over the real routes with a fake Google: the merged view, the
 * person's own Google changes from Orbit (create, change with a scope, delete), and calendar_list for
 * bots over MCP.
 */

type Json = Record<string, any>;
const PRIMARY = 'me@example.test';
const google: Record<string, Json> = {};
const ran: { slug: string; args: Json }[] = [];
const iso = (d: string) => new Date(d).toISOString();
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

google.ev1 = { id: 'ev1', status: 'confirmed', summary: 'Design review', location: 'Room 2', attendees: [{ email: 'kim@x.test' }], start: { dateTime: iso(`${day(1)}T15:00:00Z`), timeZone: 'UTC' }, end: { dateTime: iso(`${day(1)}T16:00:00Z`), timeZone: 'UTC' } };

composioIO.runAction = async (_u, slug, args) => {
  ran.push({ slug, args });
  if (slug === 'GOOGLECALENDAR_LIST_CALENDARS') return { successful: true, data: { calendars: [{ id: PRIMARY, summary: 'Me', primary: true, backgroundColor: '#4285f4' }] }, error: null };
  if (slug === 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS') return { successful: true, data: { events: Object.values(google).map((event) => ({ event, source_calendar_id: PRIMARY })), errors_by_calendar: {} }, error: null };
  if (slug === 'GOOGLECALENDAR_EVENTS_GET') return google[String(args.event_id)] ? { successful: true, data: google[String(args.event_id)], error: null } : { successful: false, data: null, error: 'nf' };
  if (slug === 'GOOGLECALENDAR_CREATE_EVENT') {
    const id = `new${Object.keys(google).length}`;
    google[id] = { id, status: 'confirmed', summary: args.summary, start: { dateTime: iso(`${String(args.start_datetime)}Z`), timeZone: 'UTC' }, end: { dateTime: iso(`${String(args.end_datetime)}Z`), timeZone: 'UTC' } };
    return { successful: true, data: { response_data: google[id] }, error: null };
  }
  if (slug === 'GOOGLECALENDAR_PATCH_EVENT') {
    const e = google[String(args.event_id)];
    if (typeof args.location === 'string') e.location = args.location;
    if (typeof args.summary === 'string') e.summary = args.summary;
    return { successful: true, data: e, error: null };
  }
  if (slug === 'GOOGLECALENDAR_DELETE_EVENT') { delete google[String(args.event_id)]; return { successful: true, data: {}, error: null }; }
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
const calendar = async (cookie: string) => (await (await req(cookie, 'GET', `/api/calendar?from=${day(-1)}&to=${day(10)}`)).json()) as CalendarResponse;

test('one calendar for Google and Orbit', async (t) => {
  const { cookie, botId, userId } = await signIn('cal-google@example.test');
  await syncCalendar(userId);

  await t.test('the calendar returns Google events beside routines, with their calendar and real length', async () => {
    // Written directly: the routes would also schedule it, which a test process must not leave running.
    db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,calendar_title,event_type,event_date) VALUES (?,?,?,?,?,?,1,?,?,?,?)")
      .run('rtn_prep', botId, 'Prep notes', 'Prepare', '0 14 * * *', 'UTC', Date.now(), 'Prep notes', 'one_time', `${day(1)}T14:00:00.000Z`);
    const res = await calendar(cookie);
    assert.equal(res.events.length, 1);
    const [g] = res.google!;
    assert.deepEqual([g.title, g.calendarName, g.color, g.location, g.attendees, g.allDay], ['Design review', 'Me', '#4285f4', 'Room 2', ['kim@x.test'], false]);
    assert.equal(Date.parse(g.end) - Date.parse(g.start), 3600_000);
    assert.deepEqual([res.googleState?.available, res.googleState?.connected], [true, true]);
    assert.equal('id' in (g as Json), false, 'the Google ids stay on the server');
  });

  await t.test('the person creates a Google event from Orbit; it appears', async () => {
    ran.length = 0;
    const r = await req(cookie, 'POST', '/api/calendar/google/events', { fields: { summary: 'Dentist', description: '', location: '', start: `${day(2)}T09:00`, end: `${day(2)}T09:30`, allDay: false, timezone: 'UTC', attendees: [], meet: false } });
    assert.equal(r.status, 201);
    const create = ran.find((x) => x.slug === 'GOOGLECALENDAR_CREATE_EVENT')!;
    assert.deepEqual([create.args.calendar_id, create.args.summary, create.args.start_datetime], [PRIMARY, 'Dentist', `${day(2)}T09:00:00`]);
    assert.ok((await calendar(cookie)).google!.some((e) => e.title === 'Dentist'));
  });

  await t.test('an event that ends before it starts is refused', async () => {
    const r = await req(cookie, 'POST', '/api/calendar/google/events', { fields: { summary: 'Bad', description: '', location: '', start: `${day(2)}T09:00`, end: `${day(2)}T08:00`, allDay: false, timezone: 'UTC', attendees: [], meet: false } });
    assert.equal(r.status, 400);
  });

  await t.test('changing one sends only what changed, as a patch', async () => {
    const key = (await calendar(cookie)).google!.find((e) => e.title === 'Design review')!.key;
    ran.length = 0;
    assert.equal((await req(cookie, 'PATCH', `/api/calendar/google/events/${key}`, { edits: { location: 'Room 9' } })).status, 200);
    const patch = ran.find((x) => x.slug === 'GOOGLECALENDAR_PATCH_EVENT')!;
    assert.deepEqual(Object.keys(patch.args).sort(), ['calendar_id', 'event_id', 'location', 'send_updates']);
    assert.equal((await calendar(cookie)).google!.find((e) => e.title === 'Design review')?.location, 'Room 9');
  });

  await t.test('deleting one removes it from Google and from the calendar', async () => {
    const key = (await calendar(cookie)).google!.find((e) => e.title === 'Dentist')!.key;
    assert.equal((await req(cookie, 'DELETE', `/api/calendar/google/events/${key}?notify=0`)).status, 200);
    assert.equal((await calendar(cookie)).google!.some((e) => e.title === 'Dentist'), false);
  });

  await t.test('an unknown event, and another person\'s, is not found', async () => {
    assert.equal((await req(cookie, 'PATCH', '/api/calendar/google/events/nope', { edits: { location: 'x' } })).status, 404);
    const key = (await calendar(cookie)).google![0].key;
    const other = await signIn('cal-google-other@example.test');
    assert.equal((await req(other.cookie, 'DELETE', `/api/calendar/google/events/${key}`)).status, 404);
    assert.deepEqual((await calendar(other.cookie)).google, []);
  });

  await t.test('the calendar list can turn a calendar off', async () => {
    const g = (await (await req(cookie, 'GET', '/api/calendar/google')).json()) as Json;
    assert.equal(g.calendars.length, 1);
    assert.equal('id' in g.calendars[0], false, 'the calendar id (an email address) stays on the server');
    assert.equal((await req(cookie, 'PATCH', `/api/calendar/google/${g.calendars[0].key}`, { enabled: false })).status, 200);
    assert.deepEqual((await calendar(cookie)).google, []);
    await req(cookie, 'PATCH', `/api/calendar/google/${g.calendars[0].key}`, { enabled: true });
    await syncCalendar(userId);
  });

  await t.test('a bot reads both kinds with calendar_list', async () => {
    const r = await app.request(`/mcp/${botId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(botId)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calendar_list', arguments: { from: day(0), to: day(3) } } }),
    });
    const out = JSON.parse(((await r.json()) as Json).result.content[0].text);
    assert.ok(out.google.some((e: Json) => e.title === 'Design review' && e.location === 'Room 9' && e.calendar === 'Me'));
    assert.ok(out.routines.some((e: Json) => e.title === 'Prep notes'));
  });

  await t.test('a bot whose person just connected Calendar gets events, not "not connected"', async () => {
    const fresh = await signIn('cal-google-fresh@example.test');
    composioIO.connected = async () => new Set(['googlecalendar']);
    try {
      const r = await app.request(`/mcp/${fresh.botId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(fresh.botId)}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calendar_list', arguments: { from: day(0), to: day(3) } } }),
      });
      const out = JSON.parse(((await r.json()) as Json).result.content[0].text);
      assert.ok(Array.isArray(out.google), `got ${JSON.stringify(out.google)}`);
      assert.ok(out.google.some((e: Json) => e.title === 'Design review'));
    } finally {
      composioIO.connected = async () => new Set();
    }
  });
});
