import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerState } from '@orbit/contracts';
import { botComputerStatus, computerStatusText } from './computer';

const computer = {
  status: 'starting',
  screens: [
    { botId: 'atlas', screenId: 's1', state: 'running' },
    { botId: 'nova', screenId: 's2', state: 'starting' },
  ],
} as ComputerState;

test("each Bot reads its own computer's state, not the shared one", () => {
  assert.equal(computerStatusText(botComputerStatus(computer, 'atlas')), 'Awake');
  assert.equal(computerStatusText(botComputerStatus(computer, 'nova')), 'Waking up…');
});

test('a Bot with no screen yet is asleep, and an unloaded computer says nothing yet', () => {
  assert.equal(computerStatusText(botComputerStatus(computer, 'iris')), 'Asleep');
  assert.equal(botComputerStatus(null, 'atlas'), undefined);
});
