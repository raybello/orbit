import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installLogFile } from '../log-file';

function fakeConsole() {
  const seen: string[] = [];
  const sink = (...args: unknown[]) => void seen.push(args.join(' '));
  return { seen, target: { log: sink, info: sink, warn: sink, error: sink } };
}

test('every console line still reaches the console and is appended to main.log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-log-'));
  const { seen, target } = fakeConsole();
  const file = installLogFile(dir, { target });
  target.log('[orbit:stack]', 'pulling');
  target.error('[orbit:main]', 'boot failed', { code: 7 });
  assert.deepEqual(seen, ['[orbit:stack] pulling', '[orbit:main] boot failed [object Object]']);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.* \[orbit:stack\] pulling$/);
  assert.match(lines[1], /\[orbit:main\] boot failed \{ code: 7 \}$/);
});

test('a log past the size limit is rotated to main.old.log at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-log-'));
  fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(64));
  const { target } = fakeConsole();
  installLogFile(dir, { target, maxBytes: 32 });
  target.info('fresh');
  assert.equal(fs.readFileSync(path.join(dir, 'main.old.log'), 'utf8').length, 64);
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf8'), /fresh\n$/);
});
