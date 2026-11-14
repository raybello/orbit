import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCAL_WEB_URL,
  normalizeServerUrl,
  resolveStartupTarget,
  sessionPartitionForServerUrl,
} from '../setup-config';

describe('normalizeServerUrl', () => {
  test('adds http for loopback names with a port', () => {
    assert.equal(normalizeServerUrl('localhost:8787'), 'http://localhost:8787');
    assert.equal(normalizeServerUrl('127.0.0.1:8787'), 'http://127.0.0.1:8787');
    assert.equal(normalizeServerUrl('mac-mini.local:8787'), 'http://mac-mini.local:8787');
  });

  test('adds https for a bare public host', () => {
    assert.equal(normalizeServerUrl('orbit.example.com'), 'https://orbit.example.com');
    assert.equal(normalizeServerUrl('orbit.example.com:8443'), 'https://orbit.example.com:8443');
  });

  test('reduces a full URL to its origin', () => {
    assert.equal(normalizeServerUrl('https://orbit.example.com/app/chat?x=1#h'), 'https://orbit.example.com');
    assert.equal(normalizeServerUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  });

  test('trims whitespace, quotes and angle brackets from pasted URLs', () => {
    assert.equal(normalizeServerUrl('  <https://orbit.example.com>  '), 'https://orbit.example.com');
    assert.equal(normalizeServerUrl('"localhost:8787"'), 'http://localhost:8787');
  });

  test('lowercases the host but keeps an explicit scheme', () => {
    assert.equal(normalizeServerUrl('HTTP://Orbit.Example.COM'), 'http://orbit.example.com');
  });

  test('drops credentials rather than storing them', () => {
    assert.equal(normalizeServerUrl('http://user:pass@orbit.example.com:9000/x'), 'http://orbit.example.com:9000');
  });

  test('rejects things that are not http(s) URLs', () => {
    for (const input of ['', '   ', 'ftp://orbit.example.com', 'not a url', 'javascript:alert(1)', 'https://']) {
      assert.equal(normalizeServerUrl(input), null, `expected null for ${JSON.stringify(input)}`);
    }
    assert.equal(normalizeServerUrl(null), null);
    assert.equal(normalizeServerUrl(undefined), null);
  });
});

describe('resolveStartupTarget', () => {
  test('ORBIT_WEB_URL wins over a saved setup', () => {
    const target = resolveStartupTarget({
      saved: { mode: 'existing', serverUrl: 'https://saved.example.com' },
      env: { ORBIT_WEB_URL: 'https://env.example.com' },
    });
    assert.deepEqual(target, { kind: 'app', url: 'https://env.example.com' });
  });

  test('an explicit envUrl argument wins over ORBIT_WEB_URL', () => {
    const target = resolveStartupTarget({
      envUrl: 'http://127.0.0.1:9999',
      env: { ORBIT_WEB_URL: 'https://env.example.com' },
    });
    assert.deepEqual(target, { kind: 'app', url: 'http://127.0.0.1:9999' });
  });

  test('falls back to the saved existing-instance URL', () => {
    const target = resolveStartupTarget({ saved: { mode: 'existing', serverUrl: 'orbit.example.com' } });
    assert.deepEqual(target, { kind: 'app', url: 'https://orbit.example.com' });
  });

  test('a local setup resolves to the default local URL', () => {
    assert.deepEqual(resolveStartupTarget({ saved: { mode: 'new' } }), {
      kind: 'app',
      url: DEFAULT_LOCAL_WEB_URL,
    });
  });

  test('a local setup honours a saved local URL', () => {
    const target = resolveStartupTarget({ saved: { mode: 'new', serverUrl: 'http://127.0.0.1:9123' } });
    assert.deepEqual(target, { kind: 'app', url: 'http://127.0.0.1:9123' });
  });

  test('no setup means the setup window', () => {
    assert.deepEqual(resolveStartupTarget({}), { kind: 'setup' });
    assert.deepEqual(resolveStartupTarget({ saved: null }), { kind: 'setup' });
  });

  test('a corrupt existing setup means the setup window, not a blank app window', () => {
    assert.deepEqual(resolveStartupTarget({ saved: { mode: 'existing', serverUrl: 'not a url' } }), {
      kind: 'setup',
    });
  });

  test('an unparseable ORBIT_WEB_URL is ignored', () => {
    const target = resolveStartupTarget({
      saved: { mode: 'existing', serverUrl: 'https://saved.example.com' },
      env: { ORBIT_WEB_URL: 'not a url' },
    });
    assert.deepEqual(target, { kind: 'app', url: 'https://saved.example.com' });
  });
});

describe('sessionPartitionForServerUrl', () => {
  test('is stable for the same origin', () => {
    const a = sessionPartitionForServerUrl('https://orbit.example.com');
    const b = sessionPartitionForServerUrl('orbit.example.com/');
    assert.equal(a, b);
    assert.match(a, /^persist:orbit-[0-9a-f]{24}$/);
  });

  test('ignores the path, so a deep link keeps the login', () => {
    assert.equal(
      sessionPartitionForServerUrl('https://orbit.example.com/a'),
      sessionPartitionForServerUrl('https://orbit.example.com/b/c?d=1'),
    );
  });

  test('differs per origin', () => {
    assert.notEqual(
      sessionPartitionForServerUrl('https://orbit.example.com'),
      sessionPartitionForServerUrl('http://orbit.example.com'),
    );
    assert.notEqual(
      sessionPartitionForServerUrl('http://127.0.0.1:8787'),
      sessionPartitionForServerUrl('http://127.0.0.1:8788'),
    );
  });

  test('matches a known digest prefix', () => {
    // sha256("http://127.0.0.1:8787") — pinned so a refactor cannot silently log everyone out.
    assert.equal(
      sessionPartitionForServerUrl('http://127.0.0.1:8787'),
      'persist:orbit-b1a61bf29a38ff3642af0dad',
    );
  });
});
