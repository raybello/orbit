import test from 'node:test';
import assert from 'node:assert/strict';
import { list, rec, str } from '../lib/coerce.js';

test('str keeps strings and turns everything else into an empty string', () => {
  assert.equal(str('hi'), 'hi');
  assert.equal(str(''), '');
  for (const v of [null, undefined, 3, true, ['a'], { a: 1 }]) assert.equal(str(v), '');
});

test('rec keeps plain objects and turns arrays, null and primitives into {}', () => {
  const o = { a: 1 };
  assert.equal(rec(o), o);
  for (const v of [null, undefined, 'x', 0, [1, 2], ['a']]) assert.deepEqual(rec(v), {});
});

test('list reads arrays and comma-separated strings as trimmed non-empty strings', () => {
  assert.deepEqual(list([' a@x.com ', '', 'b@x.com', 7]), ['a@x.com', 'b@x.com', '7']);
  assert.deepEqual(list('a@x.com, b@x.com ,,'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(list('   '), []);
  for (const v of [null, undefined, 3, { a: 1 }]) assert.deepEqual(list(v), []);
});
