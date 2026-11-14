/**
 * On-device voice over HTTP: status, batch transcription, voice preview and model management.
 *
 * Mounted by voice.ts as `voiceApi.route('/local', localVoiceApi)`, so the public paths are
 * `/api/voice/local/*` (see docs/voice-local-conventions.md for the contract table).
 *
 * Never falls back to the cloud here: if this stack cannot run, the client gets
 * `{ available: false, reason: 'unsupported-runtime' }` and keeps using xAI. Loading a model is the
 * expensive step (197 MB of ONNX), so the runtime is only touched once the models are on disk.
 */
import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';
import * as models from './voice-models.js';
import * as runtime from './voice-runtime.js';

export const localVoiceApi = new Hono<AuthVars>();

// Same gate as the rest of /api: a session, and an owned bot whenever a botId is given.
localVoiceApi.use('*', requireUser);

/** Longest clip /stt accepts: 8 MB of PCM16 at 16 kHz is about four minutes. */
const MAX_PCM_BYTES = 8 * 1024 * 1024;
const MIN_PCM_BYTES = 320; // 10 ms at 16 kHz — anything shorter is a click, not speech
const DEFAULT_IN_RATE = 16000;
const MAX_TEXT = 400;

function ownBot(userId: string, botId: string | undefined) {
  if (!botId) return null;
  const b = getBotRow(botId);
  return b && b.user_id === userId ? b : null;
}

/** Reject a botId that names someone else's bot; absent is fine (dictation needs no bot). */
function botForbidden(c: any, userId: string, botId: string | undefined): boolean {
  return !!botId && !ownBot(userId, botId);
}

function audioRate(header: string | undefined): number {
  const n = Number(header);
  if (!Number.isFinite(n) || n < 8000 || n > 48000) return DEFAULT_IN_RATE;
  return Math.round(n);
}

const unavailable = (c: any) => c.json({ available: false, reason: 'unsupported-runtime' }, 503);
const missingModels = (c: any) => c.json({ available: false, reason: 'models-missing' }, 503);

/** `/status` starts the download on first call so a fresh install is usable without a button,
 * unless VOICE_AUTO_DOWNLOAD=0 (CI, or a user who wants to choose). */
let autoDownloadStarted = false;

localVoiceApi.get('/status', (c) => {
  const info = runtime.runtimeInfo();
  const bytes = models.modelBytes();
  const first = models.modelStates();
  const allReady = models.VOICE_KINDS.every((k) => first[k] === 'ready');

  if (!info.addon) {
    return c.json({
      available: false,
      reason: 'unsupported-runtime',
      runtime: info,
      models: first,
      bytes,
      download: models.downloadProgress(),
    });
  }

  if (!allReady && process.env.VOICE_AUTO_DOWNLOAD !== '0' && !autoDownloadStarted) {
    autoDownloadStarted = true;
    void models.ensureModels();
  }

  const states = models.modelStates();
  const ready = models.VOICE_KINDS.every((k) => states[k] === 'ready');
  return c.json({
    available: ready,
    ...(ready ? {} : { reason: 'models-missing' }),
    runtime: info,
    models: states,
    bytes: models.modelBytes(),
    download: models.downloadProgress(),
  });
});

localVoiceApi.post('/stt', async (c) => {
  const user = c.get('user');
  const botId = c.req.query('botId');
  if (botForbidden(c, user.id, botId)) return c.json({ error: 'not found' }, 404);

  const info = runtime.runtimeInfo();
  if (!info.addon) return unavailable(c);
  if (!models.kindReady('stt')) return missingModels(c);

  const rate = audioRate(c.req.header('x-audio-rate'));
  const body = await c.req.arrayBuffer().catch(() => new ArrayBuffer(0));
  if (body.byteLength > MAX_PCM_BYTES) return c.json({ error: 'recording too long' }, 413);
  if (body.byteLength < MIN_PCM_BYTES) return c.json({ text: '', audioMs: 0, ms: 0 });

  const samples = runtime.pcm16ToFloat(body);
  try {
    // Padded 0.3 s + 1.0 s inside transcribe(): without it the first and last words are lost.
    const r = await runtime.transcribe(samples, rate);
    return c.json({ text: r.text, audioMs: r.audioMs, ms: Math.round(r.ms) });
  } catch (e: any) {
    console.warn('[voice] local stt failed:', e?.message);
    return c.json({ error: 'transcription failed' }, 502);
  }
});

localVoiceApi.post('/preview', async (c) => {
  const user = c.get('user');
  const p = await c.req
    .json<{ text?: string; speed?: number; botId?: string }>()
    .catch(() => ({} as { text?: string; speed?: number; botId?: string }));
  if (botForbidden(c, user.id, p.botId)) return c.json({ error: 'not found' }, 404);

  const info = runtime.runtimeInfo();
  if (!info.addon) return unavailable(c);
  if (!models.kindReady('tts')) return missingModels(c);

  const text = String(p.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text) return c.json({ error: 'text required' }, 400);

  try {
    const out = await runtime.synthesize(text, { speed: p.speed });
    // The voice's own rate (22 050 Hz for Piper lessac-medium); we never resample on the server.
    return c.body(runtime.floatToPcm16(out.samples), 200, {
      'Content-Type': 'audio/pcm',
      'X-Audio-Rate': String(out.sampleRate),
      'Cache-Control': 'no-store',
    });
  } catch (e: any) {
    console.warn('[voice] local tts failed:', e?.message);
    return c.json({ error: 'preview unavailable' }, 502);
  }
});

localVoiceApi.get('/models', (c) => {
  const items = models.modelGroups().map((g) => ({
    kind: g.kind,
    name: g.name,
    size: g.size,
    state: g.state,
    pct: g.size ? Math.min(100, Math.round((g.have / g.size) * 100)) : 100,
  }));
  return c.json({ items, ready: models.modelsReady() });
});

localVoiceApi.post('/models/download', async (c) => {
  const p = await c.req.json<{ kind?: string }>().catch(() => ({} as { kind?: string }));
  if (p.kind !== undefined && !models.VOICE_KINDS.includes(p.kind as models.VoiceKind)) {
    return c.json({ error: 'kind must be stt, tts or vad' }, 400);
  }
  const kind = p.kind as models.VoiceKind | undefined;
  const before = models.modelStates();
  const started = kind ? before[kind] !== 'ready' : models.VOICE_KINDS.some((k) => before[k] !== 'ready');
  if (started) void models.ensureModels(kind); // fire and forget: state is polled from /status
  return c.json({ started, state: models.modelStates() });
});
