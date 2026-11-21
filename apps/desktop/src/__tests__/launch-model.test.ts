import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launchProblem, launchSteps } from '../launch-model';
import type { DesktopLocalStackState, StackPhase } from '../shared/api';

const at = (phase: StackPhase, extra: Partial<DesktopLocalStackState> = {}): DesktopLocalStackState => ({ phase, at: 0, ...extra });
const statuses = (steps: { status: string }[]) => steps.map((s) => s.status).join(' ');

describe('launchSteps', () => {
  const table: [StackPhase, string][] = [
    ['idle', 'active pending pending pending'],
    ['checking-docker', 'active pending pending pending'],
    ['pulling', 'done active pending pending'],
    ['starting', 'done done active pending'],
    ['waiting-healthy', 'done done done active'],
    ['ready', 'done done done done'],
    ['docker-missing', 'failed pending pending pending'],
    ['docker-not-running', 'failed pending pending pending'],
  ];
  for (const [phase, expected] of table) {
    test(`docker ${phase} -> ${expected}`, () => assert.equal(statuses(launchSteps('docker', at(phase))), expected));
  }

  test('a failure is drawn on the step the start had reached', () => {
    assert.equal(statuses(launchSteps('docker', at('failed'), 'pulling')), 'done failed pending pending');
    assert.equal(statuses(launchSteps('native', at('failed'), 'waiting-healthy')), 'done failed');
  });

  test('native has its own, shorter list and finishes on running', () => {
    assert.equal(statuses(launchSteps('native', at('starting'))), 'active pending');
    assert.equal(statuses(launchSteps('native', at('running'))), 'done done');
  });
});

describe('launchProblem', () => {
  const mac = { platform: 'darwin' as const, nativeAvailable: true };
  const linux = { platform: 'linux' as const, nativeAvailable: false };

  test('nothing is wrong while a start is moving or finished', () => {
    for (const phase of ['checking-docker', 'pulling', 'waiting-healthy', 'ready', 'running'] as StackPhase[]) {
      assert.equal(launchProblem('docker', at(phase), mac), null);
    }
  });

  test('missing Docker on a Mac offers the install first, and the Docker-free stack when it can run', () => {
    assert.deepEqual(launchProblem('docker', at('docker-missing'), mac)?.actions, ['install-docker', 'use-native', 'back']);
    assert.deepEqual(launchProblem('docker', at('docker-missing'), { ...mac, nativeAvailable: false })?.actions, ['install-docker', 'back']);
  });

  test('missing Docker on Linux cannot be installed for the person', () => {
    assert.deepEqual(launchProblem('docker', at('docker-missing'), linux)?.actions, ['retry', 'open-docker-download', 'back']);
  });

  test('a failed start says why and offers the log', () => {
    const problem = launchProblem('native', at('failed', { error: 'port 41001 in use' }), mac);
    assert.equal(problem?.body, 'port 41001 in use');
    assert.deepEqual(problem?.actions, ['retry', 'show-log', 'back']);
  });
});
