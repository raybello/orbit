import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_SECRETS,
  envValue,
  fillEmptySecrets,
  missingStackSecrets,
  setEnvValue,
} from '../env-file';
import { allocateLoopbackPort, type BindFn } from '../loopback-port';

const EXAMPLE = `SESSION_SECRET=
DB_ENCRYPTION_KEY=
STACK_TOKEN=
ORBIT_WEB_PORT=8787
ORBIT_API_PORT=0
HERMES_HOME=/root/.hermes
`;

/** Deterministic 64-char value per byte count, so assertions can name the source. */
const fakeGenerate = (bytes: number) => `${bytes}`.repeat(bytes * 2).slice(0, bytes * 2);

describe('secret filling', () => {
  test('fills every empty required secret with a 64-char hex value', () => {
    const { text, generated } = fillEmptySecrets(EXAMPLE);
    for (const spec of REQUIRED_SECRETS) {
      const value = envValue(text, spec.key);
      assert.ok(value, `${spec.key} should be set`);
      assert.match(value!, /^[0-9a-f]{64}$/);
      assert.equal(value, generated[spec.key]);
    }
  });

  test('leaves existing secrets alone', () => {
    const text = EXAMPLE.replace('SESSION_SECRET=', 'SESSION_SECRET=already-set');
    const { text: filled, generated } = fillEmptySecrets(text);
    assert.equal(envValue(filled, 'SESSION_SECRET'), 'already-set');
    assert.equal(generated.SESSION_SECRET, undefined);
    assert.ok(envValue(filled, 'STACK_TOKEN'));
  });

  test('treats a commented-out key as unset', () => {
    const text = `# SESSION_SECRET=\nSTACK_TOKEN=\n`;
    const { text: filled } = fillEmptySecrets(text, { generate: fakeGenerate });
    assert.equal(envValue(filled, 'SESSION_SECRET'), fakeGenerate(32));
    // The comment survives; the real line is appended.
    assert.match(filled, /^# SESSION_SECRET=$/m);
  });

  test('keeps every unrelated line, in order', () => {
    const { text } = fillEmptySecrets(EXAMPLE, { generate: fakeGenerate });
    const lines = text.trimEnd().split('\n');
    assert.equal(lines[0], `SESSION_SECRET=${fakeGenerate(32)}`);
    assert.equal(lines[1], `DB_ENCRYPTION_KEY=${fakeGenerate(32)}`);
    assert.equal(lines[2], `STACK_TOKEN=${fakeGenerate(32)}`);
    assert.equal(lines[3], 'ORBIT_WEB_PORT=8787');
    assert.equal(lines[4], 'ORBIT_API_PORT=0');
    assert.equal(lines[5], 'HERMES_HOME=/root/.hermes');
  });

  test('appends missing keys rather than dropping them', () => {
    const { text } = fillEmptySecrets('ORBIT_WEB_PORT=8787\n', { generate: fakeGenerate });
    assert.equal(envValue(text, 'ORBIT_WEB_PORT'), '8787');
    assert.equal(missingStackSecrets(text).length, 0);
  });

  test('uses the documented byte counts', () => {
    assert.deepEqual(
      REQUIRED_SECRETS.map((s) => [s.key, s.bytes]),
      [
        ['SESSION_SECRET', 32],
        ['DB_ENCRYPTION_KEY', 32],
        ['STACK_TOKEN', 32],
      ],
    );
  });

  test('reports what is still missing', () => {
    assert.deepEqual(missingStackSecrets(EXAMPLE), [
      'SESSION_SECRET',
      'DB_ENCRYPTION_KEY',
      'STACK_TOKEN',
    ]);
    const { text } = fillEmptySecrets(EXAMPLE);
    assert.deepEqual(missingStackSecrets(text), []);
  });
});

describe('envValue / setEnvValue', () => {
  test('reads quoted values and strips trailing comments', () => {
    assert.equal(envValue('A="x y"\n', 'A'), 'x y');
    assert.equal(envValue('A=value # why\n', 'A'), 'value');
    assert.equal(envValue('export A=exported\n', 'A'), 'exported');
    assert.equal(envValue('A=\n', 'A'), null);
    assert.equal(envValue('# A=commented\n', 'A'), null);
  });

  test('replaces in place without touching neighbours', () => {
    const out = setEnvValue('A=1\nB=2\nA=3\n', 'B', '9');
    assert.equal(out, 'A=1\nB=9\nA=3\n');
  });

  test('appends with a newline when the file does not end in one', () => {
    assert.equal(setEnvValue('A=1', 'B', '2'), 'A=1\nB=2\n');
  });
});

describe('allocateLoopbackPort', () => {
  test('returns the port the OS chose and releases the socket', async () => {
    let closed = false;
    const bind: BindFn = async (port, host) => {
      assert.equal(port, 0);
      assert.equal(host, '127.0.0.1');
      return { port: 45789, close: () => void (closed = true) };
    };
    assert.equal(await allocateLoopbackPort({ bind }), 45789);
    assert.equal(closed, true);
  });

  test('retries when a bind races with another process', async () => {
    let attempts = 0;
    const bind: BindFn = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('EADDRINUSE');
      return { port: 50001, close: () => {} };
    };
    assert.equal(await allocateLoopbackPort({ bind }), 50001);
    assert.equal(attempts, 3);
  });

  test('gives up after three attempts with a readable error', async () => {
    const bind: BindFn = async () => {
      throw new Error('EADDRINUSE');
    };
    await assert.rejects(() => allocateLoopbackPort({ bind }), /could not allocate a loopback port: EADDRINUSE/);
  });

  test('really binds a free port through the real net path', async () => {
    const port = await allocateLoopbackPort();
    assert.ok(port > 1024 && port < 65536, `unexpected port ${port}`);
  });
});
