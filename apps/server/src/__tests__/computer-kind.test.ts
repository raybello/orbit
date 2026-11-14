import assert from 'node:assert/strict';
import test from 'node:test';
import { decideComputerKind } from '../computer-provider-registry.js';

// A fresh desktop install has no Orgo machine, and the primary bot used to be pinned to one anyway:
// the app then showed its main bot "couldn't reach the screen" forever. These pin the rule.

test('the shared machine wins for the primary bot when there is one', () => {
  assert.equal(
    decideComputerKind({ isPrimary: true, sharedComputerAvailable: true, setting: 'auto' }),
    'orgo',
  );
});

test('without a shared machine the primary bot gets its own container', () => {
  assert.equal(
    decideComputerKind({ isPrimary: true, sharedComputerAvailable: false, setting: 'auto' }),
    'docker',
  );
});

test('a managed bot gets a container under auto and docker', () => {
  for (const setting of ['auto', 'docker']) {
    assert.equal(decideComputerKind({ isPrimary: false, sharedComputerAvailable: false, setting }), 'docker');
  }
});

test('COMPUTER_KIND=orgo is still respected for managed bots', () => {
  assert.equal(decideComputerKind({ isPrimary: false, sharedComputerAvailable: true, setting: 'orgo' }), 'orgo');
});

test('a bot that already has a computer keeps it', () => {
  assert.equal(
    decideComputerKind({ existing: 'docker', isPrimary: true, sharedComputerAvailable: true, setting: 'auto' }),
    'docker',
  );
  assert.equal(
    decideComputerKind({ existing: 'orgo', isPrimary: false, sharedComputerAvailable: true, setting: 'auto' }),
    'orgo',
  );
});

test('an Orgo row with no machine configured falls back to a container', () => {
  assert.equal(
    decideComputerKind({ existing: 'orgo', isPrimary: true, sharedComputerAvailable: false, setting: 'auto' }),
    'docker',
  );
});
