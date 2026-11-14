/**
 * The on-device speech stack: sherpa-onnx-node engines, loaded lazily, once per model.
 *
 * Everything here is CPU. That is not a fallback, it is the measured best case:
 * `provider: 'coreml'` segfaults this process on the Piper VITS model (exit 139) and makes
 * streaming STT three times slower (18.9× vs 56.5× real-time on CPU), and the npm package's Linux
 * binaries contain no CUDA execution provider at all. See docs/voice-local-conventions.md.
 *
 * There are two TTS tiers and they are different engines, not two checkpoints of one: Piper is VITS
 * with the espeak-ng frontend (22 050 Hz, 10–17× real-time) and Kokoro is a Kokoro model with 54
 * speakers (24 000 Hz, ~1× real-time). `getTts(modelId)` therefore caches one instance *per model*
 * and `synthesize()` returns whatever rate the loaded engine reports — the server never resamples.
 *
 * The native addon is required inside a try/catch: a missing or ABI-incompatible binary must show
 * up as `addon: false` in `/local/status`, not as a crash on import (the Docker image is musl, and
 * a fresh checkout may have no prebuilt binary for its platform).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { DEFAULT_TTS_MODEL, destFor, filesForModel, modelsRoot, ttsModel, type VoiceModelSpec } from './voice-models.js';

type SherpaModule = typeof import('sherpa-onnx-node');
type OnlineRecognizer = import('sherpa-onnx-node').OnlineRecognizer;
type OfflineTts = import('sherpa-onnx-node').OfflineTts;
type Vad = import('sherpa-onnx-node').Vad;

export interface VoiceRuntimeInfo {
  platform: string;
  arch: string;
  provider: 'cpu';
  addon: boolean;
}

/** Model file names inside the cache; names are the release's, per the conventions doc. */
export const STT_FILES = {
  encoder: 'encoder-epoch-99-avg-1.int8.onnx',
  decoder: 'decoder-epoch-99-avg-1.int8.onnx',
  joiner: 'joiner-epoch-99-avg-1.int8.onnx',
  tokens: 'tokens.txt',
} as const;
export const TTS_FILES = { model: 'en_US-lessac-medium.onnx', tokens: 'tokens.txt', dataDir: 'espeak-ng-data' } as const;
export const KOKORO_FILES = {
  model: 'model.onnx',
  voices: 'voices.bin',
  tokens: 'tokens.txt',
  lexicon: 'lexicon-us-en.txt',
} as const;
export const VAD_FILES = { model: 'silero_vad.onnx' } as const;

/** 20 ms chunks: the recognition latency baseline in the conventions doc was measured with these. */
export const CHUNK_MS = 20;
/** Batch transcription padding — not optional. Without the leading pad the first word is lost,
 * without the trailing pad the last word is truncated. */
export const LEAD_PAD_S = 0.3;
export const TRAIL_PAD_S = 1.0;
/** Length of the silent decode warmUp() feeds the recogniser, in seconds. */
export const WARMUP_SILENCE_S = 0.5;

const require = createRequire(import.meta.url);

let sherpa: SherpaModule | null = null;
let addonError: string | null = null;
let addonTried = false;

/**
 * TEST-ONLY seam. Replaces the `require('sherpa-onnx-node')` probe so the degraded path can be
 * exercised on a machine that *does* have the prebuilt binary (and in CI, where it may not):
 * `__setAddonLoaderForTests(() => { throw new Error('…') })` makes this module behave exactly as
 * it would inside a server bundle without the addon, and `__setAddonLoaderForTests(null)` puts the
 * real probe back. It exists for `__tests__/voice-runtime-degraded.test.ts` and nothing else —
 * production code never calls it and `addonLoader` is null there, so the load path is unchanged.
 */
let addonLoader: (() => SherpaModule) | null = null;

/** The addon, or null when this machine cannot load it. Never throws. */
function loadSherpa(): SherpaModule | null {
  if (!addonTried) {
    addonTried = true;
    try {
      sherpa = addonLoader ? addonLoader() : (require('sherpa-onnx-node') as SherpaModule);
      if (!sherpa?.OnlineRecognizer || !sherpa?.OfflineTts || !sherpa?.Vad) throw new Error('sherpa-onnx-node exports are incomplete');
    } catch (e: any) {
      addonError = String(e?.message ?? e);
      sherpa = null;
      console.warn('[voice] sherpa-onnx-node unavailable, local voice disabled:', addonError.slice(0, 300));
    }
  }
  return sherpa;
}

/** Whether this platform can run local voice at all. Cheap: loads the addon once, no models. */
export function runtimeInfo(): VoiceRuntimeInfo {
  return { platform: process.platform, arch: process.arch, provider: 'cpu', addon: !!loadSherpa() };
}

/** Why the addon could not load, for logs and `/status`. Null when it loaded. */
export function runtimeError(): string | null {
  loadSherpa();
  return addonError;
}

/** Every file of one model, as absolute paths keyed by the file's path inside the model directory. */
export function modelPaths(model: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filesForModel(model)) out[f.path] = destFor(f);
  return out;
}

/**
 * The espeak-ng frontend data. It is listed under Piper's model (it is Piper's phonemiser) and
 * Kokoro points at the same directory rather than shipping a second copy of it.
 */
function espeakDataDir(): string {
  const enDict = filesForModel('piper-lessac-medium').find((f) => f.path.endsWith('/en_dict'));
  if (enDict) return path.dirname(destFor(enDict));
  return path.join(modelsRoot(), 'tts', 'piper-lessac-medium', 'espeak-ng-data');
}

function requireAddon(): SherpaModule {
  const s = loadSherpa();
  if (!s) throw new Error(`local voice runtime unavailable: ${addonError ?? 'sherpa-onnx-node addon missing'}`);
  return s;
}

/** One promise per key, dropped again on failure so a retry really retries. */
function cached<K, V>(map: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
  let p = map.get(key);
  if (!p) {
    p = Promise.resolve().then(make);
    map.set(key, p);
    p.catch(() => {
      if (map.get(key) === p) map.delete(key);
    });
  }
  return p;
}

let recognizerPromise: Promise<OnlineRecognizer> | null = null;
/** One engine per TTS model: Piper and Kokoro are separate 64 MB / 360 MB instances. */
const ttsCache = new Map<string, Promise<OfflineTts>>();
let vadPromise: Promise<Vad> | null = null;

/** Forget every loaded engine. Tests and the desktop app's "warm again" path use this. */
export function resetRuntimeCaches(): void {
  recognizerPromise = null;
  ttsCache.clear();
  vadPromise = null;
}

/**
 * TEST-ONLY: install (or with `null`, remove) the loader the addon probe uses, and forget every
 * memoised result — the probe's verdict and the loaded engines. Used only by
 * `__tests__/voice-runtime-degraded.test.ts` to prove the missing-addon path; it is never called
 * from server code, so the production load path is the plain `require` above.
 */
export function __setAddonLoaderForTests(loader: (() => unknown) | null): void {
  addonLoader = loader as (() => SherpaModule) | null;
  sherpa = null;
  addonError = null;
  addonTried = false;
  resetRuntimeCaches();
}

/** The bilingual zh+en streaming Zipformer, int8, 2 threads. ~250 ms to load warm, 197 MB on disk. */
export function getRecognizer(): Promise<OnlineRecognizer> {
  recognizerPromise ??= Promise.resolve().then(() => {
    const s = requireAddon();
    const p = modelPaths('zipformer-bilingual-int8');
    return new s.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: p[STT_FILES.encoder],
          decoder: p[STT_FILES.decoder],
          joiner: p[STT_FILES.joiner],
        },
        tokens: p[STT_FILES.tokens],
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      // Endpointing for the live call path: 0.8 s of trailing silence after a token ends a
      // sentence, 1.0 s when nothing has been said, 20 s caps an utterance.
      enableEndpoint: true,
      rule1MinTrailingSilence: 0.8,
      rule2MinTrailingSilence: 1.0,
      rule3MinUtteranceLength: 20,
    });
  }).catch((e) => {
    recognizerPromise = null;
    throw e;
  });
  return recognizerPromise;
}

function loadTts(spec: VoiceModelSpec): OfflineTts {
  const s = requireAddon();
  const p = modelPaths(spec.id);
  if (spec.engine === 'kokoro') {
    // sherpa-onnx-node ships no .d.ts: TypeScript infers its API from JSDoc, and that inference
    // collapses OfflineTtsModelConfig to `{ vits }`, so the Kokoro block the addon documents and
    // this code loads at runtime (24 000 Hz, 54 speakers) needs one escape hatch.
    const config = {
      model: {
        kokoro: {
          model: p[KOKORO_FILES.model],
          voices: p[KOKORO_FILES.voices],
          tokens: p[KOKORO_FILES.tokens],
          // Kokoro's G2P is espeak-ng too, with a US-English lexicon on top.
          dataDir: espeakDataDir(),
          lexicon: p[KOKORO_FILES.lexicon],
          lang: 'en-us',
        },
      },
      maxNumSentences: 1,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    };
    return new s.OfflineTts(config as any);
  }
  return new s.OfflineTts({
    model: { vits: { model: p[TTS_FILES.model], tokens: p[TTS_FILES.tokens], dataDir: espeakDataDir() } },
    maxNumSentences: 1,
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  });
}

/**
 * The TTS engine for one model, cached. Piper (22 050 Hz) is the default; Kokoro (24 000 Hz, 54
 * speakers) is the optional tier and takes ~1.1 s to load.
 */
export function getTts(model: string = DEFAULT_TTS_MODEL): Promise<OfflineTts> {
  const spec = ttsModel(model);
  if (!spec) return Promise.reject(new Error(`not a text-to-speech model: ${model}`));
  return cached(ttsCache, spec.id, async () => loadTts(spec));
}

/** The rate this model's engine produces, from the registry (no engine load needed). */
export function ttsSampleRate(model: string = DEFAULT_TTS_MODEL): number {
  const spec = ttsModel(model);
  if (!spec) throw new Error(`not a text-to-speech model: ${model}`);
  return spec.rate;
}

/** Silero VAD at 16 kHz. */
export function getVad(): Promise<Vad> {
  vadPromise ??= Promise.resolve().then(() => {
    const s = requireAddon();
    return new s.Vad({
      sileroVad: {
        model: modelPaths('silero-vad')[VAD_FILES.model],
        threshold: 0.5,
        minSilenceDuration: 0.35,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    }, 30);
  }).catch((e) => {
    vadPromise = null;
    throw e;
  });
  return vadPromise;
}

export interface WarmUpResult {
  ok: boolean;
  /** Time to load the recogniser: the ~250 ms a cold first utterance used to pay on top of audio. */
  recognizerMs: number;
  /** Time for the silent 0.5 s decode that primes the decoder. */
  decodeMs: number;
  /** Time to load the TTS engine, or null when TTS warming was skipped or failed. */
  ttsMs: number | null;
  model: string | null;
  totalMs: number;
  /** Set when the recogniser could not be warmed; `ok` is then false. */
  error?: string;
  /** Set when only the TTS warm-up failed (a missing optional model must not fail boot). */
  ttsError?: string;
}

/**
 * Load the recogniser and run one 0.5 s silent decode, then (by default) load the TTS engine.
 *
 * Cold start is the one latency number the budgets in docs/voice-local-conventions.md do not cover:
 * the first `transcribe()` of a process pays the recogniser's ~250 ms load on top of the audio, which
 * is where the 7.5× cold-start real-time factor in docs/local-voice-status.md comes from. One silent
 * decode at boot moves that cost out of the first real utterance.
 *
 * Never throws: a boot hook that can crash the server is worse than a cold first utterance.
 */
export async function warmUp(opts: { tts?: boolean; model?: string } = {}): Promise<WarmUpResult> {
  const started = performance.now();
  const result: WarmUpResult = { ok: false, recognizerMs: 0, decodeMs: 0, ttsMs: null, model: null, totalMs: 0 };
  try {
    const t0 = performance.now();
    const recognizer = await getRecognizer();
    result.recognizerMs = performance.now() - t0;

    const d0 = performance.now();
    const stream = recognizer.createStream();
    const silent = new Float32Array(Math.round(16000 * WARMUP_SILENCE_S));
    stream.acceptWaveform({ samples: silent, sampleRate: 16000 });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    stream.inputFinished();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    recognizer.getResult(stream).text; // force the result path too: that is where the transcript is built
    result.decodeMs = performance.now() - d0;
    result.ok = true;
  } catch (e: any) {
    result.error = String(e?.message ?? e);
    result.totalMs = performance.now() - started;
    return result;
  }

  if (opts.tts !== false) {
    const model = opts.model ?? DEFAULT_TTS_MODEL;
    try {
      const t0 = performance.now();
      await getTts(model);
      result.ttsMs = performance.now() - t0;
      result.model = ttsModel(model)?.id ?? null;
    } catch (e: any) {
      result.ttsError = String(e?.message ?? e);
    }
  }
  result.totalMs = performance.now() - started;
  return result;
}

// ---------- audio helpers ----------

/** PCM16 LE mono bytes → float32 in [-1, 1]. */
export function pcm16ToFloat(buf: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const n = bytes.byteLength >> 1; // drop a trailing odd byte rather than misreading it
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** float32 in [-1, 1] → PCM16 LE mono bytes (a plain ArrayBuffer, ready to hand to fetch/Response). */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(samples.length * 2);
  const view = new DataView(out);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return out;
}

/** Prepend/append the silence a streaming recognizer needs to hear the first and last word. */
export function padForBatch(samples: Float32Array, sampleRate: number): Float32Array {
  const lead = Math.round(LEAD_PAD_S * sampleRate);
  const tail = Math.round(TRAIL_PAD_S * sampleRate);
  const out = new Float32Array(lead + samples.length + tail);
  out.set(samples, lead);
  return out;
}

export interface TranscribeResult {
  text: string;
  /** Sampled wall time of the first non-empty partial, in ms. */
  firstPartialMs: number | null;
  /** Total wall time of the streaming pass, in ms. */
  ms: number;
  /** Audio duration fed to the recognizer, in ms (padding excluded). */
  audioMs: number;
}

/**
 * Transcribe one utterance: pad, stream in 20 ms chunks, flush. The stream's own rate is passed
 * through, so sherpa resamples 22 050 Hz TTS output as well as 16 kHz microphone audio.
 */
export async function transcribe(samples: Float32Array, sampleRate: number): Promise<TranscribeResult> {
  const recognizer = await getRecognizer();
  const padded = padForBatch(samples, sampleRate);
  const stream = recognizer.createStream();
  const chunk = Math.max(1, Math.round((sampleRate * CHUNK_MS) / 1000));
  const started = performance.now();
  let firstPartialMs: number | null = null;
  for (let i = 0; i < padded.length; i += chunk) {
    stream.acceptWaveform({ samples: padded.subarray(i, Math.min(i + chunk, padded.length)), sampleRate });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    if (firstPartialMs === null && recognizer.getResult(stream).text.trim()) firstPartialMs = performance.now() - started;
  }
  stream.acceptWaveform({ samples: new Float32Array(0), sampleRate });
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const ms = performance.now() - started;
  return {
    text: String(recognizer.getResult(stream).text ?? '').replace(/\s+/g, ' ').trim(),
    firstPartialMs,
    ms,
    audioMs: Math.round((samples.length / sampleRate) * 1000),
  };
}

export interface SynthesizeResult {
  samples: Float32Array;
  /** The rate the loaded engine reports: 22 050 for Piper, 24 000 for Kokoro. Never resampled. */
  sampleRate: number;
  /** Which model produced it. */
  model: string;
  /** Wall time from call to the first audio chunk, in ms. */
  firstAudioMs: number | null;
  /** Total wall time, in ms. */
  ms: number;
}

export interface SynthesizeOptions {
  speed?: number;
  /** A TTS model id; defaults to Piper lessac-medium. */
  model?: string;
  /** Kokoro speaker (0–53). Ignored by the single-speaker Piper model. */
  sid?: number;
}

/**
 * Synthesise one sentence with the chosen voice, reporting time-to-first-audio the way the call path
 * hears it. The second argument also accepts a bare model id, so `synthesize(text, 'kokoro-multi-lang')`
 * reads the way it sounds.
 */
export async function synthesize(text: string, opts: SynthesizeOptions | string = {}): Promise<SynthesizeResult> {
  const options: SynthesizeOptions = typeof opts === 'string' ? { model: opts } : opts;
  const spec = ttsModel(options.model ?? DEFAULT_TTS_MODEL);
  if (!spec) throw new Error(`not a text-to-speech model: ${options.model}`);
  const tts = await getTts(spec.id);
  const speed = Number.isFinite(options.speed) ? Math.min(1.5, Math.max(0.7, Number(options.speed))) : 1;
  const sid = spec.engine === 'kokoro' ? Math.max(0, Math.min(53, Math.round(Number(options.sid ?? 0)))) : 0;
  const started = performance.now();
  let firstAudioMs: number | null = null;
  const audio = await tts.generateAsync({
    text,
    sid,
    speed,
    onProgress: ({ samples }) => {
      if (firstAudioMs === null && samples?.length) firstAudioMs = performance.now() - started;
      return 1;
    },
  });
  const rate = Number(audio.sampleRate) || spec.rate;
  if (rate !== spec.rate) {
    // The registry is what the menu, /status and X-Audio-Rate promise; a drift here is a manifest bug,
    // so say so rather than quietly reporting a rate nobody advertised.
    console.warn(`[voice] ${spec.id} reported ${rate} Hz but the registry says ${spec.rate} Hz`);
  }
  return { samples: audio.samples, sampleRate: rate, model: spec.id, firstAudioMs, ms: performance.now() - started };
}

export interface VadSegment {
  startMs: number;
  endMs: number;
  durationMs: number;
}

/** Run Silero over the whole clip and collect every speech segment it found. */
export async function detectSegments(samples: Float32Array, sampleRate = 16000): Promise<VadSegment[]> {
  const vad = await getVad();
  vad.reset();
  vad.clear();
  const window = 512;
  for (let i = 0; i < samples.length; i += window) vad.acceptWaveform(samples.subarray(i, Math.min(i + window, samples.length)));
  vad.flush();
  const out: VadSegment[] = [];
  while (!vad.isEmpty()) {
    const seg = vad.front();
    const startMs = Math.round((seg.start / sampleRate) * 1000);
    const lengthMs = Math.round((seg.samples.length / sampleRate) * 1000);
    out.push({ startMs, endMs: startMs + lengthMs, durationMs: lengthMs });
    vad.pop();
  }
  return out;
}
