import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { inspect } from 'node:util';
import { parseSecretKey, Secret, secretBox, SecretBoxTamperError, SecretBoxUnavailableError } from '../lib/secret-box.js';

/**
 * The sealing the Vault rests on. Each case is a promise a caller relies on: what was sealed comes
 * back, anything altered or moved does not, and no key means no sealing at all.
 */

const KEY = crypto.randomBytes(32).toString('hex');
const OTHER_KEY = crypto.randomBytes(32).toString('hex');
const PLAIN = 'correct horse battery staple ✓ "quoted" \\ back';

/** A sealed value with one base64url character of one part changed. */
function flip(sealed: string, part: 1 | 2 | 3): string {
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[part], 'base64url');
  bytes[0] ^= 0x01;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
}

test('a sealed secret opens to exactly what was sealed', () => {
  const box = secretBox(KEY);
  const sealed = box.seal(new Secret(PLAIN), 'vault:u1:e1');
  assert.equal(box.open(sealed, 'vault:u1:e1').reveal(), PLAIN);
});

test('the sealed form does not contain the plaintext, and sealing twice never repeats itself', () => {
  const box = secretBox(KEY);
  const a = box.seal(new Secret('hunter2-hunter2'), 'ctx');
  const b = box.seal(new Secret('hunter2-hunter2'), 'ctx');
  assert.notEqual(a, b, 'a fresh nonce per seal: equal secrets must not produce equal ciphertexts');
  for (const sealed of [a, b]) {
    assert.ok(!sealed.includes('hunter2'));
    assert.ok(!Buffer.from(sealed.split('.')[2], 'base64url').toString('latin1').includes('hunter2'));
  }
});

test('a base64 key works the same as a hex one', () => {
  const raw = crypto.randomBytes(32);
  const sealed = secretBox(raw.toString('hex')).seal(new Secret(PLAIN), 'ctx');
  assert.equal(secretBox(raw.toString('base64')).open(sealed, 'ctx').reveal(), PLAIN);
  assert.equal(secretBox(raw.toString('base64url')).open(sealed, 'ctx').reveal(), PLAIN);
});

test('changing any part of a sealed secret is detected', () => {
  const box = secretBox(KEY);
  const sealed = box.seal(new Secret(PLAIN), 'ctx');
  assert.equal(box.open(sealed, 'ctx').reveal(), PLAIN, 'the untouched value opens, so the failures below are the edits');
  for (const part of [1, 2, 3] as const) {
    assert.throws(() => box.open(flip(sealed, part), 'ctx'), SecretBoxTamperError, `part ${part} altered`);
  }
});

test('a sealed secret does not open under another context or another key', () => {
  const box = secretBox(KEY);
  const sealed = box.seal(new Secret(PLAIN), 'vault:u1:e1');
  assert.throws(() => box.open(sealed, 'vault:u1:e2'), SecretBoxTamperError, 'moved to another entry');
  assert.throws(() => box.open(sealed, 'vault:u2:e1'), SecretBoxTamperError, 'moved to another person');
  assert.throws(() => secretBox(OTHER_KEY).open(sealed, 'vault:u1:e1'), SecretBoxTamperError, 'another key');
});

test('a truncated tag or a malformed envelope is rejected, not half-verified', () => {
  const box = secretBox(KEY);
  const [v, nonce, body, tag] = box.seal(new Secret(PLAIN), 'ctx').split('.');
  const shortTag = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
  const bad = [
    [v, nonce, body, shortTag].join('.'),
    [v, nonce, body].join('.'),
    ['v0', nonce, body, tag].join('.'),
    [v, Buffer.alloc(8).toString('base64url'), body, tag].join('.'),
    '',
    'not a sealed value',
    PLAIN,
  ];
  for (const sealed of bad) assert.throws(() => box.open(sealed, 'ctx'), SecretBoxTamperError, JSON.stringify(sealed.slice(0, 24)));
});

test('without a usable key nothing is sealed or opened', () => {
  for (const key of [undefined, null, '', '   ']) {
    assert.throws(() => secretBox(key), SecretBoxUnavailableError, `key ${JSON.stringify(key)}`);
  }
});

test('a key that is not 32 bytes, or is a placeholder, is refused and never echoed', () => {
  const passphrase = 'change-me-to-a-long-random-string';
  const refused = [
    passphrase,
    KEY.slice(0, 62),
    `${KEY}ab`,
    crypto.randomBytes(16).toString('base64'),
    '0'.repeat(64),
    `${KEY.slice(0, 63)}g`,
  ];
  for (const key of refused) {
    assert.throws(
      () => parseSecretKey(key),
      (e: unknown) => {
        assert.ok(e instanceof SecretBoxUnavailableError);
        assert.ok(!e.message.includes(key), 'the error must not carry the key');
        return true;
      },
      `key of length ${key.length}`,
    );
  }
});

test('a Secret prints as [secret] everywhere a value gets printed by accident', () => {
  const secret = new Secret('s3cr3t-value');
  const printed = [
    String(secret),
    `${secret}`,
    JSON.stringify({ secret, nested: [secret] }),
    inspect(secret),
    inspect({ deep: { secret } }, { depth: 5 }),
    new Error(`failed for ${secret}`).message,
    Object.keys(secret).join(','),
    JSON.stringify(Object.entries(secret)),
  ];
  for (const text of printed) assert.ok(!text.includes('s3cr3t-value'), text);
  assert.equal(secret.reveal(), 's3cr3t-value', 'and the value is still there for the one caller that fills it in');
});

test('redact removes the value from text somebody else wrote', () => {
  const secret = new Secret('p"ss\\word');
  assert.equal(secret.redact('could not type p"ss\\word into the field'), 'could not type [secret] into the field');
  assert.equal(secret.redact(JSON.stringify({ error: 'bad text: p"ss\\word' })), '{"error":"bad text: [secret]"}');
  assert.equal(secret.redact('nothing to hide'), 'nothing to hide');
});
