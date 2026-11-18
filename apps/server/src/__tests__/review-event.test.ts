// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EventReview } from '@orbit/contracts';

process.env.COMPOSIO_API_KEY = '';

const { composioIO } = await import('../composio.js');
const { applyReviewEdits, buildReview, ReviewEditError } = await import('../review/index.js');
const { fieldsFromCreate, fieldsFromEvent, instantOf, readEvent, wallClock } = await import('../review/event.js');

after(() => cleanupTmpEnv());

/**
 * The Event card against Composio's real calendar responses (phase 0 fixtures): reading every
 * response wrapper, turning events into card fields, and turning the person's decisions into
 * arguments that exist in the action's captured schema. Above all: a change never drops the
 * guests, location or description it did not touch.
 */

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/composio');
const fixture = (rel: string) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
const data = (name: string) => fixture(`responses/${name}.json`).response.data;
const params = (slug: string) => Object.keys(fixture(`schemas/${slug}.json`).input_parameters.properties);
const fits = (slug: string, args: Record<string, unknown>) => {
  for (const k of Object.keys(args)) assert.ok(params(slug).includes(k), `${slug} has no argument "${k}"`);
};

// A fake calendar: EVENTS_GET answers from this map.
let events: Record<string, Record<string, unknown>> = {};
beforeEach(() => {
  events = {};
  composioIO.runAction = async (_u, slug, args) => {
    if (slug === 'GOOGLECALENDAR_EVENTS_INSTANCES') {
      // Weekly from Nov 19, ten events: the last is Jan 21.
      const items = Array.from({ length: Number(args.maxResults) }, (_, i) => ({ start: { dateTime: new Date(Date.UTC(2026, 10, 19 + 7 * i, 14)).toISOString() } }));
      return { successful: true, data: { items }, error: null };
    }
    if (slug !== 'GOOGLECALENDAR_EVENTS_GET') return { successful: true, data: {}, error: null };
    const e = events[String(args.event_id)];
    return e ? { successful: true, data: e, error: null } : { successful: false, data: null, error: 'not found' };
  };
});

const meeting = () => ({ ...data('gcal-events-get'), id: 'ev1' });
const series = () => ({ id: 'ser1', summary: 'Standup', start: { dateTime: '2026-11-19T14:00:00Z', timeZone: 'America/Toronto' }, end: { dateTime: '2026-11-19T14:15:00Z', timeZone: 'America/Toronto' }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'], attendees: [{ email: 'team@x.test' }] });
const instance = () => ({ id: 'ser1_20261126T140000Z', recurringEventId: 'ser1', summary: 'Standup', start: { dateTime: '2026-11-26T14:00:00Z', timeZone: 'America/Toronto' }, end: { dateTime: '2026-11-26T14:15:00Z', timeZone: 'America/Toronto' }, attendees: [{ email: 'team@x.test' }] });

test('every calendar response wrapper Composio uses is read to the event', () => {
  for (const name of ['gcal-create-event', 'gcal-update-event', 'gcal-events-get', 'gcal-patch-event', 'gcal-quick-add', 'gcal-events-instances']) {
    const e = readEvent(data(name));
    assert.ok(e.id && (e.start || e.summary), name);
  }
});

test('a Google event becomes card fields in its own timezone, without the organizer as a guest', () => {
  const f = fieldsFromEvent(data('gcal-events-get'));
  assert.deepEqual([f.start, f.end, f.timezone, f.allDay, f.meet], ['2026-11-19T15:00', '2026-11-19T15:30', 'America/Toronto', false, true]);
  assert.equal(f.attendees.length, 1);
  const allDay = fieldsFromEvent({ start: { date: '2026-12-24' }, end: { date: '2026-12-26' } });
  assert.deepEqual([allDay.allDay, allDay.start, allDay.end], [true, '2026-12-24', '2026-12-25'], 'an all-day end is shown as its last day');
});

test('wall-clock times and instants round-trip, across a DST change', () => {
  for (const local of ['2026-03-07T09:30', '2026-03-08T09:30', '2026-11-01T09:30', '2026-07-01T00:00']) {
    assert.equal(wallClock(instantOf(local, 'America/Toronto'), 'America/Toronto'), local);
  }
  assert.equal(instantOf('2026-07-01T09:00', 'America/Toronto').toISOString(), '2026-07-01T13:00:00.000Z');
});

test('a create call becomes fields; a duration becomes an end; all-day dates read inclusively', () => {
  const f = fieldsFromCreate({ summary: 'Call', start_datetime: '2026-11-19T15:00:00', event_duration_minutes: 45, timezone: 'America/Toronto', attendees: ['a@x.test', { email: 'b@x.test' }], create_meeting_room: true });
  assert.deepEqual([f.start, f.end, f.attendees, f.meet], ['2026-11-19T15:00', '2026-11-19T15:45', ['a@x.test', 'b@x.test'], true]);
  const d = fieldsFromCreate({ summary: 'Off', start_date: '2026-12-24', end_date: '2026-12-26' });
  assert.deepEqual([d.allDay, d.start, d.end], [true, '2026-12-24', '2026-12-25']);
});

test('a create the person did not touch runs exactly as the bot made it', async () => {
  const args = { calendar_id: 'primary', summary: 'Call', start_datetime: '2026-11-19T15:00:00', event_duration_minutes: 30, timezone: 'UTC', color_id: '5' };
  const review = await buildReview('u', 'GOOGLECALENDAR_CREATE_EVENT', args);
  const a = await applyReviewEdits('u', 'GOOGLECALENDAR_CREATE_EVENT', args, review, undefined);
  assert.deepEqual(a.args, args);
  assert.equal(a.slug, undefined);
});

test('an edited create runs with the person\'s fields, real CREATE_EVENT arguments, and their guest choice', async () => {
  const args = { calendar_id: 'primary', summary: 'Call', start_datetime: '2026-11-19T15:00:00', event_duration_minutes: 30, timezone: 'UTC', attendees: ['a@x.test'] };
  const review = await buildReview('u', 'GOOGLECALENDAR_CREATE_EVENT', args);
  const a = await applyReviewEdits('u', 'GOOGLECALENDAR_CREATE_EVENT', args, review, { start: '2026-11-19T16:00', end: '2026-11-19T17:00', attendees: ['a@x.test', 'c@x.test'], meet: true, notifyGuests: false });
  fits('GOOGLECALENDAR_CREATE_EVENT', a.args);
  assert.deepEqual([a.args.start_datetime, a.args.end_datetime, a.args.create_meeting_room, a.args.send_updates], ['2026-11-19T16:00:00', '2026-11-19T17:00:00', true, 'none']);
  assert.equal('event_duration_minutes' in a.args, false, 'the old duration does not fight the new end');
  assert.ok(a.changes.some((c) => c.startsWith('time changed to 2026-11-19 16:00–17:00')));
  assert.ok(a.changes.includes('guests added: c@x.test'));
  assert.ok(a.changes.includes('guests will not be notified'));
});

test('a bot\'s UPDATE_EVENT runs as a patch that keeps the guests, location and description', async () => {
  events.ev1 = meeting();
  const args = { calendar_id: 'primary', event_id: 'ev1', summary: 'Moved', start_datetime: '2026-11-19T16:00:00', timezone: 'America/Toronto' };
  const review = (await buildReview('u', 'GOOGLECALENDAR_UPDATE_EVENT', args)) as EventReview;
  assert.equal(review.before?.attendees.length, 1);
  assert.equal(review.fields?.attendees.length, 1, 'the card shows the guests staying');
  const a = await applyReviewEdits('u', 'GOOGLECALENDAR_UPDATE_EVENT', args, review, undefined);
  assert.equal(a.slug, 'GOOGLECALENDAR_PATCH_EVENT');
  fits('GOOGLECALENDAR_PATCH_EVENT', a.args);
  for (const k of ['attendees', 'location', 'description']) assert.equal(k in a.args, false, `${k} is left alone`);
  assert.deepEqual([a.args.summary, a.args.start_time, a.args.end_time], ['Moved', '2026-11-19T16:00:00', '2026-11-19T16:30:00']);
});

test('an edited patch sends only what changed, plus the bot\'s other settings', async () => {
  events.ev1 = meeting();
  const args = { calendar_id: 'primary', event_id: 'ev1', summary: 'Renamed', color_id: '7' };
  const review = await buildReview('u', 'GOOGLECALENDAR_PATCH_EVENT', args);
  const a = await applyReviewEdits('u', 'GOOGLECALENDAR_PATCH_EVENT', args, review, { location: 'Room 9' });
  fits('GOOGLECALENDAR_PATCH_EVENT', a.args);
  assert.deepEqual([a.args.summary, a.args.location, a.args.color_id, a.args.event_id], ['Renamed', 'Room 9', '7', 'ev1']);
  for (const k of ['attendees', 'start_time', 'description']) assert.equal(k in a.args, false, `${k} is not sent`);
});

test('a recurring event asks the scope; "this event" changes only the instance', async () => {
  events[instance().id] = instance();
  events.ser1 = series();
  const args = { calendar_id: 'primary', event_id: instance().id, summary: 'Standup (moved)' };
  const review = (await buildReview('u', 'GOOGLECALENDAR_PATCH_EVENT', args)) as EventReview;
  assert.deepEqual(review.recurring, { scope: 'this' });
  const a = await applyReviewEdits('u', 'GOOGLECALENDAR_PATCH_EVENT', args, review, { summary: 'Standup (moved)' });
  assert.equal(a.args.event_id, instance().id);
});

test('"all" from an instance changes the series, shifting its own start by the same amount', async () => {
  events[instance().id] = instance();
  events.ser1 = series();
  const args = { calendar_id: 'primary', event_id: instance().id };
  const review = await buildReview('u', 'GOOGLECALENDAR_PATCH_EVENT', args);
  const a = await applyReviewEdits('u', 'GOOGLECALENDAR_PATCH_EVENT', args, review, { scope: 'all', start: '2026-11-26T10:00', end: '2026-11-26T10:15' });
  fits('GOOGLECALENDAR_PATCH_EVENT', a.args);
  assert.deepEqual([a.slug, a.args.event_id, a.args.start_time, a.args.end_time], ['GOOGLECALENDAR_PATCH_EVENT', 'ser1', '2026-11-19T10:00:00', '2026-11-19T10:15:00']);
  assert.ok(a.changes.includes('applies to every event in the series'));
});

test('"this and following" ends the series before the event and starts a new one, with an undo', async () => {
  events[instance().id] = instance();
  events.ser1 = series();
  const args = { calendar_id: 'primary', event_id: instance().id };
  const review = await buildReview('u', 'GOOGLECALENDAR_PATCH_EVENT', args);
  const a = await applyReviewEdits('u', 'GOOGLECALENDAR_PATCH_EVENT', args, review, { scope: 'following', summary: 'Standup v2' });
  assert.equal(a.slug, 'GOOGLECALENDAR_CREATE_EVENT');
  fits('GOOGLECALENDAR_CREATE_EVENT', a.args);
  assert.deepEqual([a.args.summary, a.args.start_datetime, a.args.recurrence], ['Standup v2', '2026-11-26T09:00:00', ['RRULE:FREQ=WEEKLY;UNTIL=20270121T140000Z']], 'the new series ends where the old one would have');
  assert.equal(a.before.length, 1);
  assert.deepEqual([a.before[0].slug, a.before[0].args.event_id, a.before[0].args.recurrence], ['GOOGLECALENDAR_PATCH_EVENT', 'ser1', ['RRULE:FREQ=WEEKLY;UNTIL=20261126T135959Z']]);
  assert.deepEqual(a.rollback, [{ slug: 'GOOGLECALENDAR_PATCH_EVENT', args: { calendar_id: 'primary', event_id: 'ser1', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'], send_updates: 'none' } }]);
});

test('deleting: an instance alone, the whole series, or this and following', async () => {
  events[instance().id] = instance();
  events.ser1 = series();
  const args = { calendar_id: 'primary', event_id: instance().id };
  const review = await buildReview('u', 'GOOGLECALENDAR_DELETE_EVENT', args);
  assert.deepEqual((await applyReviewEdits('u', 'GOOGLECALENDAR_DELETE_EVENT', args, review, undefined)).args, args, 'untouched, it deletes what the bot named');
  const all = await applyReviewEdits('u', 'GOOGLECALENDAR_DELETE_EVENT', args, review, { scope: 'all' });
  assert.deepEqual([all.slug, all.args.event_id], [undefined, 'ser1']);
  const following = await applyReviewEdits('u', 'GOOGLECALENDAR_DELETE_EVENT', args, review, { scope: 'following', notifyGuests: false });
  assert.deepEqual([following.slug, following.args.event_id, following.args.recurrence, following.args.send_updates], ['GOOGLECALENDAR_PATCH_EVENT', 'ser1', ['RRULE:FREQ=WEEKLY;UNTIL=20261126T135959Z'], 'none']);
});

test('an event that cannot be read gives a read-only card', async () => {
  const review = (await buildReview('u', 'GOOGLECALENDAR_DELETE_EVENT', { calendar_id: 'primary', event_id: 'gone' })) as EventReview;
  assert.deepEqual([review.kind, review.action, review.editable], ['event', 'delete', false]);
  await assert.rejects(() => applyReviewEdits('u', 'GOOGLECALENDAR_DELETE_EVENT', {}, review, { scope: 'all' }), /read-only/);
});

test('changes that cannot run are refused with a reason', async () => {
  const args = { summary: 'Call', start_datetime: '2026-11-19T15:00:00', event_duration_minutes: 30, timezone: 'UTC' };
  const review = await buildReview('u', 'GOOGLECALENDAR_CREATE_EVENT', args);
  const refused = (edits: unknown, why: RegExp) => assert.rejects(() => applyReviewEdits('u', 'GOOGLECALENDAR_CREATE_EVENT', args, review, edits), (e: Error) => e instanceof ReviewEditError && why.test(e.message));
  await refused({ end: '2026-11-19T14:00' }, /end after it starts/);
  await refused({ timezone: 'Mars/Olympus' }, /not a timezone/);
  await refused({ scope: 'all' }, /does not repeat/);
  await refused({ attendees: ['nobody'] }, /email address/);
  await refused({ colour: 'red' }, /./);
});
