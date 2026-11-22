import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerRuntimeInfo } from '@orbit/contracts';
import { activeOption, otherOption, runtimeProblem } from './computerRuntime';

const info = (over: Partial<ComputerRuntimeInfo> = {}): ComputerRuntimeInfo => ({
  active: 'docker',
  chosen: null,
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

test('the other runtime is the one a person could switch to', () => {
  assert.equal(activeOption(info())?.name, 'docker');
  assert.equal(otherOption(info())?.name, 'apple');
  assert.equal(otherOption(info({ active: 'apple' }))?.name, 'docker');
});
