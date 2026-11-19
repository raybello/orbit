import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicy, type PolicyFacts } from '../domain/approval-policy.js';

const base: PolicyFacts = {
  storedMode: undefined,
  botTrusted: false,
  botPolicyAllows: false,
  googleAction: null,
  isReadOnly: false,
};

// --- Deny layer ---

test('blocked stored mode denies regardless of bot trust', () => {
  const r = applyPolicy({ ...base, storedMode: 'blocked', botTrusted: true, botPolicyAllows: true });
  assert.equal(r.run, 'deny');
  assert.equal(r.source, 'policies.blocked');
});

test('blocked stored mode denies for read-only action', () => {
  const r = applyPolicy({ ...base, storedMode: 'blocked', isReadOnly: true });
  assert.equal(r.run, 'deny');
});

// --- Bot policy layer ---

test('bot_policies entry allows when bot is trusted', () => {
  const r = applyPolicy({ ...base, botTrusted: true, botPolicyAllows: true });
  assert.equal(r.run, 'allow');
  assert.equal(r.source, 'bot_policies');
});

test('bot_policies entry does nothing when bot is not trusted', () => {
  const r = applyPolicy({ ...base, botTrusted: false, botPolicyAllows: true });
  assert.equal(r.run, 'ask');
});

test('trusted bot without matching bot_policies entry does not auto-allow', () => {
  const r = applyPolicy({ ...base, botTrusted: true, botPolicyAllows: false });
  assert.equal(r.run, 'ask');
});

// --- Person always_allow layer ---

test('stored always_allow allows for a regular action', () => {
  const r = applyPolicy({ ...base, storedMode: 'always_allow' });
  assert.equal(r.run, 'allow');
  assert.equal(r.source, 'policies.always_allow');
});

test('stored always_allow does not cover an action where allowAlways=false', () => {
  const r = applyPolicy({ ...base, storedMode: 'always_allow', googleAction: { kind: 'review', allowAlways: false } });
  assert.equal(r.run, 'ask');
});

test('stored always_allow covers a google action with allowAlways=true', () => {
  const r = applyPolicy({ ...base, storedMode: 'always_allow', googleAction: { kind: 'review', allowAlways: true } });
  assert.equal(r.run, 'allow');
  assert.equal(r.source, 'policies.always_allow');
});

// --- Catalogue default layer ---

test('google review action without stored mode → ask', () => {
  const r = applyPolicy({ ...base, googleAction: { kind: 'review', allowAlways: true } });
  assert.equal(r.run, 'ask');
  assert.equal(r.source, 'default');
});

test('google non-review action without stored mode → allow from catalogue', () => {
  const r = applyPolicy({ ...base, googleAction: { kind: 'read', allowAlways: true } });
  assert.equal(r.run, 'allow');
  assert.equal(r.source, 'catalogue');
});

test('read-only slug with no stored mode → allow from catalogue', () => {
  const r = applyPolicy({ ...base, isReadOnly: true });
  assert.equal(r.run, 'allow');
  assert.equal(r.source, 'catalogue');
});

test('write slug with no stored mode → ask', () => {
  const r = applyPolicy({ ...base });
  assert.equal(r.run, 'ask');
});

// --- Precedence ordering ---

test('blocked beats bot_policies allow', () => {
  const r = applyPolicy({ ...base, storedMode: 'blocked', botTrusted: true, botPolicyAllows: true });
  assert.equal(r.run, 'deny');
});

test('bot_policies beats person always_allow', () => {
  const r = applyPolicy({ ...base, storedMode: 'always_allow', botTrusted: true, botPolicyAllows: true });
  assert.equal(r.run, 'allow');
  assert.equal(r.source, 'bot_policies');
});
