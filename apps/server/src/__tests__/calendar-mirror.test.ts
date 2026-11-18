// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv, tmpRoot } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

process.env.COMPOSIO_API_KEY = '';
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { db, now } = await import('../db.js');
const { env } = await import('../env.js');
const { composioIO } = await import('../composio.js');
const mirror = await import('../calendar/mirror.js');

after(() => cleanupTmpEnv());

/**
 * The Google Calendar mirror against a fake Google: what is kept, what is shown, what changes are
 * noticed, and above all what is on disk. Nothing that names a calendar or describes an event may be
 * readable in the database file.
 */

const USER = 'u_cal';
db.prepare('INSERT OR IGNORE INTO users(id,name,email,created_at) VALUES (?,?,?,?)').run(USER, 'Cal', 'cal@example.test', now());

const PRIMARY = 'ada.lovelace@analytical.example';
const HOLIDAYS = 'en.canadian#holiday@group.v.calendar.google.com';
const T0 = Date.parse('2026-11-18T12:00:00Z');

type Ev = Record<string, unknown>;
let calendars: Ev[];
let events: { cal: string; event: Ev }[];
let errors: Record<string, unknown>;
let failList = false;
const calls: string[] = [];

const meeting = (id: string, startIso: string, over: Ev = {}): Ev => ({
  id, status: 'confirmed', summary: 'Secret Board Meeting', description: 'Acquisition of Babbage Ltd', location: 'Engine Room 42',
  attendees: [{ email: 'charles.babbage@engine.example' }], htmlLink: `https://calendar.google.com/event?eid=${id}`, hangoutLink: 'https://meet.google.com/abc-defg-hij',
  start: { dateTime: startIso, timeZone: 'Europe/London' }, end: { dateTime: new Date(Date.parse(startIso) + 3600_000).toISOString(), timeZone: 'Europe/London' }, ...over,
});

beforeEach(() => {
  calendars = [
    { id: PRIMARY, summary: PRIMARY, primary: true, backgroundColor: '#9fe1e7' },
    { id: HOLIDAYS, summary: 'Holidays in Canada', backgroundColor: '#16a765' },
  ];
  events = [
    { cal: PRIMARY, event: meeting('evt_board_1', '2026-11-20T10:00:00Z') },
    { cal: PRIMARY, event: { id: 'evt_allday', status: 'confirmed', summary: 'Offsite day', start: { date: '2026-11-25' }, end: { date: '2026-11-26' } } },
  ];
  errors = {};
  failList = false;
  calls.length = 0;
  composioIO.runAction = async (_u, slug, args) => {
    calls.push(slug);
    if (slug === 'GOOGLECALENDAR_LIST_CALENDARS') return failList ? { successful: false, data: null, error: 'quota' } : { successful: true, data: { calendars }, error: null };
    if (slug === 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS') {
      const ids = args.calendar_ids as string[];
      assert.equal(args.response_detail, 'full', 'the default answer is only a summary');
      assert.equal(args.single_events, true);
      assert.equal(args.show_deleted, true);
      return { successful: true, data: { events: events.filter((e) => ids.includes(e.cal)).map((e) => ({ event: e.event, source_calendar_id: e.cal })), errors_by_calendar: errors }, error: null };
    }
    return { successful: false, data: null, error: `unexpected ${slug}` };
  };
  db.prepare('DELETE FROM gcal_events').run();
  db.prepare('DELETE FROM gcal_calendars').run();
  db.prepare('DELETE FROM gcal_sync').run();
});

const window = () => mirror.listMirror(USER, new Date(T0 - 40 * 86_400_000), new Date(T0 + 100 * 86_400_000));

test('the primary calendar is on by default, others off; its events come back whole', async () => {
  assert.deepEqual(await mirror.syncCalendar(USER, T0), { ok: true, changes: 2 });
  const cals = mirror.listCalendars(USER);
  assert.deepEqual(cals.map((c) => [c.name, c.primary, c.enabled]), [[PRIMARY, true, true], ['Holidays in Canada', false, false]]);
  const [board, offsite] = window();
  assert.deepEqual([board.title, board.location, board.attendees, board.meetLink, board.timezone, board.allDay], ['Secret Board Meeting', 'Engine Room 42', ['charles.babbage@engine.example'], 'https://meet.google.com/abc-defg-hij', 'Europe/London', false]);
  assert.deepEqual([offsite.allDay, offsite.start, offsite.end], [true, '2026-11-25T00:00:00.000Z', '2026-11-26T00:00:00.000Z']);
});

test('nothing that names a calendar or describes an event is readable in the database file', async () => {
  await mirror.syncCalendar(USER, T0);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const files = fs.readdirSync(tmpRoot).filter((f) => f.startsWith('test.db')).map((f) => fs.readFileSync(path.join(tmpRoot, f)));
  const disk = Buffer.concat(files).toString('latin1');
  for (const secret of ['Secret Board Meeting', 'Babbage Ltd', 'Engine Room 42', 'charles.babbage', 'ada.lovelace', 'evt_board_1', 'meet.google.com', 'Offsite day', 'Holidays in Canada']) {
    assert.equal(disk.includes(secret), false, `"${secret}" is on disk in plain text`);
  }
});

test('a different key opens nothing, and a sealed row moved to another row does not open', async () => {
  await mirror.syncCalendar(USER, T0);
  const real = env.dbEncryptionKey;
  try {
    (env as { dbEncryptionKey: string }).dbEncryptionKey = crypto.randomBytes(32).toString('hex');
    assert.deepEqual(window(), []);
    assert.deepEqual(mirror.listCalendars(USER), []);
  } finally {
    (env as { dbEncryptionKey: string }).dbEncryptionKey = real;
  }
  const [a, b] = db.prepare('SELECT event_key, sealed FROM gcal_events WHERE user_id=? ORDER BY start_ms').all(USER) as { event_key: string; sealed: string }[];
  db.prepare('UPDATE gcal_events SET sealed=? WHERE event_key=?').run(a.sealed, b.event_key);
  assert.deepEqual(window().map((e) => e.title), ['Secret Board Meeting'], 'the moved copy is refused, not shown as the other event');
});

test('with no key the mirror is off, says why, and stores nothing', async () => {
  const real = env.dbEncryptionKey;
  try {
    (env as { dbEncryptionKey: string }).dbEncryptionKey = '';
    const state = mirror.mirrorState();
    assert.equal(state.available, false);
    assert.match((state as { reason: string }).reason, /DB_ENCRYPTION_KEY/);
    assert.equal((await mirror.syncCalendar(USER, T0)).ok, false);
    assert.equal(calls.length, 0, 'Google is not even asked');
  } finally {
    (env as { dbEncryptionKey: string }).dbEncryptionKey = real;
  }
  assert.equal((db.prepare('SELECT COUNT(*) n FROM gcal_events').get() as { n: number }).n, 0);
});

test('moves, cancellations and disappearances are noticed and passed on', async () => {
  const seen: { kind: string; title: string; from?: string; to?: string }[] = [];
  mirror.onMirrorChanges((_u, changes) => { for (const c of changes) seen.push({ kind: c.kind, title: c.event.title, ...(c.kind === 'changed' ? { from: c.before.start, to: c.event.start } : {}) }); });
  await mirror.syncCalendar(USER, T0);
  seen.length = 0;
  events[0] = { cal: PRIMARY, event: meeting('evt_board_1', '2026-11-20T14:00:00Z') };
  events[1] = { cal: PRIMARY, event: { ...events[1].event, status: 'cancelled' } };
  events.push({ cal: PRIMARY, event: meeting('evt_new', '2026-12-01T09:00:00Z', { summary: 'Retro' }) });
  await mirror.syncCalendar(USER, T0 + 60_000);
  assert.deepEqual(seen, [
    { kind: 'changed', title: 'Secret Board Meeting', from: '2026-11-20T10:00:00.000Z', to: '2026-11-20T14:00:00.000Z' },
    { kind: 'removed', title: 'Offsite day' },
    { kind: 'added', title: 'Retro' },
  ]);
  seen.length = 0;
  events = events.filter((e) => e.event.id !== 'evt_new');
  await mirror.syncCalendar(USER, T0 + 120_000);
  assert.deepEqual(seen, [{ kind: 'removed', title: 'Retro' }], 'gone from Google means gone here');
  seen.length = 0;
  await mirror.syncCalendar(USER, T0 + 180_000);
  assert.deepEqual(seen, [], 'nothing changed, nothing reported');
});

test('a calendar Google could not read keeps its events as they were', async () => {
  await mirror.syncCalendar(USER, T0);
  events = [];
  errors = { [PRIMARY]: 'rate limited' };
  await mirror.syncCalendar(USER, T0 + 60_000);
  assert.equal(window().length, 2);
  assert.match(String(mirror.syncStatus(USER).lastError), /could not be read/);
});

test('a failed sync changes nothing and backs off: 5, then 10 minutes', async () => {
  await mirror.syncCalendar(USER, T0);
  failList = true;
  assert.equal((await mirror.syncCalendar(USER, T0 + 1000)).ok, false);
  assert.equal(window().length, 2, 'the mirror is not wiped');
  const s1 = db.prepare('SELECT failures, next_attempt_at FROM gcal_sync WHERE user_id=?').get(USER) as { failures: number; next_attempt_at: number };
  assert.deepEqual([s1.failures, s1.next_attempt_at - (T0 + 1000)], [1, 5 * 60_000]);
  await mirror.syncCalendar(USER, T0 + 2000);
  const s2 = db.prepare('SELECT failures, next_attempt_at FROM gcal_sync WHERE user_id=?').get(USER) as { failures: number; next_attempt_at: number };
  assert.deepEqual([s2.failures, s2.next_attempt_at - (T0 + 2000)], [2, 10 * 60_000]);
  calls.length = 0;
  assert.equal(mirror.syncIfStale(USER, T0 + 3000), false, 'a view does not override the backoff');
  assert.equal(calls.length, 0);
});

test('a calendar view syncs only when the mirror is more than a minute old', async () => {
  await mirror.syncCalendar(USER, T0);
  assert.equal(mirror.syncIfStale(USER, T0 + 30_000), false);
  assert.equal(mirror.syncIfStale(USER, T0 + 61_000), true);
});

test('turning a calendar on brings its events; off removes them', async () => {
  await mirror.syncCalendar(USER, T0);
  events.push({ cal: HOLIDAYS, event: { id: 'h1', status: 'confirmed', summary: 'Boxing Day', start: { date: '2026-12-26' }, end: { date: '2026-12-27' } } });
  const holidays = mirror.listCalendars(USER).find((c) => !c.primary)!;
  mirror.setCalendarEnabled(USER, holidays.key, true);
  await mirror.syncCalendar(USER, T0 + 60_000);
  assert.ok(window().some((e) => e.title === 'Boxing Day'));
  mirror.setCalendarEnabled(USER, holidays.key, false);
  assert.equal(window().some((e) => e.title === 'Boxing Day'), false);
});

test('disconnecting Google Calendar forgets the mirror', async () => {
  await mirror.syncCalendar(USER, T0);
  mirror.clearMirror(USER);
  assert.deepEqual([window().length, mirror.listCalendars(USER).length], [0, 0]);
});
