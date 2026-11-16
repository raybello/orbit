/**
 * On-device voice by default, and the model manager's write paths: delete, cancel and redownload.
 *
 * Downloads are real: the files come from the machine's model cache over a loopback http.Server and
 * are checked against the manifest's sizes and sha256s. The model root is this file's own, built from
 * symlinks into the cache, so deleting a model here never touches the cache itself.
 *
 * Run with the cache:  VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models pnpm --filter @orbit/server test
 */
import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { cleanupTmpEnv, tmpRoot } from './helpers/tmp-env.js';
import type { VoiceModelFile } from '../voice-model-files.js';

const SOURCE_CACHE = process.env.VOICE_MODELS_DIR ?? path.join(os.homedir(), '.hermes', 'cache', 'voice-models');
const MODELS_DIR = fs.mkdtempSync(path.join(tmpRoot, 'voice-models-manage-'));
process.env.VOICE_MODELS_DIR = MODELS_DIR;
process.env.VOICE_AUTO_DOWNLOAD = '0';

const models = await import('../voice-models.js');
const { localVoiceApi } = await import('../voice-local.js');
const { db } = await import('../db.js');
const { getBot } = await import('../store.js');
const { migrateUnsetVoiceProviders } = await import('../infra/voice-provider-migration.js');
const { PatchBotSchema } = await import('../api/schemas.js');
const { VOICE_MODEL_FILES } = await import('../voice-model-files.js');

after(() => cleanupTmpEnv());

const KIND_DIR: Record<VoiceModelFile['kind'], string> = { stt: 'stt', tts: 'tts', espeak: 'tts', vad: 'vad' };
const destOf = (root: string, f: VoiceModelFile) => path.join(root, KIND_DIR[f.kind], f.model, f.path);

function sourceOf(f: VoiceModelFile): string | null {
  for (const p of [destOf(SOURCE_CACHE, f), path.join(SOURCE_CACHE, KIND_DIR[f.kind], f.path)]) {
    try {
      if (fs.statSync(p).size === f.size) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** Symlink a model's files into this file's root; false when the cache lacks any of them. */
function link(files: VoiceModelFile[]): boolean {
  if (files.some((f) => !sourceOf(f))) return false;
  for (const f of files) {
    const dest = destOf(MODELS_DIR, f);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(sourceOf(f)!, dest);
  }
  return true;
}

const own = (id: string) => VOICE_MODEL_FILES.filter((f) => f.model === id);
const ESPEAK = VOICE_MODEL_FILES.filter((f) => f.kind === 'espeak');
const VAD = own('silero-vad');
const haveRequired = link(own('zipformer-bilingual-int8')) && link(VAD);
const havePiper = haveRequired && link(own('piper-lessac-medium'));
const haveKokoro = havePiper && link(own('kokoro-multi-lang'));
const skipModels = havePiper ? false : `voice model cache not present at ${SOURCE_CACHE}`;
const skipKokoro = haveKokoro ? false : `Kokoro weights not present in ${SOURCE_CACHE}`;

// ---------- auth fixture ----------

const TOKEN = 'voice-manage-token';
const USER = 'usr_voice_manage';
const BOT = 'bot_voice_manage';
const nowMs = Date.now();
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'voice-manage@test.local', 'Voice Manage', nowMs);
db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(TOKEN, USER, nowMs, nowMs + 3600_000);
db.prepare('INSERT OR REPLACE INTO bots(id,user_id,name,created_at,updated_at,voice_provider,voice_model) VALUES (?,?,?,?,?,?,?)').run(
  BOT, USER, 'Manage Bot', nowMs, nowMs, 'local', 'piper-lessac-medium',
);

function route(pathname: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(localVoiceApi.request(pathname, {
    ...init,
    headers: { cookie: `grokbot_session=${TOKEN}`, 'Content-Type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) },
  }));
}

type Item = { id: string; kind: string; state: string; onDisk: number; size: number; pct: number; tier: string };
async function items(): Promise<Map<string, Item>> {
  models.resetVoiceModelCaches();
  const list = (await (await route('/models')).json()) as { items: Item[] };
  return new Map(list.items.map((i) => [i.id, i]));
}

const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));
async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Serves manifest files by name from the cache. `slow` drips 8 KB every 40 ms, long enough to cancel
 * a download while it is in flight.
 */
async function fileServer(opts: { slow?: boolean } = {}) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').slice(1));
    requests.push(name);
    const file = VOICE_MODEL_FILES.find((f) => f.name === name);
    const src = file && sourceOf(file);
    if (!file || !src) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Length', String(file.size));
    if (!opts.slow) {
      fs.createReadStream(src).pipe(res);
      return;
    }
    const bytes = fs.readFileSync(src);
    let at = 0;
    const timer = setInterval(() => {
      if (at >= bytes.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(bytes.subarray(at, at + 8192));
      at += 8192;
    }, 40);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  models.__setDownloadUrlForTests((f: VoiceModelFile) => `http://127.0.0.1:${port}/${encodeURIComponent(f.name)}`);
  return {
    requests,
    close: () => {
      models.__setDownloadUrlForTests(null);
      server.closeAllConnections();
      server.close();
    },
  };
}

// ---------- default provider ----------

test('unset voice providers migrate to on-device, and an explicit cloud choice survives', () => {
  const insert = db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,voice_provider) VALUES (?,?,?,?,?,?)');
  insert.run('bot_vp_blank', USER, 'Blank', nowMs, nowMs, '');
  insert.run('bot_vp_junk', USER, 'Junk', nowMs, nowMs, 'Cloud ');
  insert.run('bot_vp_cloud', USER, 'Cloud', nowMs, nowMs, 'cloud');
  insert.run('bot_vp_local', USER, 'Local', nowMs, nowMs, 'local');

  assert.equal(getBot('bot_vp_blank')?.voiceProvider, 'local', 'an unset provider already reads as on-device');
  assert.equal(migrateUnsetVoiceProviders(db), 2, 'only the two unset rows change');

  const stored = (id: string) => (db.prepare('SELECT voice_provider FROM bots WHERE id=?').get(id) as { voice_provider: string }).voice_provider;
  assert.equal(stored('bot_vp_blank'), 'local');
  assert.equal(stored('bot_vp_junk'), 'local');
  assert.equal(stored('bot_vp_cloud'), 'cloud', 'an explicit cloud choice is never overridden');
  assert.equal(getBot('bot_vp_cloud')?.voiceProvider, 'cloud');
  assert.equal(getBot('bot_vp_local')?.voiceProvider, 'local');
  assert.equal(migrateUnsetVoiceProviders(db), 0, 'a second run changes nothing');
});

test('a PATCH can only store one of the two providers', () => {
  assert.equal(PatchBotSchema.safeParse({ voiceProvider: 'cloud' }).success, true);
  assert.equal(PatchBotSchema.safeParse({ voiceProvider: 'local' }).success, true);
  assert.equal(PatchBotSchema.safeParse({ voiceProvider: 'banana' }).success, false);
  assert.equal(PatchBotSchema.safeParse({ voiceProvider: '' }).success, false);
});

// ---------- delete ----------

test('DELETE /models/:id removes the files from disk and the model reads missing', { skip: skipModels }, async () => {
  const before = (await items()).get('silero-vad')!;
  assert.equal(before.state, 'ready');
  assert.equal(before.onDisk, before.size, 'a ready model holds its full size on disk');

  const res = await route('/models/silero-vad', { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { removed: number; bytes: number };
  assert.equal(body.removed, VAD.length);
  assert.equal(body.bytes, before.size);
  for (const f of VAD) assert.equal(fs.existsSync(destOf(MODELS_DIR, f)), false, `${f.path} is gone from disk`);
  assert.equal(fs.existsSync(path.join(MODELS_DIR, 'vad', 'silero-vad')), false, 'the empty model directory is pruned');
  for (const f of VAD) assert.ok(sourceOf(f), 'the cache the root linked to is untouched');

  const after = (await items()).get('silero-vad')!;
  assert.equal(after.state, 'missing');
  assert.equal(after.onDisk, 0);

  const status = (await (await route('/status')).json()) as { available: boolean; reason?: string };
  assert.equal(status.available, false, 'a call cannot run without voice activity detection');
  assert.equal(status.reason, 'models-missing');

  const again = (await (await route('/models/silero-vad', { method: 'DELETE' })).json()) as { removed: number };
  assert.equal(again.removed, 0, 'deleting a missing model is a no-op');
});

test('DELETE /models/:id refuses an id that is not a model', async () => {
  assert.equal((await route('/models/not-a-model', { method: 'DELETE' })).status, 400);
});

// ---------- cancel ----------

test('POST /models/cancel stops a running download; delete then reclaims the partial bytes', { skip: skipModels }, async (t) => {
  const server = await fileServer({ slow: true });
  t.after(() => server.close());

  const start = (await (await route('/models/download', { method: 'POST', body: JSON.stringify({ model: 'silero-vad' }) })).json()) as { started: boolean };
  assert.equal(start.started, true);
  await waitFor('the first bytes of the download', () => (models.modelItems().find((m) => m.id === 'silero-vad')?.pct ?? 0) > 0);

  const res = await route('/models/cancel', { method: 'POST', body: JSON.stringify({ model: 'silero-vad' }) });
  const body = (await res.json()) as { cancelled: boolean; items: Item[] };
  assert.equal(body.cancelled, true);
  const vad = body.items.find((i) => i.id === 'silero-vad')!;
  assert.equal(vad.state, 'missing', 'a cancelled download is not an error');
  assert.ok(vad.onDisk > 0 && vad.onDisk < vad.size, `the partial download stays on disk to resume: ${vad.onDisk} of ${vad.size}`);
  assert.equal(models.downloading().includes('silero-vad'), false);

  const again = (await (await route('/models/cancel', { method: 'POST', body: JSON.stringify({ model: 'silero-vad' }) })).json()) as { cancelled: boolean };
  assert.equal(again.cancelled, false, 'nothing left to cancel');

  await route('/models/silero-vad', { method: 'DELETE' });
  assert.equal((await items()).get('silero-vad')!.onDisk, 0, 'delete removes the .part file too');
});

// ---------- download and redownload ----------

test('a deleted model downloads again and verifies against the manifest', { skip: skipModels }, async (t) => {
  const server = await fileServer();
  t.after(() => server.close());

  await route('/models/download', { method: 'POST', body: JSON.stringify({ model: 'silero-vad' }) });
  await waitFor('silero-vad to be ready', async () => (await items()).get('silero-vad')!.state === 'ready');
  assert.deepEqual(server.requests, VAD.map((f) => f.name), 'one request per file');
  for (const f of VAD) assert.equal(fs.lstatSync(destOf(MODELS_DIR, f)).isSymbolicLink(), false, 'a real file, written by the downloader');

  const status = (await (await route('/status')).json()) as { available: boolean };
  assert.equal(status.available, true);
});

test('POST /models/download { fresh: true } deletes and fetches a ready model again', { skip: skipModels }, async (t) => {
  const server = await fileServer();
  t.after(() => server.close());
  const file = destOf(MODELS_DIR, VAD[0]);
  const firstWrite = fs.statSync(file).ino;

  const res = await route('/models/download', { method: 'POST', body: JSON.stringify({ model: 'silero-vad', fresh: true }) });
  const body = (await res.json()) as { started: boolean };
  assert.equal(body.started, true, 'a redownload starts even though the model was ready');
  await waitFor('silero-vad to be ready again', async () => (await items()).get('silero-vad')!.state === 'ready');
  assert.deepEqual(server.requests, VAD.map((f) => f.name), 'every file was fetched again');
  assert.notEqual(fs.statSync(file).ino, firstWrite, 'the file on disk is a new one');
});

// ---------- voices are the person's choice ----------

test('deleting one voice keeps the espeak-ng data another installed voice needs', { skip: skipKokoro }, async () => {
  assert.equal((await items()).get('kokoro-multi-lang')!.state, 'ready');
  await route('/models/piper-lessac-medium', { method: 'DELETE' });

  const after = await items();
  assert.equal(after.get('piper-lessac-medium')!.state, 'missing');
  assert.equal(after.get('kokoro-multi-lang')!.state, 'ready', 'Kokoro still has everything it loads');
  for (const f of ESPEAK) assert.ok(fs.existsSync(destOf(MODELS_DIR, f)), `${f.path} is kept for Kokoro`);

  const session = (await (await route('/session', { method: 'POST', body: JSON.stringify({ botId: BOT }) })).json()) as { model: string; requestedModel?: string };
  assert.equal(session.model, 'kokoro-multi-lang', 'a bot whose voice was deleted speaks with the installed one');
  assert.equal(session.requestedModel, 'piper-lessac-medium');

  await route('/models/kokoro-multi-lang', { method: 'DELETE' });
  for (const f of ESPEAK) assert.equal(fs.existsSync(destOf(MODELS_DIR, f)), false, 'with no voice left, espeak-ng goes too');
});

test('with no voice installed, a call needs a model and none is fetched implicitly', { skip: skipModels }, async () => {
  for (const id of ['piper-lessac-medium', 'kokoro-multi-lang']) await route(`/models/${id}`, { method: 'DELETE' });
  const status = (await (await route('/status')).json()) as { available: boolean; models: { stt: string; vad: string; tts: string }; voices: Item[] };
  assert.equal(status.available, false);
  assert.deepEqual(status.models, { stt: 'ready', vad: 'ready', tts: 'missing' });
  assert.deepEqual(models.modelsForTarget().map((m) => m.kind).sort(), ['stt', 'vad'], 'the automatic set is recognition and VAD only');

  const session = await route('/session', { method: 'POST', body: JSON.stringify({ botId: BOT }) });
  assert.equal(session.status, 503);
  assert.equal(((await session.json()) as { reason: string }).reason, 'models-missing');
});
