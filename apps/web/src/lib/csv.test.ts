import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from '../domain/csv.js';

test('quoted fields keep commas, doubled quotes and newlines', () => {
  const { rows } = parseCsv('name,quote\r\n"Ada, Countess","said ""hi""\nthen left"\n');
  assert.deepEqual(rows, [['name', 'quote'], ['Ada, Countess', 'said "hi"\nthen left']]);
});

test('a .tsv splits on tabs, and a byte-order mark is not part of the first header', () => {
  assert.deepEqual(parseCsv('﻿a\tb\n1\t2', 'x.tsv').rows, [['a', 'b'], ['1', '2']]);
});

test('empty fields and a missing final newline survive', () => {
  assert.deepEqual(parseCsv('a,,c\n,,').rows, [['a', '', 'c'], ['', '', '']]);
});

test('stops at the cap and says so', () => {
  const text = Array.from({ length: 50 }, (_, i) => `r${i},${i}`).join('\n');
  const t = parseCsv(text, 'big.csv', 10);
  assert.equal(t.rows.length, 10);
  assert.equal(t.truncated, true);
  assert.equal(parseCsv('a\nb', 'x.csv', 10).truncated, false);
});
