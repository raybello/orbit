/**
 * Low-level HTTP adapter for an audio.cpp server (audiocpp_server): GPU speech recognition (OWSM),
 * streaming speech (LFM3-Audio) and the lip-synced portrait video (SoulX-FlashHead). No session
 * state; every function is one request. The call logic is voice-audiocpp-session.ts.
 *
 * Wire facts this file relies on (audio.cpp app/server/api.md, verified against v0.9.5):
 * - `POST /v1/audio/transcriptions` takes a multipart WAV upload and answers `{ text, timing }`.
 * - `POST /v1/audio/speech` with `stream_format: 'sse'` and `response_format: 'pcm'` streams
 *   `speech.audio.delta` events whose `audio` is base64 PCM16 at the model's rate (24 kHz for LFM3).
 * - `POST /v1/recipes/run` with recipe `speaking-avatar` runs TTS into the avatar through a bounded
 *   PCM pipe, so video starts while speech is still being generated. Its SSE `task.stream.event`s
 *   carry `audio` (a base64 WAV of that event's samples) and `artifacts` whose `meta.format` is
 *   `rgb24` (a chunk of `frames` raw 24-bit frames at `fps`), then one `task.stream.done`.
 * - `POST /v1/ui/upload` stores a raw body as a server-local file and returns its `path`: the only
 *   way to hand a portrait to a server that does not share this process's filesystem (a native
 *   Windows server, or a remote GPU box). Needs `"ui": true` in the server config.
 */
import { env } from './env.js';

/** Model ids in the audio.cpp server config (infra/audiocpp/server-config.json). */
export const AUDIOCPP_MODELS = {
  asr: process.env.AUDIOCPP_ASR_MODEL?.trim() || 'chat-recognition',
  tts: process.env.AUDIOCPP_TTS_MODEL?.trim() || 'chat-voice',
  avatar: process.env.AUDIOCPP_AVATAR_MODEL?.trim() || 'chat-avatar',
} as const;

/** LFM3-Audio speaks at 24 kHz; the server never resamples, and neither do we. */
export const AUDIOCPP_TTS_RATE = 24000;
/** OWSM listens at 16 kHz mono; the browser already sends exactly that. */
export const AUDIOCPP_ASR_RATE = 16000;

const url = (p: string) => `${env.audiocppUrl}${p}`;

export class AudiocppError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = 'AudiocppError';
  }
}

async function failure(what: string, r: Response): Promise<AudiocppError> {
  let detail = '';
  try {
    const j = (await r.json()) as { error?: { message?: string } | string };
    detail = typeof j.error === 'string' ? j.error : j.error?.message ?? '';
  } catch {
    /* not json */
  }
  return new AudiocppError(`${what} failed (HTTP ${r.status})${detail ? `: ${detail}` : ''}`, r.status);
}

// ---------- readiness ----------

export interface AudiocppModelInfo {
  id: string;
  family?: string;
  task?: string;
  mode?: string;
  loaded?: boolean;
}

/** `GET /health`: the server answers. Says nothing about which models are loaded (see audiocppModels). */
export async function audiocppReady(timeoutMs = 2000): Promise<{ ok: boolean; reason?: 'unreachable' | 'server-error' }> {
  try {
    const r = await fetch(url('/health'), { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, reason: 'server-error' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** `GET /v1/models`: the configured entries and whether each is loaded. */
export async function audiocppModels(timeoutMs = 3000): Promise<AudiocppModelInfo[]> {
  const r = await fetch(url('/v1/models'), { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw await failure('model list', r);
  const j = (await r.json()) as { data?: AudiocppModelInfo[] };
  return Array.isArray(j.data) ? j.data : [];
}

// ---------- audio helpers ----------

/** A mono PCM16 LE WAV of `pcm` at `rate`. */
export function pcm16ToWav(pcm: Int16Array, rate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * The samples of a PCM16 WAV, walking its chunks rather than assuming a 44-byte header. Stereo is
 * downmixed by taking the first channel (audio.cpp's speech output is mono; this is a guard).
 */
export function wavToPcm16(buf: Buffer): { pcm: Int16Array; rate: number } {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudiocppError('not a WAV payload');
  }
  let rate = AUDIOCPP_TTS_RATE;
  let channels = 1;
  let bits = 16;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new AudiocppError(`unsupported WAV sample size ${bits}`);
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) pcm[i] = buf.readInt16LE(body + i * 2 * channels);
      return { pcm, rate };
    }
    off = body + size + (size & 1);
  }
  return { pcm: new Int16Array(0), rate };
}

/** Base64 PCM16 LE → samples (copied: the Buffer pool must not be aliased). */
function pcmFromBase64(b64: string): Int16Array {
  const b = Buffer.from(b64, 'base64');
  const out = new Int16Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
  return out;
}

// ---------- SSE ----------

/**
 * Parsed `data: {…}` events from an SSE body, in order. Lines are split as bytes arrive and only a
 * line's own chunks are concatenated, so a 25 MB avatar event costs one copy, not one per network
 * read. `data: [DONE]` ends the stream; comment and blank lines are skipped.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  let pending: Buffer[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let nl: number;
      while ((nl = chunk.indexOf(10)) >= 0) {
        pending.push(chunk.subarray(0, nl));
        const line = (pending.length === 1 ? pending[0] : Buffer.concat(pending)).toString('utf8').replace(/\r$/, '');
        pending = [];
        chunk = chunk.subarray(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          /* a malformed event is skipped, never fatal */
        }
      }
      if (chunk.length) pending.push(Buffer.from(chunk)); // copy: the reader may reuse its buffer
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
}

function streamError(e: Record<string, unknown>): AudiocppError | null {
  if (e.type !== 'error') return null;
  const err = e.error as { message?: string } | string | undefined;
  return new AudiocppError(typeof err === 'string' ? err : err?.message ?? 'audio.cpp stream failed');
}

// ---------- ASR ----------

/**
 * OWSM offline ASR of one utterance. `language` is a short code or 'auto' (OWSM detects).
 * Returns the trimmed transcript and audio.cpp's own wall time.
 */
export async function transcribe(
  pcm: Int16Array,
  sampleRate = AUDIOCPP_ASR_RATE,
  opts: { language?: string; signal?: AbortSignal } = {},
): Promise<{ text: string; ms: number; audioMs: number }> {
  const form = new FormData();
  form.append('model', AUDIOCPP_MODELS.asr);
  const lang = (opts.language ?? 'auto').split('-')[0].toLowerCase();
  form.append('language', /^[a-z]{2,3}$/.test(lang) ? lang : 'auto');
  form.append('file', new Blob([new Uint8Array(pcm16ToWav(pcm, sampleRate))], { type: 'audio/wav' }), 'utterance.wav');
  const r = await fetch(url('/v1/audio/transcriptions'), { method: 'POST', body: form, signal: opts.signal ?? AbortSignal.timeout(60_000) });
  if (!r.ok) throw await failure('speech recognition', r);
  const j = (await r.json()) as { text?: string; timing?: { wall_ms?: number; audio_duration_ms?: number } };
  return {
    text: String(j.text ?? '').replace(/\s+/g, ' ').trim(),
    ms: Math.round(j.timing?.wall_ms ?? 0),
    audioMs: Math.round(j.timing?.audio_duration_ms ?? (pcm.length / sampleRate) * 1000),
  };
}

// ---------- TTS ----------

/**
 * `POST /v1/audio/speech`, streamed: 24 kHz PCM16 chunks as LFM3-Audio produces them. Aborting the
 * signal closes the stream, which audio.cpp turns into stopping the run within an event or two.
 */
export async function* streamSpeech(
  text: string,
  voice: string,
  signal?: AbortSignal,
): AsyncGenerator<{ pcm: Int16Array; rate: number }> {
  const r = await fetch(url('/v1/audio/speech'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model: AUDIOCPP_MODELS.tts, input: text, voice, response_format: 'pcm', stream_format: 'sse' }),
    signal,
  });
  if (!r.ok || !r.body) throw await failure('speech', r);
  for await (const e of sseEvents(r.body)) {
    const err = streamError(e);
    if (err) throw err;
    if (e.type === 'speech.audio.delta' && typeof e.audio === 'string') {
      const pcm = pcmFromBase64(e.audio);
      if (pcm.length) yield { pcm, rate: AUDIOCPP_TTS_RATE };
    }
  }
}

/** Whole-utterance speech (voice preview): every chunk of streamSpeech, joined. */
export async function synthesize(text: string, voice: string, signal?: AbortSignal): Promise<{ pcm: Int16Array; rate: number }> {
  const parts: Int16Array[] = [];
  let n = 0;
  for await (const c of streamSpeech(text, voice, signal)) {
    parts.push(c.pcm);
    n += c.pcm.length;
  }
  const pcm = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    pcm.set(p, o);
    o += p.length;
  }
  return { pcm, rate: AUDIOCPP_TTS_RATE };
}

// ---------- avatar ----------

export type AvatarStreamItem =
  | { kind: 'audio'; pcm: Int16Array; rate: number }
  /** `rgb` holds `frames` packed RGB24 frames of width×height, played at `fps`. */
  | { kind: 'video'; rgb: Buffer; frames: number; fps: number; width: number; height: number };

/**
 * The `speaking-avatar` recipe: LFM3-Audio speech piped into SoulX-FlashHead as it is generated.
 * Yields reply audio and rgb24 video chunks in stream order; the caller pairs them (audio is the
 * clock: each video chunk covers frames/fps seconds of the audio that came before it).
 *
 * `portraitPath` must be readable by the audio.cpp server (see uploadToServer).
 */
export async function* streamSpeakingAvatar(
  text: string,
  voice: string,
  portraitPath: string,
  signal?: AbortSignal,
): AsyncGenerator<AvatarStreamItem> {
  const r = await fetch(url('/v1/recipes/run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      recipe: 'speaking-avatar',
      stream: true,
      include_artifacts: true,
      models: { tts: AUDIOCPP_MODELS.tts, avatar: AUDIOCPP_MODELS.avatar },
      request: { text, voice_id: voice, options: { 'avatar.reference_image_file': portraitPath } },
    }),
    signal,
  });
  if (!r.ok || !r.body) throw await failure('avatar', r);
  for await (const e of sseEvents(r.body)) {
    const err = streamError(e);
    if (err) throw err;
    if (e.type !== 'task.stream.event') continue;
    const ev = e.event as { audio?: unknown; artifacts?: { payload?: unknown; meta?: Record<string, string> }[] } | undefined;
    if (!ev) continue;
    if (typeof ev.audio === 'string' && ev.audio) {
      const { pcm, rate } = wavToPcm16(Buffer.from(ev.audio, 'base64'));
      if (pcm.length) yield { kind: 'audio', pcm, rate };
    }
    for (const a of ev.artifacts ?? []) {
      const m = a.meta ?? {};
      if (m.format !== 'rgb24' || typeof a.payload !== 'string') continue;
      const width = Number(m.width), height = Number(m.height), frames = Number(m.frames), fps = Number(m.fps);
      if (![width, height, frames].every((x) => Number.isSafeInteger(x) && x > 0) || !(fps > 0)) continue;
      const rgb = Buffer.from(a.payload, 'base64');
      if (rgb.length < width * height * 3 * frames) continue; // truncated chunk: skip rather than draw garbage
      yield { kind: 'video', rgb, frames, fps, width, height };
    }
  }
}

// ---------- files ----------

/**
 * Store `bytes` on the audio.cpp server (`POST /v1/ui/upload`) and return the server-local path, or
 * null when the server has uploads disabled (`"ui": false`) — the caller then falls back to a path
 * on a shared volume.
 */
export async function uploadToServer(bytes: Buffer, filename: string, signal?: AbortSignal): Promise<string | null> {
  const r = await fetch(url('/v1/ui/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-audiocpp-filename': filename },
    body: new Uint8Array(bytes),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw await failure('portrait upload', r);
  const j = (await r.json()) as { path?: string };
  return typeof j.path === 'string' && j.path ? j.path : null;
}
