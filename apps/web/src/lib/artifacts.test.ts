import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArtifactId, Row, RowBody } from '@orbit/contracts';
import { artifactFilename, artifactsOf, latestArtifact, versionOf } from '../domain/artifacts.js';

const row = (seq: number, body: RowBody): Row => ({ botId: 'b', generation: 1, seq, updatedSeq: seq, kind: body.type, body, createdAt: seq * 1000 });
const art = (seq: number, artifactId: string, title: string, status: 'done' | 'running' | 'error' = 'done') =>
  row(seq, { type: 'tool-call', callId: `c${seq}`, name: 'artifact', label: 'Building an artifact', status, args: { artifactId, title, html: `<p>${title}</p>` } });
const A = 'art_aaaaaaaa' as ArtifactId;
const B = 'art_bbbbbbbb' as ArtifactId;

test('versions group by artifact id in seq order, whatever order the rows arrive in', () => {
  const m = artifactsOf([art(5, A, 'v2'), art(2, A, 'v1'), art(3, B, 'other')]);
  assert.deepEqual(m.get(A)!.map((v) => v.title), ['v1', 'v2']);
  assert.deepEqual(m.get(B)!.map((v) => v.seq), [3]);
});

test('messages, other tools, unfinished and refused calls are not artifacts', () => {
  const m = artifactsOf([
    row(1, { type: 'message', role: 'user', text: 'hi' }),
    row(2, { type: 'tool-call', callId: 'x', name: 'save_file', label: 'Saving', status: 'done', args: { artifactId: A, title: 't', html: 'h' } }),
    art(3, A, 'running', 'running'),
    art(4, A, 'refused', 'error'),
    row(5, { type: 'tool-call', callId: 'y', name: 'artifact', label: 'Building an artifact', status: 'done', args: { title: 'no id', html: 'h' } }),
  ]);
  assert.equal(m.size, 0);
});

test('versionOf numbers a row within its artifact', () => {
  const m = artifactsOf([art(1, A, 'v1'), art(4, A, 'v2'), art(9, A, 'v3')]);
  assert.deepEqual(versionOf(m, A, 4), { n: 2, of: 3 });
  assert.equal(versionOf(m, A, 2), null);
  assert.equal(versionOf(m, B, 4), null);
});

test('latestArtifact is the one written most recently, even when it was created first', () => {
  const m = artifactsOf([art(1, A, 'a1'), art(2, B, 'b1'), art(3, A, 'a2')]);
  assert.equal(latestArtifact(m), A);
  assert.equal(latestArtifact(new Map()), null);
});

test('artifactFilename makes a safe .html name from the title', () => {
  assert.equal(artifactFilename('Pomodoro Timer!'), 'pomodoro-timer.html');
  assert.equal(artifactFilename('  ../../etc  '), 'etc.html');
  assert.equal(artifactFilename('***'), 'artifact.html');
});
