import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { MAX_ARTIFACT_BYTES, artifactArgsOf, type ToolCallBody } from '@orbit/contracts';
import { ARTIFACT_TOOLS, parseArtifact } from '../agent/artifact-tool.js';

const PAGE = '<!doctype html><title>t</title><p>hi</p>';
const ctx = { userId: 'u', botId: 'b', enqueueBotMessage: () => {}, depth: 0 };
const run = (args: Record<string, unknown>) => ARTIFACT_TOOLS[0].impl(args, ctx);

describe('artifact tool', () => {
  test('mints an id when none is given and hands it back to the model', async () => {
    const r = await run({ title: 'Timer', html: PAGE });
    const args = r.rowArgs as { artifactId: string; title: string; html: string };
    assert.match(args.artifactId, /^art_/);
    assert.equal(args.title, 'Timer');
    assert.equal(args.html, PAGE);
    assert.ok(r.output.includes(args.artifactId), 'the model is told the id to revise with');
  });

  test('keeps the id it was given, so a revision is a new version of the same artifact', async () => {
    const first = (await run({ title: 'Timer', html: PAGE })).rowArgs as { artifactId: string };
    const second = (await run({ title: 'Red timer', html: PAGE, artifact_id: first.artifactId })).rowArgs as { artifactId: string };
    assert.equal(second.artifactId, first.artifactId);
  });

  test('two new artifacts get distinct ids', async () => {
    const a = parseArtifact({ title: 'a', html: PAGE });
    const b = parseArtifact({ title: 'b', html: PAGE });
    assert.notEqual(a.artifactId, b.artifactId);
  });

  test('refuses a document over the size limit with a message the model can act on', () => {
    const html = `<!doctype html>${'x'.repeat(MAX_ARTIFACT_BYTES)}`;
    assert.throws(() => parseArtifact({ title: 'big', html }), /KiB limit/);
  });

  test('refuses an empty document', () => {
    assert.throws(() => parseArtifact({ title: 'empty', html: '   ' }), /html is empty/);
  });

  test('refuses an id it never minted', () => {
    assert.throws(() => parseArtifact({ title: 't', html: PAGE, artifact_id: '../etc' }), /not one this tool returned/);
  });

  test('a missing title reads as Untitled', () => {
    assert.equal(parseArtifact({ html: PAGE }).title, 'Untitled');
  });
});

describe('artifactArgsOf', () => {
  const row = (patch: Partial<ToolCallBody>): ToolCallBody => ({ type: 'tool-call', callId: 'c', name: 'artifact', label: 'Building an artifact', status: 'done', ...patch });

  test('reads the canonical args the tool wrote', () => {
    const args = parseArtifact({ title: 'Timer', html: PAGE });
    assert.deepEqual(artifactArgsOf(row({ args })), args);
  });

  test('ignores a refused call, whose args are still the model\'s', () => {
    assert.equal(artifactArgsOf(row({ status: 'error', args: { title: 'x', html: PAGE } })), null);
  });

  test('ignores a running call and other tools', () => {
    const args = parseArtifact({ title: 'Timer', html: PAGE });
    assert.equal(artifactArgsOf(row({ status: 'running', args })), null);
    assert.equal(artifactArgsOf(row({ name: 'save_file', args })), null);
  });
});
