import type { VoiceOption } from '@orbit/contracts';

export interface VoiceSession {
  callId: string;
  clientSecret: string;
  expiresAt: number;
  model: string;
  websocketUrl: string;
  sampleRate: number;
  instructions: string;
  voice: string;
  speed: number;
  language: string;
  tools: unknown[];
  session: Record<string, unknown>;
}

export interface VoiceOptions { voices: VoiceOption[]; languages: { code: string; name: string }[]; speeds: number[] }

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/voice${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------- on-device voice (docs/voice-local-conventions.md) ----------
// Types are duplicated from the contract on purpose: the web app must not hard-depend on the
// parent-owned contracts file adding these in the same change.

export type LocalModelState = 'missing' | 'downloading' | 'ready' | 'error';

export interface LocalVoiceStatus {
  available: boolean;
  reason?: string;
  runtime: { platform: string; arch: string; provider: 'cpu'; addon: boolean };
  models: { stt: LocalModelState; tts: LocalModelState; vad: LocalModelState };
  bytes: { total: number; have: number };
  download: { active: boolean; pct: number; name: string | null };
}

export interface LocalPreview { pcm: Int16Array; rate: number }

export interface LocalSession {
  callId: string;
  /** Rate the session expects on the socket, 16 000 Hz mono PCM16. */
  sampleRate: number;
  /** Rate the server synthesizes replies at (Piper lessac-medium: 22 050). */
  ttsSampleRate: number;
}

/** Piper lessac-medium speaks at 22 050 Hz; the server reports the real rate in `X-Audio-Rate`. */
export const LOCAL_TTS_RATE = 22050;

/**
 * Parse `POST /api/voice/local/preview`: the body is raw PCM16 LE mono and the sample rate rides in
 * the `X-Audio-Rate` header. Pure, so it is unit-tested without a browser.
 */
export function parseLocalPreviewResponse(headers: Pick<Headers, 'get'>, body: ArrayBuffer): LocalPreview {
  const rate = Number(headers.get('X-Audio-Rate'));
  return {
    pcm: new Int16Array(body, 0, body.byteLength >> 1),
    rate: Number.isFinite(rate) && rate > 0 ? Math.round(rate) : LOCAL_TTS_RATE,
  };
}

let statusPromise: Promise<LocalVoiceStatus> | null = null;

/** Cached: the status is polled by the UI and read on every dictation start. Pass `refresh` to bypass. */
function localStatus(refresh = false): Promise<LocalVoiceStatus> {
  if (refresh) statusPromise = null;
  return (statusPromise ??= fetch('/api/voice/local/status', { credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as LocalVoiceStatus;
    })
    .catch((e) => { statusPromise = null; throw e; }));
}

/** `POST /api/voice/local/models/download` is idempotent and runs in the background; poll status for progress. */
function downloadLocalModels(kind?: 'stt' | 'tts' | 'vad'): Promise<{ started: boolean; state: LocalVoiceStatus['models'] }> {
  statusPromise = null; // the next status read must not be a pre-download snapshot
  return post<{ started: boolean; state: LocalVoiceStatus['models'] }>('/local/models/download', kind ? { kind } : {});
}

let optionsPromise: Promise<VoiceOptions> | null = null;

/**
 * `POST /api/voice/local/session` opens the streaming session; the socket URL is derived from it.
 * The server always reports both rates, but keep the documented defaults if a field is missing.
 */
export async function startLocalSession(botId: string): Promise<LocalSession> {
  const s = await post<{ callId?: unknown; sampleRate?: unknown; ttsSampleRate?: unknown }>('/local/session', { botId });
  if (typeof s?.callId !== 'string' || !s.callId) throw new Error('Local voice session was not created');
  const rate = Number(s.sampleRate);
  const tts = Number(s.ttsSampleRate);
  return {
    callId: s.callId,
    sampleRate: Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 16000,
    ttsSampleRate: Number.isFinite(tts) && tts > 0 ? Math.round(tts) : LOCAL_TTS_RATE,
  };
}

export const voiceApi = {
  options: () => (optionsPromise ??= fetch('/api/voice/options', { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<VoiceOptions>;
  }).catch((e) => { optionsPromise = null; throw e; })),
  session: (botId: string) => post<VoiceSession>('/session', { botId }),
  tool: (botId: string, callId: string, name: string, args: unknown) => post<{ output: string; taskSeq?: number }>('/tool', { botId, callId, name, args }),
  end: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[], error?: string) => post<{ ok: true }>('/end', { botId, callId, transcript, error }),
  /** Best-effort end on tab close. */
  endBeacon: (botId: string, callId: string, transcript: { role: 'user' | 'assistant'; text: string }[]) => {
    try { navigator.sendBeacon('/api/voice/end', new Blob([JSON.stringify({ botId, callId, transcript })], { type: 'application/json' })); } catch { /* ignore */ }
  },
  async preview(p: { botId: string; voice?: string; speed?: number; language?: string; text?: string }): Promise<Int16Array> {
    const res = await fetch('/api/voice/preview', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, codec: 'pcm' }) });
    if (!res.ok) throw new Error('Preview unavailable');
    const buf = await res.arrayBuffer();
    return new Int16Array(buf, 0, buf.byteLength >> 1);
  },
  async transcribe(blob: Blob, language?: string): Promise<string> {
    const fd = new FormData();
    if (language) fd.append('language', language);
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    fd.append('file', blob, `dictation.${ext}`);
    const res = await fetch('/api/voice/stt', { method: 'POST', credentials: 'include', body: fd });
    if (!res.ok) {
      let msg = 'Transcription failed';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return ((await res.json()) as { text: string }).text;
  },

  localStatus,
  downloadLocalModels,

  /** On-device Piper preview: raw PCM16 plus the rate the server actually produced (22 050 Hz). */
  async localPreview(p: { text: string; speed?: number }): Promise<LocalPreview> {
    const res = await fetch('/api/voice/local/preview', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    if (!res.ok) {
      let msg = 'Preview unavailable';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return parseLocalPreviewResponse(res.headers, await res.arrayBuffer());
  },

  /** On-device STT: raw PCM16 LE mono, with the capture rate so sherpa can resample internally. */
  async transcribeLocal(pcm: Int16Array, rate: number): Promise<string> {
    // Copy through a plain ArrayBuffer so the body is a valid BufferSource regardless of the view's offset.
    const body = new Uint8Array(pcm.byteLength);
    body.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    const res = await fetch('/api/voice/local/stt', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Rate': String(Math.round(rate)) },
      body,
    });
    if (!res.ok) {
      let msg = 'Transcription failed';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return ((await res.json()) as { text: string }).text;
  },
};
