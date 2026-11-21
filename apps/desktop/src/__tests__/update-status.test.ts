import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopUpdateStatus } from '@orbit/contracts';
import { nextUpdateStatus, type UpdateEvent } from '../update-status';

const run = (events: UpdateEvent[], from: DesktopUpdateStatus = { phase: 'idle', current: '0.3.0' }) =>
  events.reduce((s, e) => nextUpdateStatus(s, e, 1000), from);

test('a check finds a release, the person downloads it, the server is prepared, then it is ready', () => {
  const trail: string[] = [];
  let s: DesktopUpdateStatus = { phase: 'idle', current: '0.3.0' };
  for (const e of [
    { type: 'check' },
    { type: 'available', version: '0.4.0' },
    { type: 'progress', percent: 41.6 },
    { type: 'downloaded' },
    { type: 'prepared' },
  ] as UpdateEvent[]) {
    s = nextUpdateStatus(s, e);
    trail.push(s.phase);
  }
  assert.deepEqual(trail, ['checking', 'available', 'downloading', 'preparing', 'ready']);
  assert.deepEqual(s, { phase: 'ready', current: '0.3.0', version: '0.4.0', note: undefined });
});

test('download progress is a whole percent within 0-100', () => {
  const s = run([{ type: 'available', version: '0.4.0' }, { type: 'progress', percent: 120.4 }]);
  assert.equal(s.phase === 'downloading' && s.percent, 100);
});

test('the four-hourly background check never knocks a download or a ready restart back', () => {
  for (const committed of [
    { phase: 'downloading', current: '0.3.0', version: '0.4.0', percent: 10 },
    { phase: 'preparing', current: '0.3.0', version: '0.4.0', detail: 'x' },
    { phase: 'ready', current: '0.3.0', version: '0.4.0' },
  ] as DesktopUpdateStatus[]) {
    assert.deepEqual(run([{ type: 'check' }, { type: 'not-available' }], committed), committed);
  }
});

test('nothing to install says so, with when it was checked', () => {
  assert.deepEqual(run([{ type: 'check' }, { type: 'not-available' }]), { phase: 'up-to-date', current: '0.3.0', checkedAt: 1000 });
});

test('a failed download keeps the version so Settings can offer it again', () => {
  const s = run([{ type: 'available', version: '0.4.0' }, { type: 'error', error: 'net::ERR_TIMED_OUT' }]);
  assert.deepEqual(s, { phase: 'error', current: '0.3.0', version: '0.4.0', error: 'net::ERR_TIMED_OUT' });
});

test('a development build stays unsupported whatever happens', () => {
  const dev: DesktopUpdateStatus = { phase: 'unsupported', current: '0.3.0' };
  assert.equal(run([{ type: 'check' }, { type: 'available', version: '9.9.9' }], dev), dev);
});
