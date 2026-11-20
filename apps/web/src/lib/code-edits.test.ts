import assert from 'node:assert/strict';
import test from 'node:test';
import type { Row } from '@orbit/contracts';
import { codeEditsOf, lineDiff, withContext } from '../domain/code-edits.js';

const call = (seq: number, name: string, args: unknown, status: 'done' | 'error' = 'done'): Row => ({
  botId: 'b', generation: 1, seq, updatedSeq: seq, kind: 'tool-call', createdAt: seq,
  body: { type: 'tool-call', callId: `c${seq}`, name, label: '', status, args },
});

test('a write then a replace replays to the final file, as Atlas did it live', () => {
  const [f] = codeEditsOf([
    call(32, 'write_file', { path: 'scratch/fizz.py', content: 'if i % 5 == 0:\n    out += "Buzz"\nprint(out)\n' }),
    call(33, 'patch', { path: 'scratch/fizz.py', old_string: 'if i % 5 == 0:\n    out += "Buzz"', new_string: 'if i % 5 == 0:\n    out += "Buzz"\nif i % 7 == 0:\n    out += "Bazz"' }),
  ]);
  assert.equal(f.path, 'scratch/fizz.py');
  assert.deepEqual(f.edits.map((e) => e.kind), ['write', 'replace']);
  assert.equal(f.content, 'if i % 5 == 0:\n    out += "Buzz"\nif i % 7 == 0:\n    out += "Bazz"\nprint(out)\n');
});

test('an overwrite remembers the file it replaced', () => {
  const [f] = codeEditsOf([call(1, 'write_file', { path: 'a', content: 'v1' }), call(2, 'write_file', { path: 'a', content: 'v2' })]);
  assert.deepEqual(f.edits.map((e) => e.kind === 'write' && e.previous), [null, 'v1']);
  assert.equal(f.content, 'v2');
});

test('replace_all replaces every match', () => {
  const [f] = codeEditsOf([call(1, 'write_file', { path: 'a', content: 'x x x' }), call(2, 'patch', { path: 'a', old_string: 'x', new_string: 'y', replace_all: true })]);
  assert.equal(f.content, 'y y y');
});

test('the file is unknown when an edit cannot be replayed exactly, or the first edit is not a write', () => {
  const [missed] = codeEditsOf([call(1, 'write_file', { path: 'a', content: 'abc' }), call(2, 'patch', { path: 'a', old_string: 'zzz', new_string: 'q' })]);
  assert.equal(missed.content, null);
  const [unseen] = codeEditsOf([call(1, 'patch', { path: 'b', old_string: 'x', new_string: 'y' })]);
  assert.equal(unseen.content, null);
  assert.equal(unseen.edits.length, 1);
});

test('a V4A patch is listed under every file it names and leaves their contents unknown', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+new\n*** Move File: old.ts -> src/c.ts\n*** End Patch';
  const files = codeEditsOf([call(1, 'write_file', { path: 'src/a.ts', content: 'x' }), call(2, 'patch', { mode: 'patch', patch })]);
  assert.deepEqual(files.map((f) => f.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(files[0].content, null);
});

test('failed calls, other tools and calls without content are skipped', () => {
  assert.deepEqual(codeEditsOf([
    call(1, 'write_file', { path: 'a', content: 'x' }, 'error'),
    call(2, 'terminal', { command: 'ls' }),
    call(3, 'write_file', { path: 'a' }),
    call(4, 'patch', { path: 'a', old_string: 'x' }),
  ]), []);
});

test('lineDiff keeps shared lines and marks what changed', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), [
    { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'B' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' },
  ]);
  assert.deepEqual(lineDiff('', 'new'), [{ op: '+', text: 'new' }]);
  assert.deepEqual(lineDiff('same', 'same'), [{ op: ' ', text: 'same' }]);
});

test('lineDiff on a 5,000-line file with one changed line stays exact and quick', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const after = [...lines]; after[2500] = 'changed';
  const s = performance.now();
  const d = lineDiff(lines.join('\n'), after.join('\n'));
  assert.ok(performance.now() - s < 200, 'under 200 ms');
  assert.deepEqual(d.filter((l) => l.op !== ' '), [{ op: '-', text: 'line 2500' }, { op: '+', text: 'changed' }]);
});

test('withContext folds long unchanged runs around each change', () => {
  const d = lineDiff(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 20 }, (_, i) => (i === 10 ? 'X' : `l${i}`)).join('\n'));
  const items = withContext(d, 2);
  assert.deepEqual(items.map((x) => (x.op === 'gap' ? `gap${x.count}` : x.op)), ['gap8', ' ', ' ', '-', '+', ' ', ' ', 'gap7']);
  assert.deepEqual(withContext(lineDiff('', 'a\nb')), [{ op: '+', text: 'a' }, { op: '+', text: 'b' }]);
});
