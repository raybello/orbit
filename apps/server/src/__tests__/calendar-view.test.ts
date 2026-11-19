import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCalendar, expandRoutine, EVENT_MINUTES, type CalendarRoutineRow } from '../domain/calendar-view.js';

// Pure unit tests: no DB, no server, no env setup needed.

function row(overrides: Partial<CalendarRoutineRow> = {}): CalendarRoutineRow {
  return {
    id: 'rtn_1',
    bot_id: 'bot_1',
    bot_name: 'TestBot',
    name: 'My Routine',
    schedule: '0 9 * * 1', // weekly Monday 09:00 UTC
    timezone: 'UTC',
    calendar_title: null,
    event_type: 'recurring',
    event_date: null,
    completed_at: null,
    ...overrides,
  };
}

const FROM = new Date('2026-03-02T00:00:00Z'); // Monday
const TO   = new Date('2026-03-30T00:00:00Z'); // four Mondays: 2, 9, 16, 23

// ─── expandRoutine – weekly ───────────────────────────────────────────────────

test('weekly routine produces one occurrence per matching weekday in the window', () => {
  const events = expandRoutine(row(), FROM, TO);
  assert.equal(events.length, 4);
  assert.equal(events[0].start, '2026-03-02T09:00:00.000Z');
  assert.equal(events[1].start, '2026-03-09T09:00:00.000Z');
  assert.equal(events[2].start, '2026-03-16T09:00:00.000Z');
  assert.equal(events[3].start, '2026-03-23T09:00:00.000Z');
});

test('each occurrence lasts EVENT_MINUTES', () => {
  const [e] = expandRoutine(row(), FROM, TO);
  const diff = (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000;
  assert.equal(diff, EVENT_MINUTES);
});

// ─── expandRoutine – monthly ──────────────────────────────────────────────────

test('monthly routine (first of month at noon) produces one occurrence per month', () => {
  const monthly = row({ schedule: '0 12 1 * *' }); // monthly on the 1st at 12:00 UTC
  const from = new Date('2026-01-01T00:00:00Z');
  const to   = new Date('2026-04-01T00:00:00Z');
  const events = expandRoutine(monthly, from, to);
  assert.equal(events.length, 3);
  assert.equal(events[0].start, '2026-01-01T12:00:00.000Z');
  assert.equal(events[1].start, '2026-02-01T12:00:00.000Z');
  assert.equal(events[2].start, '2026-03-01T12:00:00.000Z');
});

// ─── expandRoutine – one-time ─────────────────────────────────────────────────

test('one_time routine with event_date in window returns exactly one occurrence', () => {
  const oneTime = row({ event_type: 'one_time', schedule: '', event_date: '2026-03-15T10:00:00.000Z' });
  const events = expandRoutine(oneTime, FROM, TO);
  assert.equal(events.length, 1);
  assert.equal(events[0].start, '2026-03-15T10:00:00.000Z');
  assert.equal(events[0].eventType, 'one_time');
});

test('one_time routine outside window returns nothing', () => {
  const oneTime = row({ event_type: 'one_time', schedule: '', event_date: '2026-04-01T10:00:00.000Z' });
  assert.equal(expandRoutine(oneTime, FROM, TO).length, 0);
});

// ─── expandRoutine – edge cases ──────────────────────────────────────────────

test('event-triggered schedule produces no calendar occurrences', () => {
  assert.equal(expandRoutine(row({ schedule: 'event:APP_CLICK' }), FROM, TO).length, 0);
});

test('invalid cron expression returns empty array without throwing', () => {
  assert.equal(expandRoutine(row({ schedule: 'not-a-cron' }), FROM, TO).length, 0);
});

test('occurrences carry routineId, botId, botName, and title', () => {
  const [e] = expandRoutine(row({ id: 'rtn_x', bot_id: 'bot_x', bot_name: 'Boxy', calendar_title: 'Stand-up' }), FROM, TO);
  assert.equal(e.routineId, 'rtn_x');
  assert.equal(e.botId, 'bot_x');
  assert.equal(e.botName, 'Boxy');
  assert.equal(e.title, 'Stand-up');
});

// ─── buildCalendar – merge and sort ──────────────────────────────────────────

test('buildCalendar merges two routines and sorts by start ascending', () => {
  const mon = row({ id: 'rtn_mon', schedule: '0 9 * * 1' }); // Monday 09:00
  const wed = row({ id: 'rtn_wed', schedule: '0 9 * * 3' }); // Wednesday 09:00
  const events = buildCalendar([mon, wed], FROM, TO);
  // Should alternate: Mon, Wed, Mon, Wed, ... for the window
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].start <= e.start));
});

test('buildCalendar returns empty array for no routines', () => {
  assert.deepEqual(buildCalendar([], FROM, TO), []);
});

test('buildCalendar ties on start time break by title ascending', () => {
  const a = row({ id: 'rtn_a', schedule: '0 9 * * 1', calendar_title: 'Zebra' });
  const b = row({ id: 'rtn_b', schedule: '0 9 * * 1', calendar_title: 'Alpha' });
  const events = buildCalendar([a, b], FROM, TO);
  // Both fire on the same Mondays; Alpha < Zebra alphabetically.
  assert.equal(events[0].title, 'Alpha');
  assert.equal(events[1].title, 'Zebra');
});
