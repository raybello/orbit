import assert from 'node:assert/strict';
import test from 'node:test';
import { fitTabs } from '../domain/tab-fit.js';

const W = [70, 50, 60, 66, 50, 62, 60];

test('every tab stays when they all fit, with no More menu', () => {
  assert.deepEqual(fitTabs(W, 500, 60, 0), { visible: [0, 1, 2, 3, 4, 5, 6], overflow: [] });
});

test('tabs that do not fit move to More, in order, leaving room for the More button', () => {
  assert.deepEqual(fitTabs(W, 344, 60, 0), { visible: [0, 1, 2, 3], overflow: [4, 5, 6] });
});

test('an active tab past the cut takes the place of the last one that fit', () => {
  assert.deepEqual(fitTabs(W, 344, 60, 6), { visible: [0, 1, 2, 6], overflow: [3, 4, 5] });
});

test('in a very narrow bar the active tab still shows', () => {
  assert.deepEqual(fitTabs(W, 120, 60, 5), { visible: [5], overflow: [0, 1, 2, 3, 4, 6] });
});

test('no tabs at all', () => {
  assert.deepEqual(fitTabs([], 300, 60, -1), { visible: [], overflow: [] });
});
