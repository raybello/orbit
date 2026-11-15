/**
 * On-device voice over HTTP: status, batch transcription, the model menu, voice preview and calls.
 *
 * Mounted by voice.ts as `voiceApi.route('/local', localVoiceApi)`, so the public paths are
 * `/api/voice/local/*` (see docs/voice-local-conventions.md for the contract table).
 *
 * Never falls back to the cloud here: if this stack cannot run, the client gets
 * `{ available: false, reason: 'unsupported-runtime' }` and keeps using xAI. Loading a model is the
 * expensive step (197 MB of ONNX for the recogniser, 360 MB for Kokoro), so the runtime is only
 * touched once the models are on disk.
 *
 * ## The two TTS tiers, and why there is no "select" endpoint
 *
 * `GET /models` and the `voices` array in `/status` are the whole menu: Piper (required, 22 050 Hz)
 * and Kokoro (optional, 24 000 Hz, 54 speakers), each with its own size, state and rate. The choice
 * of voice belongs to a bot — `Bot.voiceModel` (`bots.voice_model`) — so a global "active model"
 * endpoint would be a second source of truth that immediately disagrees with the bots once two of
 * them pick different voices: `POST /session` has to read the bot's row anyway to know whose call it
 * is, and that row is the only place a voice can be chosen per bot. `/preview` takes an explicit
 * `model` for the same reason: it previews a model the user is about to pick, not "the" model.
 */
import { Hono, type Context } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { newId } from './lib/ids.js';
import { getBotRow } from './store.js';
import * as models from './voice-models.js';
import * as runtime from './voice-runtime.js';
import { CALL_SAMPLE_RATE, createLocalCall } from './voice-local-session.js';
import { optionalBody, VoiceModelDownloadSchema, LocalVoiceSessionSchema } from './api/schemas.js';

export const localVoiceApi = new Hono<AuthVars>();

/**
 * Load the recogniser (and default voice) after boot or after a download, so the first utterance is
 * not the cold-start case: measured 778-1 215 ms cold versus 62-99 ms warm on this machine, and
 * ~5 s for the first batch transcription inside the Docker image.
 *
 * Safe to call any time: it does nothing unless the addon is loadable and the required models are on
 * disk, and a failure is logged rather than thrown (voice is optional on any given host).
 */
export async function warmVoiceIfReady(): Promise<boolean> {
  try {
    if (!runtime.runtimeInfo().addon || !models.modelsReady()) return false;
    const result = await runtime.warmUp();
    console.log(`[voice] warmed up: recognizer ${result.recognizerMs} ms, voice ${result.ttsMs} ms`);
    return true;
  } catch (e) {
    console.warn('[voice] warm-up skipped:', (e as Error)?.message ?? e);
    return false;
  }
}

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
function botForbidden(_c: Context<AuthVars>, userId: string, botId: string | undefined): boolean {
  return !!botId && !ownBot(userId, botId);
}

function audioRate(header: string | undefined): number {
  const n = Number(header);
  if (!Number.isFinite(n) || n < 8000 || n > 48000) return DEFAULT_IN_RATE;
  return Math.round(n);
}

const unavailable = (c: Context<AuthVars>) => c.json({ available: false, reason: 'unsupported-runtime' }, 503);
const missingModels = (c: Context<AuthVars>) => c.json({ available: false, reason: 'models-missing' }, 503);

export interface VoiceMenuItem {
  id: string;
  kind: models.VoiceKind;
  name: string;
  /** The engine's rate: input for stt/vad, output for tts (22 050 Piper, 24 000 Kokoro). */
  rate: number;
  size: number;
  state: string;
  pct: number;
  tier: models.VoiceTier;
}

/**
 * The menu rows, shared by `GET /models` and the `voices` array in `/status` so the UI needs one
 * call to render "Speech recognition · Ready" and the two voices with their sizes and rates.
 */
function menu(): VoiceMenuItem[] {
  return models.modelItems().map((m) => ({
    id: m.id,
    kind: m.kind,
    name: m.name,
    rate: m.rate,
    size: m.size,
    state: m.state,
    pct: m.size ? Math.min(100, Math.round((m.have / m.size) * 100)) : 100,
    tier: m.tier,
  }));
}

/** `/status` starts the download on first call so a fresh install is usable without a button,
 * unless VOICE_AUTO_DOWNLOAD=0 (CI, or a user who wants to choose). Only the required set is
 * fetched: the optional voice is a deliberate, user-initiated 360 MB download. */
let autoDownloadStarted = false;

localVoiceApi.get('/status', (c) => {
  const info = runtime.runtimeInfo();
  const bytes = models.modelBytes();
  const voices = menu();

  if (!info.addon) {
    return c.json({
      available: false,
      reason: 'unsupported-runtime',
      runtime: info,
      models: models.modelStates(),
      bytes,
      download: models.downloadProgress(),
      voices,
    });
  }

  // `available` is the addon plus the *required* models; the optional voice never gates it.
  const ready = models.modelsReady();
  if (!ready && process.env.VOICE_AUTO_DOWNLOAD !== '0' && !autoDownloadStarted) {
    autoDownloadStarted = true;
    void models.ensureModels();
  }

  return c.json({
    available: ready,
    ...(ready ? {} : { reason: 'models-missing' }),
    runtime: info,
    models: models.modelStates(),
    bytes: models.modelBytes(),
    download: models.downloadProgress(),
    voices,
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
  } catch (e) {
    console.warn('[voice] local stt failed:', (e as Error)?.message);
    return c.json({ error: 'transcription failed' }, 502);
  }
});

localVoiceApi.post('/preview', async (c) => {
  const user = c.get('user');
  const p = await c.req
    .json<{ text?: string; speed?: number; model?: string; sid?: number; botId?: string }>()
    .catch(() => ({} as { text?: string; speed?: number; model?: string; sid?: number; botId?: string }));
  if (botForbidden(c, user.id, p.botId)) return c.json({ error: 'not found' }, 404);

  const info = runtime.runtimeInfo();
  if (!info.addon) return unavailable(c);

  // An unknown model, a model that is not a voice, and a voice that was never downloaded are all
  // client-side conditions (the menu says which models exist and which are ready) → 409, not 500.
  const modelId = String(p.model ?? models.DEFAULT_TTS_MODEL);
  const spec = models.modelSpec(modelId);
  if (!spec) {
    return c.json({ error: 'unknown model', model: modelId, models: models.TTS_MODELS.map((m) => m.id) }, 409);
  }
  if (spec.kind !== 'tts') {
    return c.json({ error: 'not a speech model', model: modelId, models: models.TTS_MODELS.map((m) => m.id) }, 409);
  }
  if (!models.modelReady(spec.id)) {
    return c.json({ error: 'model not downloaded', model: spec.id, tier: spec.tier }, 409);
  }

  const text = String(p.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text) return c.json({ error: 'text required' }, 400);

  try {
    // `sid` is Kokoro's speaker (0–53); the single-speaker Piper model ignores it. It is the only way
    // to hear a specific voice without changing the bot's stored choice.
    const out = await runtime.synthesize(text, { speed: p.speed, model: spec.id, sid: p.sid });
    // The voice's own rate — 22 050 Hz for Piper lessac-medium, 24 000 Hz for Kokoro. We never
    // resample on the server, so the client has to honour this header.
    return c.body(runtime.floatToPcm16(out.samples), 200, {
      'Content-Type': 'audio/pcm',
      'X-Audio-Rate': String(out.sampleRate),
      'X-Audio-Model': out.model,
      'Cache-Control': 'no-store',
    });
  } catch (e) {
    console.warn('[voice] local tts failed:', (e as Error)?.message);
    return c.json({ error: 'preview unavailable' }, 502);
  }
});

localVoiceApi.get('/models', (c) => c.json({ items: menu(), ready: models.modelsReady() }));

/**
 * Download one model (`{ model }`), a kind's required model (`{ kind }`), or the whole required set
 * (no body). Idempotent and backgrounded: `started:false` means it was already complete.
 *
 * `state` is the kind-level shape the phase-1/2 client polls; `states` is per model, which is the
 * only place an optional voice's state (or its error) can be read.
 */
localVoiceApi.post('/models/download', async (c) => {
  const p = await optionalBody(c, VoiceModelDownloadSchema, {});

  let target: models.VoiceKind | string | undefined;
  if (p.model !== undefined) {
    if (!models.isVoiceModelId(p.model)) {
      return c.json({ error: 'unknown model', model: p.model, models: models.VOICE_MODELS.map((m) => m.id) }, 400);
    }
    target = p.model;
  } else if (p.kind !== undefined) {
    if (!models.VOICE_KINDS.includes(p.kind as models.VoiceKind)) {
      return c.json({ error: 'kind must be stt, tts or vad' }, 400);
    }
    target = p.kind as models.VoiceKind;
  }

  const wanted = models.modelsForTarget(target);
  const before = models.modelStatesById();
  const started = wanted.some((m) => before[m.id] !== 'ready');
  if (started) {
    // Fire and forget: state is polled from /status. Once it lands, load the engines so the first
    // real call does not pay the 0.8-9 s model-load cost (see warmUp).
    void models.ensureModels(target).then(() => warmVoiceIfReady()).catch(() => {});
  }
  return c.json({
    started,
    model: p.model ?? null,
    startedModels: started ? wanted.map((m) => m.id) : [],
    state: models.modelStates(),
    states: models.modelStatesById(),
  });
});

/**
 * Mint a call id for a local voice call. The browser then opens
 * `ws(s)://<host>/api/voice/local/call/<callId>` (see attachLocalCallRelay) and the session is
 * claimed by that upgrade, so an id that is never used is swept after five minutes.
 *
 * The voice is the bot's own choice (`Bot.voiceModel`, the menu's ids): `model` in the response is
 * the one the session will speak with and `ttsSampleRate` is that engine's rate, so a Kokoro bot
 * gets 24 000 Hz and a Piper bot 22 050 Hz — never resampled. A bot whose chosen voice is not
 * downloaded falls back to the default instead of failing the call, and says so (`requestedModel`)
 * so the UI can offer the download rather than silently sounding like someone else.
 */
localVoiceApi.post('/session', async (c) => {
  const user = c.get('user');
  const p = await optionalBody(c, LocalVoiceSessionSchema, {});
  const bot = ownBot(user.id, p.botId);
  if (!bot) return c.json({ error: 'not found' }, 404);

  const info = runtime.runtimeInfo();
  if (!info.addon) return unavailable(c);
  if (!models.modelsReady()) return missingModels(c);

  const requested = String(bot.voice_model ?? models.DEFAULT_TTS_MODEL);
  const spec = models.ttsModel(requested);
  const model = spec && models.modelReady(spec.id) ? spec.id : models.DEFAULT_TTS_MODEL;

  const callId = newId('call');
  createLocalCall(callId, bot.id, { model });
  return c.json({
    callId,
    sampleRate: CALL_SAMPLE_RATE,
    ttsSampleRate: runtime.ttsSampleRate(model),
    model,
    ...(model === requested ? {} : { requestedModel: requested }),
  });
});
