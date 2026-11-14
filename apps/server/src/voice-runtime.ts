/**
 * The on-device speech stack: sherpa-onnx-node engines, loaded lazily and once.
 *
 * Everything here is CPU. That is not a fallback, it is the measured best case:
 * `provider: 'coreml'` segfaults this process on the Piper VITS model (exit 139) and makes
 * streaming STT three times slower (18.9× vs 56.5× real-time on CPU), and the npm package's Linux
 * binaries contain no CUDA execution provider at all. See docs/voice-local-conventions.md.
 *
 * The native addon is required inside a try/catch: a missing or ABI-incompatible binary must show
 * up as `addon: false` in `/local/status`, not as a crash on import (the Docker image is musl, and
 * a fresh checkout may have no prebuilt binary for its platform).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { env } from './env.js';

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

/** Model files inside the cache; names are the release's, per the conventions doc. */
export const STT_FILES = {
  encoder: 'encoder-epoch-99-avg-1.int8.onnx',
  decoder: 'decoder-epoch-99-avg-1.int8.onnx',
  joiner: 'joiner-epoch-99-avg-1.int8.onnx',
  tokens: 'tokens.txt',
} as const;
export const TTS_FILES = { model: 'en_US-lessac-medium.onnx', tokens: 'tokens.txt', dataDir: 'espeak-ng-data' } as const;
export const VAD_FILES = { model: 'silero_vad.onnx' } as const;

/** 20 ms chunks: the recognition latency baseline in the conventions doc was measured with these. */
export const CHUNK_MS = 20;
/** Batch transcription padding — not optional. Without the leading pad the first word is lost,
 * without the trailing pad the last word is truncated. */
export const LEAD_PAD_S = 0.3;
export const TRAIL_PAD_S = 1.0;

const require = createRequire(import.meta.url);

let sherpa: SherpaModule | null = null;
let addonError: string | null = null;
let addonTried = false;

/** The addon, or null when this machine cannot load it. Never throws. */
function loadSherpa(): SherpaModule | null {
  if (!addonTried) {
    addonTried = true;
    try {
      sherpa = require('sherpa-onnx-node') as SherpaModule;
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

/** The models that would be needed, as absolute paths inside VOICE_MODELS_DIR. */
export function modelPaths() {
  const root = env.voiceModelsDir;
  const stt = path.join(root, 'stt');
  const tts = path.join(root, 'tts');
  return {
    stt: { encoder: path.join(stt, STT_FILES.encoder), decoder: path.join(stt, STT_FILES.decoder), joiner: path.join(stt, STT_FILES.joiner), tokens: path.join(stt, STT_FILES.tokens) },
    tts: { model: path.join(tts, TTS_FILES.model), tokens: path.join(tts, TTS_FILES.tokens), dataDir: path.join(tts, TTS_FILES.dataDir) },
    vad: { model: path.join(root, 'vad', VAD_FILES.model) },
  };
}

function requireAddon(): SherpaModule {
  const s = loadSherpa();
  if (!s) throw new Error(`local voice runtime unavailable: ${addonError ?? 'sherpa-onnx-node addon missing'}`);
  return s;
}

let recognizerPromise: Promise<OnlineRecognizer> | null = null;
let ttsPromise: Promise<OfflineTts> | null = null;
let vadPromise: Promise<Vad> | null = null;

/** The bilingual zh+en streaming Zipformer, int8, 2 threads. ~250 ms to load warm, 197 MB on disk. */
export function getRecognizer(): Promise<OnlineRecognizer> {
  recognizerPromise ??= Promise.resolve().then(() => {
    const s = requireAddon();
    const p = modelPaths().stt;
    return new s.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
        tokens: p.tokens,
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
  }).catch((e) => { recognizerPromise = null; throw e; });
  return recognizerPromise;
}

/** Piper en_US-lessac-medium (VITS). Reports its own 22 050 Hz — the server never resamples. */
export function getTts(): Promise<OfflineTts> {
  ttsPromise ??= Promise.resolve().then(() => {
    const s = requireAddon();
    const p = modelPaths().tts;
    return new s.OfflineTts({
      model: { vits: { model: p.model, tokens: p.tokens, dataDir: p.dataDir } },
      maxNumSentences: 1,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    });
  }).catch((e) => { ttsPromise = null; throw e; });
  return ttsPromise;
}

/** Silero VAD at 16 kHz. */
export function getVad(): Promise<Vad> {
  vadPromise ??= Promise.resolve().then(() => {
    const s = requireAddon();
    return new s.Vad({
      sileroVad: {
        model: modelPaths().vad.model,
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
  }).catch((e) => { vadPromise = null; throw e; });
  return vadPromise;
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
  sampleRate: number;
  /** Wall time from call to the first audio chunk, in ms. */
  firstAudioMs: number | null;
  /** Total wall time, in ms. */
  ms: number;
}

/** Synthesise one sentence, reporting time-to-first-audio the way the call path hears it. */
export async function synthesize(text: string, opts: { speed?: number } = {}): Promise<SynthesizeResult> {
  const tts = await getTts();
  const speed = Number.isFinite(opts.speed) ? Math.min(1.5, Math.max(0.7, Number(opts.speed))) : 1;
  const started = performance.now();
  let firstAudioMs: number | null = null;
  const audio = await tts.generateAsync({
    text,
    sid: 0,
    speed,
    onProgress: ({ samples }) => {
      if (firstAudioMs === null && samples?.length) firstAudioMs = performance.now() - started;
      return 1;
    },
  });
  return { samples: audio.samples, sampleRate: audio.sampleRate, firstAudioMs, ms: performance.now() - started };
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
