import assert from 'node:assert/strict';
import test from 'node:test';
import { envValue, fillEmptySecrets, migrateLegacyBotCap, missingStackSecrets, normalizeEol, setEnvValue } from '../env-file';

// The shape of .env.images.example: a comment block right above the empty secrets.
const EXAMPLE = [
  '# ---- secrets the desktop app generates ----',
  'SESSION_SECRET=',
  'DB_ENCRYPTION_KEY=',
  'STACK_TOKEN=',
  'SANDBOX_SUPERVISOR_TOKEN=',
  '',
  '# ---- the agents ----',
  'HERMES_HOME_HOST=',
  '',
];

for (const [eol, name] of [['\n', 'LF'], ['\r\n', 'CRLF']] as const) {
  test(`${name}: filling the secrets keeps every line on its own line`, () => {
    const { text, generated } = fillEmptySecrets(EXAMPLE.join(eol), { generate: (n) => 'x'.repeat(n) });
    assert.deepEqual(Object.keys(generated).sort(), ['DB_ENCRYPTION_KEY', 'SANDBOX_SUPERVISOR_TOKEN', 'SESSION_SECRET', 'STACK_TOKEN']);
    assert.deepEqual(missingStackSecrets(text), [], 'compose must see every required secret');
    const lines = text.split(eol);
    assert.equal(lines[0], '# ---- secrets the desktop app generates ----', 'the comment is not joined to SESSION_SECRET');
    assert.ok(lines[1].startsWith('SESSION_SECRET=x'));
    assert.equal(envValue(text, 'SANDBOX_SUPERVISOR_TOKEN'), 'x'.repeat(32));
    if (eol === '\r\n') assert.equal(text.split('\r\n').length, text.split('\n').length, 'no bare LF was introduced');
  });

  test(`${name}: setEnvValue replaces in place and appends with the file's line ending`, () => {
    let text = setEnvValue(EXAMPLE.join(eol), 'HERMES_HOME_HOST', 'C:\\Users\\me\\AppData\\Local\\hermes');
    assert.equal(envValue(text, 'HERMES_HOME_HOST'), 'C:\\Users\\me\\AppData\\Local\\hermes');
    assert.ok(text.split(eol).includes('# ---- the agents ----'));
    text = setEnvValue(text, 'ORBIT_GPU_VOICE', '1');
    assert.ok(text.endsWith(`ORBIT_GPU_VOICE=1${eol}`));
    // `$` and friends in a value are taken literally, not as replacement patterns.
    assert.equal(envValue(setEnvValue(text, 'SESSION_SECRET', 'a$&b'), 'SESSION_SECRET'), 'a$&b');
  });
}

test('a commented-out key is not a value, and an empty value is none', () => {
  assert.equal(envValue('# STACK_TOKEN=abc\nSTACK_TOKEN=\n', 'STACK_TOKEN'), null);
  assert.equal(envValue('export STACK_TOKEN="abc" # note\r\n', 'STACK_TOKEN'), 'abc');
});

test('migrateLegacyBotCap comments out the old MAX_BOTS=4 template default', () => {
  const { text, changed } = migrateLegacyBotCap('HQ_LOCAL=0\nMAX_BOTS=4\nCOMPUTER_KIND=auto\n');
  assert.equal(changed, true);
  assert.equal(envValue(text, 'MAX_BOTS'), null);
  assert.equal(envValue(text, 'COMPUTER_KIND'), 'auto');
});

test('migrateLegacyBotCap leaves Orgo installs and other values alone', () => {
  assert.equal(migrateLegacyBotCap('MAX_BOTS=4\nCOMPUTER_KIND=orgo\n').changed, false);
  assert.equal(migrateLegacyBotCap('MAX_BOTS=4\nORGO_COMPUTER_ID=abc\n').changed, false);
  assert.equal(migrateLegacyBotCap('MAX_BOTS=6\n').changed, false);
  assert.equal(migrateLegacyBotCap('# MAX_BOTS=10\n').changed, false);
});

test('normalizeEol turns CRLF and bare CR into LF', () => {
  assert.equal(normalizeEol('A=1\r\nB=2\rC=3\n'), 'A=1\nB=2\nC=3\n');
  // Compose would read this as a single comment line; after normalizing it is three lines.
  const text = normalizeEol('# secrets\rSESSION_SECRET=x\rSTACK_TOKEN=y\r');
  assert.deepEqual(text.split('\n'), ['# secrets', 'SESSION_SECRET=x', 'STACK_TOKEN=y', '']);
});

