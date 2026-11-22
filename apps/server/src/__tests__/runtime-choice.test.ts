import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { activeRuntimeName, preferredRuntime, setPreferredRuntime } from '../computer-runtime-config.js';
import { runtime } from '../docker/runtime.js';
import { cleanupTmpEnv } from './helpers/tmp-env.js';

after(() => cleanupTmpEnv());

test('with no choice stored, the environment decides (docker in the test run)', () => {
  assert.equal(preferredRuntime(), null);
  assert.equal(activeRuntimeName(), 'docker');
  assert.equal(runtime().name, 'docker');
});

test('a stored choice wins and is picked up by the very next call, no restart', () => {
  setPreferredRuntime('apple');
  assert.equal(preferredRuntime(), 'apple');
  assert.equal(runtime().name, 'apple');
  assert.equal(runtime().pause, undefined, 'Apple VMs cannot be frozen');
  setPreferredRuntime('docker');
  assert.equal(runtime().name, 'docker');
  assert.equal(typeof runtime().pause, 'function');
});

test('clearing the choice goes back to automatic', () => {
  setPreferredRuntime('apple');
  setPreferredRuntime(null);
  assert.equal(preferredRuntime(), null);
  assert.equal(activeRuntimeName(), 'docker');
});

test('an Apple bot is counted at its whole VM, and "0" turns the check off', () => {
  setPreferredRuntime('apple');
  assert.equal(runtime().reservation(), 1536 * 1024 ** 2);
  setPreferredRuntime(null);
});
