import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  defaultHermesLookup,
  executableFile,
  hermesBin,
  hermesBinPath,
  knownHermesDirs,
  resetHermesBinCache,
  resolveHermesBin,
  type HermesLookup,
} from '../hermes-bin.js';

/**
 * The resolver is what stands between "a bot with an engine" and `spawn hermes ENOENT`. Its
 * search order and its failure message are the contract, so both are tested without needing a
 * real Hermes on this machine: `isExecutable` is injected.
 */

const HOME = '/Users/someone';

function lookup(overrides: Partial<HermesLookup> = {}): HermesLookup {
  return {
    configured: '',
    pathDirs: ['/usr/local/bin'],
    home: HOME,
    knownDirs: knownHermesDirs(HOME),
    // Nothing is installed unless a test says so.
    isExecutable: () => false,
    ...overrides,
  };
}

/** A predicate that "finds" exactly the listed files and treats nothing else as executable. */
function only(...files: string[]): (file: string) => boolean {
  return (file) => files.includes(file);
}

test('HERMES_BIN as an existing path wins over PATH and the known locations', () => {
  const r = resolveHermesBin(
    lookup({
      configured: '/opt/hermes/.venv/bin/hermes',
      isExecutable: only('/opt/hermes/.venv/bin/hermes', '/usr/local/bin/hermes'),
    }),
  );
  assert.deepEqual(r, { found: true, path: '/opt/hermes/.venv/bin/hermes', via: 'HERMES_BIN' });
});

test('HERMES_BIN with ~ resolves against the home directory', () => {
  const r = resolveHermesBin(
    lookup({ configured: '~/bin/hermes', isExecutable: only(path.join(HOME, 'bin', 'hermes')) }),
  );
  assert.deepEqual(r, { found: true, path: path.join(HOME, 'bin', 'hermes'), via: 'HERMES_BIN' });
});

test('a bare HERMES_BIN name is looked up on PATH', () => {
  const r = resolveHermesBin(
    lookup({ configured: 'hermes', pathDirs: ['/a', '/b'], isExecutable: only('/b/hermes') }),
  );
  assert.deepEqual(r, { found: true, path: '/b/hermes', via: 'HERMES_BIN' });
});

test('with HERMES_BIN unset, the first hermes on PATH wins', () => {
  const r = resolveHermesBin(lookup({ pathDirs: ['/a', '/b'], isExecutable: only('/a/hermes', '/b/hermes') }));
  assert.deepEqual(r, { found: true, path: '/a/hermes', via: 'PATH' });
});

test('falls back to the known install locations when PATH has no hermes', () => {
  // The macOS case: the server's PATH is the launchd one, the CLI is in ~/.local/bin.
  const r = resolveHermesBin(lookup({ isExecutable: only(path.join(HOME, '.local', 'bin', 'hermes')) }));
  assert.deepEqual(r, { found: true, path: path.join(HOME, '.local', 'bin', 'hermes'), via: 'known location' });
});

test('the known locations are searched in the documented order', () => {
  const dirs = knownHermesDirs(HOME);
  assert.deepEqual(dirs, [
    path.join(HOME, '.hermes', 'bin'),
    path.join(HOME, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ]);
  const r = resolveHermesBin(lookup({ isExecutable: only('/opt/homebrew/bin/hermes', '/usr/bin/hermes') }));
  assert.deepEqual(r, { found: true, path: '/opt/homebrew/bin/hermes', via: 'known location' });
});

test('a stale HERMES_BIN path does not stop the search, and the failure names it', () => {
  const stale = '/gone/bin/hermes';
  const found = resolveHermesBin(lookup({ configured: stale, isExecutable: only('/usr/bin/hermes') }));
  assert.deepEqual(found, { found: true, path: '/usr/bin/hermes', via: 'known location' });

  const missing = resolveHermesBin(lookup({ configured: stale }));
  assert.equal(missing.found, false);
  assert.match(missing.found === false ? missing.message : '', /HERMES_BIN \("\/gone\/bin\/hermes"\)/);
});

test('missing entirely: the error is actionable, not ENOENT', () => {
  const r = resolveHermesBin(lookup({ pathDirs: ['/usr/local/sbin', '/usr/bin'] }));
  assert.equal(r.found, false);
  if (r.found) return;
  const msg = r.message;
  // Names the env var and the fact that nothing was set...
  assert.match(msg, /HERMES_BIN is not set/);
  // ...every place it looked...
  assert.match(msg, /\/usr\/local\/sbin\/hermes/);
  assert.match(msg, /\/usr\/bin\/hermes/);
  assert.match(msg, /\.hermes\/bin\/hermes/);
  assert.match(msg, /\.local\/bin\/hermes/);
  assert.match(msg, /\/opt\/homebrew\/bin\/hermes/);
  // ...and the fix.
  assert.match(msg, /install\.sh/);
  assert.match(msg, /HERMES_BIN=\$HOME\/\.local\/bin\/hermes/);
  assert.match(msg, /HERMES_BIN=\/opt\/hermes\/\.venv\/bin\/hermes/);
  assert.doesNotMatch(msg, /ENOENT/);
  assert.deepEqual(r.searched, [
    '/usr/local/sbin/hermes',
    '/usr/bin/hermes',
    path.join(HOME, '.hermes', 'bin', 'hermes'),
    path.join(HOME, '.local', 'bin', 'hermes'),
    '/usr/local/bin/hermes',
    '/opt/homebrew/bin/hermes',
  ]);
});

test('defaultHermesLookup reads HERMES_BIN and PATH from the environment', () => {
  const before = { bin: process.env.HERMES_BIN, path: process.env.PATH };
  try {
    process.env.HERMES_BIN = '  /opt/h/hermes  ';
    process.env.PATH = '/one:/two';
    const l = defaultHermesLookup({ home: HOME });
    assert.equal(l.configured, '/opt/h/hermes');
    assert.deepEqual(l.pathDirs, ['/one', '/two']);
  } finally {
    if (before.bin === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = before.bin;
    if (before.path === undefined) delete process.env.PATH;
    else process.env.PATH = before.path;
  }
});

test('executableFile accepts an executable file and rejects a plain file and a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-hermes-bin-'));
  try {
    const exe = path.join(dir, 'hermes');
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(exe, 0o755);
    const plain = path.join(dir, 'not-executable');
    fs.writeFileSync(plain, 'text', { mode: 0o644 });
    fs.chmodSync(plain, 0o644);

    assert.equal(executableFile(exe), true);
    assert.equal(executableFile(plain), false);
    assert.equal(executableFile(dir), false);
    assert.equal(executableFile(path.join(dir, 'absent')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hermesBin caches a success for the process and does not cache a miss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-hermes-cache-'));
  resetHermesBinCache();
  try {
    const exe = path.join(dir, 'hermes');
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(exe, 0o755);

    const empty = lookup({ pathDirs: [dir], knownDirs: [] });
    assert.throws(() => hermesBin(empty), /Hermes is not installed where this server can run it/);
    assert.equal(hermesBinPath(empty), null);

    const real = lookup({ pathDirs: [dir], knownDirs: [], isExecutable: executableFile });
    assert.equal(hermesBin(real), exe);
    // A second lookup that would fail still answers from the cache: the answer cannot change mid-run.
    assert.equal(hermesBin(lookup({ pathDirs: ['/nowhere'], knownDirs: [], isExecutable: () => false })), exe);
  } finally {
    resetHermesBinCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
