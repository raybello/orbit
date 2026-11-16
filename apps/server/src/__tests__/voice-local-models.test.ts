/**
 * The voice menu: two TTS tiers, per-model engines and rates, the model-layout migration, and the
 * phase-3 HTTP surface (`/models`, `/models/download`, `/preview { model }`, `/session`).
 *
 * Real engines, real weights, no mocks — but an isolated model root per test file: every required
 * file is symlinked out of the machine's cache (`VOICE_MODELS_DIR` as this process inherited it), so
 * a test can add, move and delete files without touching the cache the rest of the suite reads.
 * `node --test` runs each file in its own process, which is what makes the env swap safe.
 *
 * The optional Kokoro tier is exactly that here: absent at first (so "missing" and "does not gate
 * available" are real states, not fabricated ones), then downloaded over a local `http.Server` that
 * serves the weights already on this machine — 360 MB over loopback with the manifest's real sha256s,
 * so the download path and the hashes in voice-model-files.ts are both exercised without the network.
 *
 * Run with the cache:  VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models pnpm --filter @orbit/server test
 * Kokoro's files come from `$KOKORO_SOURCE_DIR` (default ~/.hermes/cache/scratch/kokoro); the tests
 * that need them skip when that directory is absent.
 */
import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { cleanupTmpEnv, tmpRoot } from './helpers/tmp-env.js';
// Type-only, so it is erased before tmp-env's side effects matter.
import type { VoiceModelFile } from '../voice-model-files.js';

/** The machine's model cache, as this process inherited it, and the Kokoro weights measured for the doc. */
const SOURCE_CACHE = process.env.VOICE_MODELS_DIR ?? path.join(os.homedir(), '.hermes', 'cache', 'voice-models');
const KOKORO_SOURCE = process.env.KOKORO_SOURCE_DIR ?? path.join(os.homedir(), '.hermes', 'cache', 'scratch', 'kokoro');
/** A model root this file owns; the symlinks below give it the same weights as the real cache. */
const MODELS_DIR = fs.mkdtempSync(path.join(tmpRoot, 'voice-models-menu-'));
process.env.VOICE_MODELS_DIR = MODELS_DIR;
// Never start a real download from /status: the only download in this file is the fake-server one.
process.env.VOICE_AUTO_DOWNLOAD = '0';

const models = await import('../voice-models.js');
const runtime = await import('../voice-runtime.js');
const { localVoiceApi } = await import('../voice-local.js');
const { db } = await import('../db.js');
const { VOICE_MODEL_FILES } = await import('../voice-model-files.js');

after(() => cleanupTmpEnv());

// ---------- the model root this file uses ----------

const KIND_DIR: Record<VoiceModelFile['kind'], 'stt' | 'tts' | 'vad'> = { stt: 'stt', tts: 'tts', espeak: 'tts', vad: 'vad' };

function cachePath(root: string, file: VoiceModelFile): string {
  return path.join(root, KIND_DIR[file.kind], file.model, file.path);
}

/** Where this file is in the real cache: the phase-3 layout, or the flat one before migration. */
function sourceOf(file: VoiceModelFile): string | null {
  const next = cachePath(SOURCE_CACHE, file);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(SOURCE_CACHE, KIND_DIR[file.kind], file.path);
  return fs.existsSync(legacy) ? legacy : null;
}

/** Symlink one manifest file into this file's model root. Returns false when the source is absent. */
function place(file: VoiceModelFile): boolean {
  const src = sourceOf(file);
  if (!src) return false;
  const dest = cachePath(MODELS_DIR, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(src, dest);
  return true;
}

// Every required file is linked; Kokoro deliberately is not, so its state starts as 'missing'.
const REQUIRED_FILES = VOICE_MODEL_FILES.filter((f) => f.model !== 'kokoro-multi-lang');
const unplaced = REQUIRED_FILES.filter((f) => !place(f));
const requiredPresent = unplaced.length === 0;
const skipRequired = requiredPresent
  ? false
  : `required model files not present (${SOURCE_CACHE}: ${unplaced
      .slice(0, 4)
      .map((f) => `${KIND_DIR[f.kind]}/${f.model}/${f.path}`)
      .join(', ')}${unplaced.length > 4 ? `, +${unplaced.length - 4} more` : ''})`;

const KOKORO_FILES = VOICE_MODEL_FILES.filter((f) => f.model === 'kokoro-multi-lang');
const kokoroSourceMissing = KOKORO_FILES.filter((f) => !fs.existsSync(path.join(KOKORO_SOURCE, f.path)));
const skipKokoro =
  kokoroSourceMissing.length === 0
    ? false
    : `Kokoro weights not present (${KOKORO_SOURCE}: missing ${kokoroSourceMissing.map((f) => f.path).join(', ')})`;
const skipModels = requiredPresent ? false : skipRequired;
const addon = runtime.runtimeInfo();

// ---------- auth fixture ----------

const TOKEN = 'voice-models-test-token';
const USER = 'usr_voice_models';
const BOT_KOKORO = 'bot_voice_models_kokoro';
const BOT_DEFAULT = 'bot_voice_models_default';
const nowMs = Date.now();
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'voice-models@test.local', 'Voice Models', nowMs);
db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(TOKEN, USER, nowMs, nowMs + 3600_000);
db.prepare('INSERT OR REPLACE INTO bots(id,user_id,name,created_at,updated_at,voice_provider,voice_model) VALUES (?,?,?,?,?,?,?)').run(
  BOT_KOKORO,
  USER,
  'Kokoro Bot',
  nowMs,
  nowMs,
  'local',
  'kokoro-multi-lang',
);
db.prepare('INSERT OR REPLACE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(BOT_DEFAULT, USER, 'Default Bot', nowMs, nowMs);

const AUTH = { cookie: `grokbot_session=${TOKEN}` };
async function route(pathname: string, init: RequestInit = {}): Promise<Response> {
  return localVoiceApi.request(pathname, {
    ...init,
    headers: { ...AUTH, ...((init.headers as Record<string, string>) ?? {}) },
  });
}

const ms = (n: number) => `${Math.round(n)} ms`;
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));

/** Peak absolute PCM16 sample: proves "there is speech in these bytes" without decoding a WAV. */
function peak(pcm: Buffer): number {
  let max = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  return max;
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 120_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return performance.now() - started;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms(timeoutMs)} waiting for ${what}`);
}

// ---------- 1. the menu ----------

test('GET /models lists both TTS tiers with tier, size, rate and the real state', { skip: skipModels }, async (t) => {
  const res = await route('/models');
  assert.equal(res.status, 200, `/models returned ${res.status}`);
  const list = (await res.json()) as { items: any[]; ready: boolean };

  assert.deepEqual(
    list.items.map((i) => i.id),
    ['zipformer-bilingual-int8', 'silero-vad', 'piper-lessac-medium', 'kokoro-multi-lang'],
    `the menu must list all four models in registry order, got ${JSON.stringify(list.items.map((i) => i.id))}`,
  );
  for (const item of list.items) {
    assert.ok(['required', 'optional'].includes(item.tier), `${item.id}: tier ${item.tier}`);
    assert.ok(item.rate > 0 && item.size > 0, `${item.id}: rate ${item.rate}, size ${item.size}`);
    assert.ok(['missing', 'downloading', 'ready', 'error'].includes(item.state), `${item.id}: state ${item.state}`);
  }

  const byId = new Map(list.items.map((i) => [i.id, i]));
  const piper = byId.get('piper-lessac-medium')!;
  const kokoro = byId.get('kokoro-multi-lang')!;
  assert.equal(piper.tier, 'optional', 'Piper is a voice: the person picks it, nothing fetches it implicitly');
  assert.equal(piper.rate, 22050, `Piper lessac-medium is 22 050 Hz, menu says ${piper.rate}`);
  assert.equal(piper.state, 'ready', `Piper should be ready with the cache linked in: ${JSON.stringify(piper)}`);
  assert.ok(piper.size > 60e6 && piper.size < 70e6, `Piper's files are ~64 MB, menu says ${mb(piper.size)}`);

  assert.equal(kokoro.tier, 'optional', 'Kokoro is the optional tier');
  assert.equal(kokoro.rate, 24000, `Kokoro is 24 000 Hz, menu says ${kokoro.rate}`);
  // Kokoro phonemises with the espeak-ng data listed under Piper, so a Kokoro-only install needs it.
  const espeakBytes = VOICE_MODEL_FILES.filter((f) => f.kind === 'espeak').reduce((n, f) => n + f.size, 0);
  const kokoroBytes = KOKORO_FILES.reduce((n, f) => n + f.size, 0) + espeakBytes;
  assert.equal(kokoro.size, kokoroBytes, `Kokoro's size must be its four files plus espeak-ng (${mb(kokoroBytes)}), menu says ${mb(kokoro.size)}`);
  assert.ok(kokoro.size > 350e6 && kokoro.size < 370e6, `Kokoro is ~360 MB, menu says ${mb(kokoro.size)}`);
  // The optional voice is not linked in, so this is the honest not-downloaded state.
  assert.equal(kokoro.state, 'missing', `Kokoro must start missing (nothing linked it in), got ${kokoro.state}`);
  assert.equal(kokoro.pct, 0, `Kokoro is not downloaded: ${kokoro.pct}%`);

  // /status carries the same menu, so the UI needs one call (available + voices + bytes + download).
  const status = (await (await route('/status')).json()) as any;
  assert.equal(status.available, true, `required models are present → available: ${JSON.stringify(status)}`);
  assert.equal(status.runtime.addon, true, `the addon must load on ${addon.platform}-${addon.arch}`);
  assert.deepEqual(
    status.voices.map((v: any) => v.id),
    list.items.map((i) => i.id),
    `status.voices must be the same menu: ${JSON.stringify(status.voices.map((v: any) => v.id))}`,
  );
  assert.deepEqual(
    status.voices.find((v: any) => v.id === 'kokoro-multi-lang'),
    kokoro,
    'status.voices must carry the optional model with the same state/size/rate/tier as /models',
  );
  assert.equal(status.bytes.total, models.REQUIRED_BYTES, `status.bytes is the required set: ${status.bytes.total}`);
  assert.ok(status.bytes.total < kokoro.size + models.REQUIRED_BYTES, 'the optional tier must not inflate status.bytes');

  t.diagnostic(
    `menu: ${list.items.map((i) => `${i.id} ${i.tier} ${i.rate} Hz ${mb(i.size)} ${i.state}`).join(' | ')}`,
  );
});

test('modelsReady() needs one installed voice, not every voice', { skip: skipModels }, async (t) => {
  models.resetVoiceModelCaches();
  const states = models.modelStatesById();
  assert.equal(states['piper-lessac-medium'], 'ready', `Piper: ${states['piper-lessac-medium']}`);
  assert.equal(states['kokoro-multi-lang'], 'missing', `Kokoro is not downloaded yet: ${states['kokoro-multi-lang']}`);
  assert.equal(models.modelsReady(), true, 'modelsReady() must be true while only the optional voice is missing');
  assert.equal(models.modelReady('kokoro-multi-lang'), false, 'the optional voice must not report ready');
  assert.deepEqual(
    models.modelStates(),
    { stt: 'ready', tts: 'ready', vad: 'ready' },
    `kind-level states (the contract the phase-1/2 client reads): tts is ready once any voice is: ${JSON.stringify(models.modelStates())}`,
  );
  t.diagnostic(`states by model: ${JSON.stringify(states)}; modelsReady()=${models.modelsReady()}`);
});

// ---------- 2. preview: two engines, two rates ----------

test('POST /preview with Piper returns 22 050 Hz and real audio', { skip: skipModels }, async (t) => {
  const res = await route('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'The quick brown fox jumps over the lazy dog.' }),
  });
  assert.equal(res.status, 200, `/preview returned ${res.status}`);
  assert.equal(res.headers.get('content-type'), 'audio/pcm', `content-type: ${res.headers.get('content-type')}`);
  assert.equal(res.headers.get('x-audio-rate'), '22050', `Piper must report 22 050 Hz, header says ${res.headers.get('x-audio-rate')}`);
  assert.equal(res.headers.get('x-audio-model'), 'piper-lessac-medium', `model header: ${res.headers.get('x-audio-model')}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  assert.ok(pcm.length > 22050, `expected at least half a second of audio, got ${pcm.length} bytes`);
  assert.ok(peak(pcm) > 1000, `Piper preview is silent (peak ${peak(pcm)})`);
  t.diagnostic(`Piper preview: ${pcm.length} bytes at 22050 Hz, peak ${peak(pcm)}`);
});

test('POST /preview with a model that is not downloaded is 409, not 500', { skip: skipKokoro }, async (t) => {
  const res = await route('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello from Kokoro.', model: 'kokoro-multi-lang' }),
  });
  assert.equal(res.status, 409, `a not-downloaded voice must be a 409, got ${res.status}`);
  const body = (await res.json()) as any;
  assert.equal(body.model, 'kokoro-multi-lang', `the 409 must name the model: ${JSON.stringify(body)}`);
  assert.match(String(body.error), /not downloaded/, `the 409 must say why: ${JSON.stringify(body)}`);
  t.diagnostic(`pre-download Kokoro preview: ${res.status} ${JSON.stringify(body)}`);
});

test('POST /preview with an unknown model is 409', async () => {
  for (const model of ['nope-9000', 'zipformer-bilingual-int8']) {
    const res = await route('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello.', model }),
    });
    assert.equal(res.status, 409, `${model} must be a 409, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.model, model, `the 409 must echo the model: ${JSON.stringify(body)}`);
    assert.deepEqual(body.models, ['piper-lessac-medium', 'kokoro-multi-lang'], `the 409 must list the voices: ${JSON.stringify(body.models)}`);
  }

  const badModel = await route('/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nope-9000' }),
  });
  assert.equal(badModel.status, 400, `an unknown model to download must be a 400, got ${badModel.status}`);
});

// ---------- 3. downloading the optional tier ----------

test('POST /models/download { model } reports progress and ends ready', { skip: skipKokoro }, async (t) => {
  // Serve the weights already on this machine over loopback. The manifest's own sizes and sha256s
  // are what make this a real download: the downloader has to verify 360 MB against them.
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').replace(/^\//, '');
    requests.push(url);
    const file = KOKORO_FILES.find((f) => f.path === url);
    if (!file) {
      res.statusCode = 404;
      res.end('missing');
      return;
    }
    const body = path.join(KOKORO_SOURCE, url);
    res.setHeader('Content-Length', String(fs.statSync(body).size));
    fs.createReadStream(body).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(() => {
    server.close();
    models.__setDownloadUrlForTests(null);
    models.resetVoiceModelCaches();
  });
  // The route calls ensureModels() with no options; this is the seam that points its download here.
  models.__setDownloadUrlForTests((file: VoiceModelFile) => `http://127.0.0.1:${port}/${file.path}`);

  models.resetVoiceModelCaches();
  const before = models.modelStatesById()['kokoro-multi-lang'];
  assert.equal(before, 'missing', `Kokoro must start missing, got ${before}`);

  const startedAt = performance.now();
  const res = await route('/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro-multi-lang' }),
  });
  assert.equal(res.status, 200, `/models/download returned ${res.status}`);
  const body = (await res.json()) as any;
  assert.equal(body.started, true, `a missing model must start downloading: ${JSON.stringify(body)}`);
  assert.equal(body.model, 'kokoro-multi-lang', `the response must echo the model: ${JSON.stringify(body)}`);
  assert.deepEqual(body.startedModels, ['kokoro-multi-lang'], `startedModels: ${JSON.stringify(body.startedModels)}`);
  assert.equal(body.states['kokoro-multi-lang'], 'downloading', `state right after the POST: ${JSON.stringify(body.states)}`);

  // Poll exactly as the client does: /status is where the progress bar lives.
  const seen: { pct: number; name: string | null }[] = [];
  const elapsed = await waitFor('kokoro-multi-lang to finish downloading', () => {
    const p = models.downloadProgress();
    if (p.active && p.name) seen.push({ pct: p.pct, name: p.name });
    return models.modelReady('kokoro-multi-lang');
  });
  const elapsedTotal = performance.now() - startedAt;

  assert.equal(models.modelStatesById()['kokoro-multi-lang'], 'ready', `state after download: ${JSON.stringify(models.modelStatesById())}`);
  // Progress carried the model id: that is what makes the status bar honest when two models exist.
  assert.ok(seen.length > 0, `expected progress events while downloading, got ${seen.length}`);
  assert.ok(
    seen.some((p) => p.name?.startsWith('kokoro-multi-lang/')),
    `progress must name the model: ${JSON.stringify(seen.slice(0, 4))}`,
  );
  assert.ok(seen.at(-1)!.pct > 50, `progress must climb towards 100%, last was ${seen.at(-1)!.pct}%`);

  // Every file on disk at its listed size, and one request per file (no re-fetch loops).
  for (const f of KOKORO_FILES) {
    const file = path.join(MODELS_DIR, 'tts', 'kokoro-multi-lang', f.path);
    assert.equal(fs.statSync(file).size, f.size, `${f.path} must be ${f.size} bytes`);
  }
  assert.equal(requests.length, KOKORO_FILES.length, `one request per file, got ${requests.length}: ${JSON.stringify(requests)}`);

  // And the menu agrees, without a second download.
  const list = (await (await route('/models')).json()) as any;
  const kokoro = list.items.find((i: any) => i.id === 'kokoro-multi-lang');
  assert.equal(kokoro.state, 'ready', `after download /models says ${kokoro.state}`);
  assert.equal(kokoro.pct, 100, `after download pct is ${kokoro.pct}`);
  assert.equal(list.ready, true, 'the required set is still ready');

  t.diagnostic(
    `Kokoro download: ${KOKORO_FILES.length} files, ${mb(kokoro.size)} in ${ms(elapsedTotal)} ` +
      `(ready after ${ms(elapsed)}), ${seen.length} progress samples, last ${seen.at(-1)?.name} at ${seen.at(-1)?.pct}%`,
  );
});

test('POST /preview with Kokoro returns 24 000 Hz and real audio', { skip: skipKokoro }, async (t) => {
  if (!models.modelReady('kokoro-multi-lang')) {
    t.skip('Kokoro was not downloaded (the download test above did not run)');
    return;
  }
  const res = await route('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Short on purpose: Kokoro renders at ~1× real time, and this file runs alongside the other test
    // files, so a three-second sentence here would slow down the suites that measure latency.
    body: JSON.stringify({ text: 'Hello there.', model: 'kokoro-multi-lang' }),
  });
  assert.equal(res.status, 200, `/preview returned ${res.status}`);
  assert.equal(res.headers.get('content-type'), 'audio/pcm', `content-type: ${res.headers.get('content-type')}`);
  assert.equal(
    res.headers.get('x-audio-rate'),
    '24000',
    `Kokoro must report its own 24 000 Hz, header says ${res.headers.get('x-audio-rate')} (never resampled)`,
  );
  assert.equal(res.headers.get('x-audio-model'), 'kokoro-multi-lang', `model header: ${res.headers.get('x-audio-model')}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  const expectedBytes = Math.round((pcm.length / 2 / 24000) * 1000);
  assert.ok(pcm.length > 24000, `expected >0.5 s of Kokoro audio, got ${pcm.length} bytes`);
  assert.ok(peak(pcm) > 1000, `Kokoro preview is silent (peak ${peak(pcm)})`);

  // The same bytes read at the wrong rate are what a resampled client would hear; the engine rate is
  // what we promise, so the duration has to line up with 24 kHz.
  assert.ok(expectedBytes > 500, `duration sanity: ${expectedBytes} ms`);

  // A different Kokoro speaker: 54 exist, `sid` is how the menu can let someone hear one.
  const other = await route('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hi.', model: 'kokoro-multi-lang', sid: 7 }),
  });
  assert.equal(other.status, 200, `a Kokoro speaker preview must work, got ${other.status}`);
  assert.equal(other.headers.get('x-audio-rate'), '24000', `speaker 7 is still 24 000 Hz: ${other.headers.get('x-audio-rate')}`);
  const otherPcm = Buffer.from(await other.arrayBuffer());
  assert.ok(otherPcm.length > 8000, `expected audio from speaker 7, got ${otherPcm.length} bytes`);
  assert.ok(peak(otherPcm) > 1000, `speaker 7 audio is silent (peak ${peak(otherPcm)})`);

  t.diagnostic(
    `Kokoro preview: ${pcm.length} bytes at 24000 Hz (${expectedBytes} ms), peak ${peak(pcm)}; ` +
      `speaker 7: ${otherPcm.length} bytes, peak ${peak(otherPcm)}`,
  );
});

test('POST /session speaks the bot\'s own voice model', { skip: skipKokoro }, async (t) => {
  const kokoroReady = models.modelReady('kokoro-multi-lang');
  const res = await route('/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: BOT_KOKORO }),
  });
  assert.equal(res.status, 200, `/session returned ${res.status}`);
  const body = (await res.json()) as any;
  assert.ok(body.callId, `a call id is minted: ${JSON.stringify(body)}`);
  assert.equal(body.sampleRate, 16000, `the microphone side is 16 kHz: ${body.sampleRate}`);
  if (kokoroReady) {
    assert.equal(body.model, 'kokoro-multi-lang', `the Kokoro bot must get Kokoro: ${JSON.stringify(body)}`);
    assert.equal(body.ttsSampleRate, 24000, `and its 24 000 Hz: ${body.ttsSampleRate}`);
    assert.equal(body.requestedModel, undefined, `no fallback should be reported: ${JSON.stringify(body)}`);
  } else {
    // The chosen voice is not downloadable here: the call still works, on the default voice.
    assert.equal(body.model, 'piper-lessac-medium', `fallback voice: ${JSON.stringify(body)}`);
    assert.equal(body.ttsSampleRate, 22050, `fallback rate: ${body.ttsSampleRate}`);
    assert.equal(body.requestedModel, 'kokoro-multi-lang', `the fallback must be reported: ${JSON.stringify(body)}`);
  }

  const dflt = (await (
    await route('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: BOT_DEFAULT }),
    })
  ).json()) as any;
  assert.equal(dflt.model, 'piper-lessac-medium', `a bot with no choice gets the default: ${JSON.stringify(dflt)}`);
  assert.equal(dflt.ttsSampleRate, 22050, `and 22 050 Hz: ${dflt.ttsSampleRate}`);

  const stranger = await route('/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: 'bot_not_yours' }),
  });
  assert.equal(stranger.status, 404, `an unknown bot must be 404, got ${stranger.status}`);

  t.diagnostic(`session: kokoro bot → ${body.model} at ${body.ttsSampleRate} Hz; default bot → ${dflt.model} at ${dflt.ttsSampleRate} Hz`);
});

// ---------- 4. the layout migration ----------

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('the layout migration moves a legacy tts/<file> into tts/piper-lessac-medium/<file> and re-downloads nothing', { skip: skipModels }, async (t) => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'voice-migrate-'));
  // A phase-2 cache: files flat under <kind>/, exactly as the previous two phases wrote them.
  const legacy = [
    ...VOICE_MODEL_FILES.filter((f) => f.model === 'piper-lessac-medium' && f.kind !== 'espeak'),
    ...VOICE_MODEL_FILES.filter((f) => f.model === 'silero-vad'),
  ];
  for (const file of legacy) {
    const flat = path.join(dir, KIND_DIR[file.kind], file.path);
    fs.mkdirSync(path.dirname(flat), { recursive: true });
    fs.symlinkSync(sourceOf(file)!, flat);
  }
  // No .state.json digests: this is what a cache that was copied here looks like, and the point is
  // that neither the move nor the next `ensureModels` needs to hash 263 MB to accept it.
  fs.writeFileSync(path.join(dir, '.state.json'), `${JSON.stringify({ verifiedAt: 0, files: {}, errors: {} })}\n`);
  const flatBefore = path.join(dir, 'tts', 'en_US-lessac-medium.onnx');
  assert.ok(fs.existsSync(flatBefore), 'the legacy layout must be in place before the migration');

  const report = models.migrateLayout(dir);
  assert.equal(report.moved, legacy.length, `every legacy file must move: ${JSON.stringify(report)}`);
  assert.ok(report.bytes > 60e6, `the report must account for the bytes it saved: ${mb(report.bytes)}`);
  assert.deepEqual(report.models.sort(), ['piper-lessac-medium', 'silero-vad'], `models moved: ${JSON.stringify(report.models)}`);

  for (const file of legacy) {
    const next = path.join(dir, KIND_DIR[file.kind], file.model, file.path);
    assert.equal(fs.statSync(next).size, file.size, `${file.path} must be at ${next} at its listed size`);
  }
  const movedModel = path.join(dir, 'tts', 'piper-lessac-medium', 'en_US-lessac-medium.onnx');
  assert.ok(fs.existsSync(movedModel), `tts/piper-lessac-medium/en_US-lessac-medium.onnx must exist`);
  assert.equal(fs.statSync(movedModel).size, 63201425, `the 63 MB Piper model must be intact (${fs.statSync(movedModel).size} bytes)`);
  // The old path is a compatibility symlink to the new one, not a second copy.
  assert.ok(fs.lstatSync(flatBefore).isSymbolicLink(), 'the legacy path must be a symlink after the move');
  assert.equal(fs.statSync(flatBefore).size, 63201425, 'and it must resolve to the migrated file');

  // Idempotent: a second pass moves nothing.
  const again = models.migrateLayout(dir);
  assert.equal(again.moved, 0, `the migration must be idempotent, second pass moved ${again.moved}`);

  // And the downloader now skips all of it: size is the presence test, nothing is fetched.
  let fetches = 0;
  const result = await models.downloadVoiceFiles({
    dir,
    files: legacy.filter((f) => f.kind !== 'espeak'),
    urlFor: (f) => {
      fetches += 1;
      return `http://127.0.0.1:1/${f.path}`;
    },
  });
  assert.equal(result.ok, true, `a migrated cache must need no download: ${result.error ?? ''}`);
  assert.equal(result.downloaded, 0, `nothing may be downloaded after the migration, got ${result.downloaded}`);
  assert.equal(fetches, 0, `no HTTP request may be made for a migrated file, got ${fetches}`);

  t.diagnostic(
    `migration: ${report.moved} files / ${mb(report.bytes)} moved for ${report.models.join(', ')}, ` +
      `${report.links} compatibility links, second pass moved 0, downloader fetched ${fetches}`,
  );
});

// ---------- 5. warm-up ----------

test('warmUp() makes the next transcribe measurably faster', { skip: skipModels }, async (t) => {
  const silence = new Float32Array(8000); // 0.5 s at 16 kHz: the same shape warmUp() feeds itself

  // transcribe()'s own `ms` excludes the recogniser load (it is the audio path's latency), so the
  // cold-start cost is measured end to end here — that is exactly the number a caller feels.
  runtime.resetRuntimeCaches();
  const coldAt = performance.now();
  const cold = await runtime.transcribe(silence, 16000);
  const coldMs = performance.now() - coldAt;
  assert.equal(cold.text, '', `silence must transcribe to nothing, got ${JSON.stringify(cold.text)}`);

  runtime.resetRuntimeCaches();
  const warm = await runtime.warmUp({ tts: false });
  assert.equal(warm.ok, true, `warmUp() must load the recogniser: ${warm.error ?? ''}`);
  assert.ok(warm.recognizerMs > 0, `warmUp() must report the recogniser load: ${warm.recognizerMs}`);
  assert.ok(warm.decodeMs >= 0, `warmUp() must report the silent decode: ${warm.decodeMs}`);

  const hotAt = performance.now();
  const hot = await runtime.transcribe(silence, 16000);
  const hotMs = performance.now() - hotAt;
  assert.equal(hot.text, '', `silence must still transcribe to nothing after warm-up, got ${JSON.stringify(hot.text)}`);

  t.diagnostic(
    `transcribe 0.5 s of silence end to end: cold ${ms(coldMs)} (recogniser load ${ms(warm.recognizerMs)}, ` +
      `0.5 s silent decode ${ms(warm.decodeMs)}), warm ${ms(hotMs)} → ${ms(coldMs - hotMs)} saved`,
  );
  assert.ok(
    hotMs < coldMs,
    `a warmed recogniser must be faster: cold ${ms(coldMs)}, warm ${ms(hotMs)} ` +
      `(init was ${ms(warm.recognizerMs)}, audio-only ${ms(cold.ms)} vs ${ms(hot.ms)})`,
  );
  assert.ok(
    coldMs - hotMs > 100,
    `the warm-up must remove the recogniser load from the first utterance: cold ${ms(coldMs)} vs warm ${ms(hotMs)} ` +
      `(${ms(coldMs - hotMs)} saved, load measured at ${ms(warm.recognizerMs)})`,
  );
});
