import type { Bot, VoiceLocalStatus, VoiceModelItem, VoiceModelState, VoiceModelStateValue, VoiceOption } from '@orbit/contracts';

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

export type LocalModelState = VoiceModelStateValue;
export type LocalVoiceStatus = VoiceLocalStatus;
/** One row of the model inventory; `rate` is what the engine produces, `size` its bytes on disk. */
export type LocalModelItem = VoiceModelItem;

/** `ready` means a call can run: the required models plus at least one installed voice. */
export interface LocalModels { items: LocalModelItem[]; ready: boolean }

/** `POST /api/voice/local/models/download`: backgrounded, so `started` only says work was queued. */
export interface LocalDownloadResult {
  started: boolean;
  model: string | null;
  startedModels: string[];
  state: VoiceModelState;
  /** Per-model states — the only place an optional voice's state (or its error) shows up. */
  states: Record<string, LocalModelState>;
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
      const s = (await r.json()) as LocalVoiceStatus;
      // An older server has no inventory in /status; treat it as an empty one.
      return { ...s, voices: Array.isArray(s.voices) ? s.voices : [] };
    })
    .catch((e) => { statusPromise = null; throw e; }));
}

let modelsPromise: Promise<LocalModels> | null = null;

/**
 * The voice menu. Cached like the status, because the picker polls it while a download runs; pass
 * `refresh` to bypass (every 2 s poll does, and so does right after a download starts).
 */
export function localModels(refresh = false): Promise<LocalModels> {
  if (refresh) modelsPromise = null;
  return (modelsPromise ??= fetch('/api/voice/local/models', { credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as LocalModels;
    })
    .catch((e) => { modelsPromise = null; throw e; }));
}

/**
 * Download one model by id (e.g. the optional Kokoro tier). Backgrounded: the caller polls
 * `localModels(true)` until that model's own `state` is `ready`.
 */
export function downloadLocalModel(model: string, opts: { fresh?: boolean } = {}): Promise<LocalDownloadResult> {
  modelsPromise = null; // not a pre-download snapshot
  statusPromise = null;
  return post<LocalDownloadResult>('/local/models/download', opts.fresh ? { model, fresh: true } : { model });
}

/** Stop a model's download. What it finished stays on disk, so a later download resumes. */
export function cancelLocalModel(model: string): Promise<{ cancelled: boolean; items: VoiceModelItem[] }> {
  modelsPromise = null;
  statusPromise = null;
  return post('/local/models/cancel', { model });
}

/** Delete a model's files from this machine. */
export async function deleteLocalModel(model: string): Promise<{ removed: number; bytes: number; items: VoiceModelItem[] }> {
  modelsPromise = null;
  statusPromise = null;
  const res = await fetch(`/api/voice/local/models/${encodeURIComponent(model)}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ removed: number; bytes: number; items: VoiceModelItem[] }>;
}

/**
 * The per-bot voice choice: `PATCH /api/bots/:id` with only the two voice keys, so saving a voice
 * never races the bot's other fields. Returns the bot the server stored.
 */
export async function saveBotVoice(botId: string, patch: { voiceProvider?: 'cloud' | 'local'; voiceModel?: string }): Promise<{ bot: Bot }> {
  const body: Record<string, string> = {};
  if (patch.voiceProvider !== undefined) body.voiceProvider = patch.voiceProvider;
  if (patch.voiceModel !== undefined) body.voiceModel = patch.voiceModel;
  const res = await fetch(`/api/bots/${botId}`, {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json() as Promise<{ bot: Bot }>;
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
  localModels,
  downloadLocalModel,
  cancelLocalModel,
  deleteLocalModel,
  saveBotVoice,

  /** On-device preview through the bot's chosen model: raw PCM16 plus the rate the engine produced. */
  async localPreview(p: { text: string; speed?: number; model?: string }): Promise<LocalPreview> {
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
