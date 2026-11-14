import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearSetup, readSetup, setupFilePath, writeSetup } from '../setup-store';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-setup-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('setup-store', () => {
  test('round-trips a local setup', () => {
    writeSetup(dir, { mode: 'new' });
    const read = readSetup(dir);
    assert.equal(read?.mode, 'new');
    assert.equal(typeof read?.createdAt, 'number');
  });

  test('round-trips an existing-instance setup', () => {
    writeSetup(dir, { mode: 'existing', serverUrl: 'https://orbit.example.com' });
    assert.deepEqual(
      { mode: readSetup(dir)?.mode, serverUrl: readSetup(dir)?.serverUrl },
      { mode: 'existing', serverUrl: 'https://orbit.example.com' },
    );
  });

  test('writes the file 0600', { skip: process.platform === 'win32' }, () => {
    writeSetup(dir, { mode: 'new' });
    const mode = fs.statSync(setupFilePath(dir)).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  });

  test('the directory is private too', { skip: process.platform === 'win32' }, () => {
    const nested = path.join(dir, 'profile');
    writeSetup(nested, { mode: 'new' });
    assert.equal((fs.statSync(nested).mode & 0o777).toString(8), '700');
  });

  test('a missing file reads as null', () => {
    assert.equal(readSetup(dir), null);
  });

  test('a truncated file reads as null instead of throwing', () => {
    fs.writeFileSync(setupFilePath(dir), '{"mode":"new"');
    assert.equal(readSetup(dir), null);
  });

  test('a wrong-mode file reads as null', () => {
    fs.writeFileSync(setupFilePath(dir), JSON.stringify({ mode: 'cloud' }));
    assert.equal(readSetup(dir), null);
  });

  test('refuses to write an existing-instance setup with no URL', () => {
    assert.throws(() => writeSetup(dir, { mode: 'existing' }), /valid serverUrl/);
  });

  test('refuses to write a bogus mode', () => {
    // @ts-expect-error deliberately invalid
    assert.throws(() => writeSetup(dir, { mode: 'cloud' }), /mode must be/);
  });

  test('clearSetup removes the file', () => {
    writeSetup(dir, { mode: 'new' });
    clearSetup(dir);
    assert.equal(readSetup(dir), null);
    // Idempotent: clearing twice is not an error.
    clearSetup(dir);
  });
});
