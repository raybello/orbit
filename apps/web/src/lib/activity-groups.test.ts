import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityItem } from '@orbit/contracts';
import { groupActivity } from '../domain/activity-feed.js';

/** A newest-first feed from a compact spec: "a b b" is a's entry, then two of b's, oldest last. */
function feed(spec: string): ActivityItem[] {
  const bots = spec.split(' ').filter(Boolean);
  return bots.map((botId, i) => ({ botId, botName: botId.toUpperCase(), kind: 'message', preview: `${botId}-${i}`, at: 10_000 - i * 100, seq: bots.length - i }));
}

const shape = (items: ActivityItem[]) => groupActivity(items).map((g) => `${g.botId}:${g.items.map((i) => i.preview).join(',')}`);

const CASES: { name: string; spec: string; groups: string[] }[] = [
  { name: 'an empty feed has no groups', spec: '', groups: [] },
  { name: 'a single entry is a group of one', spec: 'a', groups: ['a:a-0'] },
  { name: 'consecutive entries from one bot form one group, newest first', spec: 'a a a', groups: ['a:a-0,a-1,a-2'] },
  { name: 'another bot in between starts a new group', spec: 'a b a', groups: ['a:a-0', 'b:b-1', 'a:a-2'] },
  { name: 'runs of different lengths keep their own counts', spec: 'a a b b b a', groups: ['a:a-0,a-1', 'b:b-2,b-3,b-4', 'a:a-5'] },
  { name: 'alternating bots never merge', spec: 'a b a b', groups: ['a:a-0', 'b:b-1', 'a:a-2', 'b:b-3'] },
];

for (const c of CASES) {
  test(c.name, () => {
    assert.deepEqual(shape(feed(c.spec)), c.groups);
  });
}

test('every entry lands in exactly one group, in feed order', () => {
  const items = feed('a a b c c c a b');
  assert.deepEqual(groupActivity(items).flatMap((g) => g.items), items);
});

test('a group keeps its key when a newer entry from the same bot joins it', () => {
  const older = feed('a a b');
  const newer: ActivityItem = { botId: 'a', botName: 'A', kind: 'working', preview: 'Working on it', at: 20_000 };
  const before = groupActivity(older);
  const after = groupActivity([newer, ...older]);

  assert.equal(after[0].items[0], newer, 'the newest entry is the latest status');
  assert.equal(after[0].key, before[0].key);
  assert.equal(after[1].key, before[1].key);
});

test('groups have distinct keys', () => {
  const keys = groupActivity(feed('a b a b a')).map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length);
});
