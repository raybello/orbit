import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerRuntimeInfo } from '@orbit/contracts';
import { activeOption, resetDesktopSetup, runtimeProblem } from './computerRuntime';

const info = (over: Partial<ComputerRuntimeInfo> = {}): ComputerRuntimeInfo => ({
  active: 'docker',
  options: [
    { name: 'docker', label: 'Docker', available: false, note: 'Docker is not reachable.' },
    { name: 'apple', label: 'Apple container', available: true, note: null },
  ],
  ...over,
});

test('the problem is the active runtime\'s note, only when it cannot run', () => {
  assert.equal(runtimeProblem(info()), 'Docker is not reachable.');
  assert.equal(runtimeProblem(info({ active: 'apple' })), null);
  assert.equal(runtimeProblem(null), null);
});

test('the active runtime is the one in use', () => {
  assert.equal(activeOption(info())?.name, 'docker');
  assert.equal(activeOption(info({ active: 'apple' }))?.name, 'apple');
});

test('outside the desktop app there is nothing to reset', async () => {
  assert.match((await resetDesktopSetup()) ?? '', /desktop app/);
});
