// GPU voice calls through audio.cpp: mic → 16 kHz PCM16 over a WebSocket to the server's audiocpp
// session; replies come back as 24 kHz PCM16 and, when the bot has a portrait, lip-synced JPEG frames.
//
// Wire shape (apps/server/src/voice-audiocpp-session.ts):
//   POST /api/voice/audiocpp/session { botId } -> { callId, sampleRate, ttsSampleRate, hasAvatar }
//   WS   /api/voice/audiocpp/call/:callId
//     client → server: binary PCM16 16 kHz; text {type:'mute', on}, {type:'end'}
//     server → client: binary 0x01 + PCM16 (reply audio), 0x02 + u16 frame index + JPEG (avatar frame);
//                      text ready, listening, transcript, reply, thinking, speaking, avatar, barge-in, done, error, end
//
// Audio is the clock. An `avatar` event announces a video chunk (frames at fps); the next 0x01 frame
// is exactly that chunk's audio, and the chunk's frames are drawn from the moment that audio starts
// playing. Drives the same `useVoice` store as the other call paths so the call bar works unchanged.
import { create } from 'zustand';
import type { Caption } from './call';
import { useVoice } from './call';
import { startAudiocppSession } from './api';
import { MicCapture, PcmPlayer, createAudioContext, micErrorMessage, openMic } from './audio';
import { LOCAL_IN_RATE, StreamResampler, toPcm16 } from './resample';

const WS_PATH = '/api/voice/audiocpp/call';
const CONNECT_TIMEOUT_MS = 15000;
export const FRAME_AUDIO = 0x01;
export const FRAME_VIDEO = 0x02;

/** What the call bar needs to show the portrait video. */
interface AvatarCallState {
  /** The call streams avatar video (the bot has a portrait and the server has the avatar model). */
  hasAvatar: boolean;
  /** At least one frame has been drawn this call. */
  videoLive: boolean;
}
export const useAvatarCall = create<AvatarCallState>(() => ({ hasAvatar: false, videoLive: false }));

const setV = (p: Partial<ReturnType<typeof useVoice.getState>>) => useVoice.setState(p);

type ServerFrame =
  | { type: 'ready'; ttsSampleRate?: number; hasAvatar?: boolean }
  | { type: 'listening'; on?: boolean }
  | { type: 'transcript'; text?: string; final?: boolean }
  | { type: 'reply'; text?: string }
  | { type: 'thinking' }
  | { type: 'speaking'; on?: boolean }
  | { type: 'avatar'; frames?: number; fps?: number; width?: number; height?: number }
  | { type: 'barge-in' }
  | { type: 'done' }
  | { type: 'error'; message?: string }
  | { type: 'end' };

/** One announced video chunk: `frames` at `fps`, starting at AudioContext time `start`. */
interface VideoChunk {
  frames: number;
  fps: number;
  start: number | null;
  bitmaps: (ImageBitmap | undefined)[];
}

/**
 * Pure part of the frame scheduler, tested without a browser: which frame of which chunk is due at
 * AudioContext time `t`. Returns null between chunks (the last drawn frame stays on the canvas).
 */
export function dueFrame(chunks: { start: number | null; frames: number; fps: number }[], t: number): { chunk: number; frame: number } | null {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.start === null) continue;
    const end = c.start + c.frames / c.fps;
    if (t < c.start || t >= end) continue;
    return { chunk: i, frame: Math.min(c.frames - 1, Math.floor((t - c.start) * c.fps)) };
  }
  return null;
}

/** Split a binary server frame into its type byte and payload. */
export function parseBinaryFrame(buf: ArrayBuffer): { type: 'audio'; pcm: Int16Array } | { type: 'video'; index: number; jpeg: Uint8Array } | null {
  const bytes = new Uint8Array(buf);
  if (!bytes.length) return null;
  if (bytes[0] === FRAME_AUDIO) {
    // Copy: the PCM after the type byte is not 2-byte aligned inside the original buffer.
    const body = bytes.slice(1);
    return { type: 'audio', pcm: new Int16Array(body.buffer, 0, body.byteLength >> 1) };
  }
  if (bytes[0] === FRAME_VIDEO && bytes.length > 3) {
    return { type: 'video', index: bytes[1] | (bytes[2] << 8), jpeg: bytes.subarray(3) };
  }
  return null;
}

let current: AudiocppCall | null = null;
let canvas: HTMLCanvasElement | null = null;

/** The call bar hands its <canvas> over (and back, with null) as it mounts and unmounts. */
export function registerAvatarCanvas(el: HTMLCanvasElement | null) {
  canvas = el;
}

class AudiocppCall {
  ended = false;
  readonly ctx: AudioContext;
  readonly player: PcmPlayer;
  private readonly captureCtx: AudioContext;
  private mic: MicCapture | null = null;
  private ws: WebSocket | null = null;
  private ready = false;
  private ttsRate = 24000;
  private readonly resampler = new StreamResampler();
  private captionSeq = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private onUnload = () => this.end();

  // avatar video
  private pendingChunk: VideoChunk | null = null;
  private chunks: VideoChunk[] = [];
  private raf = 0;
  private lastDrawn = '';

  constructor(readonly botId: string) {
    this.ctx = createAudioContext();
    this.player = new PcmPlayer(this.ctx);
    this.captureCtx = createAudioContext(LOCAL_IN_RATE);
    this.player.onIdle = () => setV({ speaking: false });
  }

  micLevel() {
    return useVoice.getState().muted ? 0 : this.mic?.level ?? 0;
  }

  async start() {
    setV({ status: 'connecting', botId: this.botId, callId: null, muted: false, speaking: false, listening: false, thinking: false, working: [], captions: [], error: null, startedAt: null, blocked: null });
    useAvatarCall.setState({ hasAvatar: false, videoLive: false });
    window.addEventListener('pagehide', this.onUnload);
    window.addEventListener('beforeunload', this.onUnload);
    let stream: MediaStream;
    try {
      stream = await openMic({ sampleRate: LOCAL_IN_RATE });
    } catch (e) {
      this.end(micErrorMessage(e));
      return;
    }
    if (this.ended) { stream.getTracks().forEach((t) => t.stop()); return; }
    try {
      this.mic = new MicCapture(this.captureCtx, stream, (frame) => this.sendAudio(frame), LOCAL_IN_RATE);
      await this.mic.start();
      if (this.ended) return;
      const sess = await startAudiocppSession(this.botId);
      if (this.ended) return;
      this.ttsRate = sess.ttsSampleRate;
      useAvatarCall.setState({ hasAvatar: sess.hasAvatar });
      setV({ callId: sess.callId });
      this.connect(sess.callId);
    } catch (e) {
      this.end((e as Error).message || 'Could not start the call');
    }
  }

  private connect(callId: string) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}/${encodeURIComponent(callId)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connectTimer = setTimeout(() => { if (!this.ready) this.end('Couldn’t connect the call'); }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ended) return;
      if (useVoice.getState().muted) this.sendRaw(JSON.stringify({ type: 'mute', on: true }));
    };
    ws.onmessage = (m: MessageEvent<string | ArrayBuffer>) => {
      if (this.ended) return;
      if (typeof m.data === 'string') {
        try { this.handle(JSON.parse(m.data) as ServerFrame); } catch (e) { console.warn('[voice] bad audiocpp event', e); }
        return;
      }
      if (m.data instanceof ArrayBuffer) this.binary(m.data);
    };
    const drop = () => { if (!this.ended) this.end(this.ready ? 'Call dropped' : 'Couldn’t connect the call'); };
    ws.onclose = drop;
    ws.onerror = drop;
  }

  private sendRaw(data: string | ArrayBuffer) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(data); } catch (e) { console.warn('[voice] audiocpp send failed', e); }
  }

  private sendAudio(frame: Int16Array) {
    if (this.ended || !frame.length || useVoice.getState().muted) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const f = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) f[i] = frame[i] / 0x8000;
    const pcm = toPcm16(this.resampler.process(f, LOCAL_IN_RATE));
    if (pcm.length) this.sendRaw(pcm.buffer as ArrayBuffer);
  }

  private binary(buf: ArrayBuffer) {
    const f = parseBinaryFrame(buf);
    if (!f) return;
    if (f.type === 'audio') {
      if (!f.pcm.length) return;
      const at = this.player.push(f.pcm, this.ttsRate);
      setV({ speaking: true, thinking: false });
      // The audio that follows an `avatar` event is that chunk's: its frames start when it does.
      if (this.pendingChunk) {
        this.pendingChunk.start = at;
        this.chunks.push(this.pendingChunk);
        this.pendingChunk = null;
        this.ensureDrawing();
      }
      return;
    }
    const chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || f.index >= chunk.frames) return;
    void createImageBitmap(new Blob([f.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
      .then((bmp) => {
        if (this.ended || !this.chunks.includes(chunk)) { bmp.close(); return; }
        chunk.bitmaps[f.index] = bmp;
      })
      .catch(() => { /* one undecodable frame: the previous one stays up */ });
  }

  private ensureDrawing() {
    if (!this.raf) this.raf = requestAnimationFrame(this.draw);
  }

  private draw = () => {
    this.raf = 0;
    if (this.ended) return;
    const t = this.ctx.currentTime;
    // Chunks whose time is over are released (their bitmaps hold GPU memory).
    while (this.chunks.length) {
      const c = this.chunks[0];
      if (c.start === null || t < c.start + c.frames / c.fps) break;
      this.dropChunk(this.chunks.shift()!);
    }
    const due = dueFrame(this.chunks, t);
    if (due && canvas) {
      const c = this.chunks[due.chunk];
      // A frame still decoding: show the newest earlier one of the chunk instead.
      let i = due.frame;
      while (i >= 0 && !c.bitmaps[i]) i--;
      const key = `${c.start}:${i}`;
      if (i >= 0 && key !== this.lastDrawn) {
        const bmp = c.bitmaps[i]!;
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
        canvas.getContext('2d')?.drawImage(bmp, 0, 0);
        this.lastDrawn = key;
        if (!useAvatarCall.getState().videoLive) useAvatarCall.setState({ videoLive: true });
      }
    }
    if (this.chunks.length || this.pendingChunk) this.ensureDrawing();
  };

  private dropChunk(c: VideoChunk) {
    for (const b of c.bitmaps) b?.close();
    c.bitmaps = [];
  }

  private clearVideo() {
    for (const c of this.chunks) this.dropChunk(c);
    this.chunks = [];
    this.pendingChunk = null;
  }

  mute(on: boolean) {
    if (this.mic) this.mic.muted = on;
    this.sendRaw(JSON.stringify({ type: 'mute', on }));
    setV({ muted: on, listening: on ? false : useVoice.getState().listening });
  }

  private handle(ev: ServerFrame) {
    switch (ev.type) {
      case 'ready':
        this.ready = true;
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
        if (ev.ttsSampleRate && ev.ttsSampleRate > 0) this.ttsRate = ev.ttsSampleRate;
        if (typeof ev.hasAvatar === 'boolean') useAvatarCall.setState({ hasAvatar: ev.hasAvatar });
        setV({ status: 'live', startedAt: Date.now() });
        return;
      case 'listening':
        setV({ listening: !!ev.on });
        return;
      case 'transcript':
        if (ev.text?.trim()) this.caption('user', ev.text.trim());
        return;
      case 'reply':
        if (ev.text?.trim()) this.caption('assistant', ev.text.trim());
        return;
      case 'thinking':
        setV({ thinking: true, listening: false });
        return;
      case 'speaking':
        if (ev.on) setV({ speaking: true, thinking: false, listening: false });
        else setV({ speaking: this.player.playing });
        return;
      case 'avatar': {
        const frames = Number(ev.frames), fps = Number(ev.fps);
        if (frames > 0 && fps > 0) this.pendingChunk = { frames, fps, start: null, bitmaps: [] };
        return;
      }
      case 'barge-in':
        // The person talked over the bot: nothing queued may keep playing or moving.
        this.player.clear();
        this.clearVideo();
        setV({ speaking: false, listening: true });
        return;
      case 'done':
        setV({ thinking: false, speaking: this.player.playing });
        return;
      case 'error':
        this.end(ev.message || 'GPU voice error');
        return;
      case 'end':
        this.end();
        return;
    }
  }

  private caption(role: Caption['role'], text: string) {
    const caps = useVoice.getState().captions;
    setV({ captions: [...caps, { id: `gpu-${++this.captionSeq}`, role, text, final: true }].slice(-200) });
  }

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('pagehide', this.onUnload);
    window.removeEventListener('beforeunload', this.onUnload);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (!error) this.sendRaw(JSON.stringify({ type: 'end' }));
    try { this.ws?.close(1000, 'call ended'); } catch { /* already gone */ }
    this.ws = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clearVideo();
    this.mic?.stop();
    this.player.dispose();
    void this.ctx.close().catch(() => {});
    void this.captureCtx.close().catch(() => {});
    if (current === this) current = null;
    useAvatarCall.setState({ hasAvatar: false, videoLive: false });
    if (error) {
      setV({ status: 'error', error, speaking: false, listening: false, thinking: false, working: [] });
      setTimeout(() => { if (useVoice.getState().status === 'error' && !current) setV({ status: 'idle', botId: null, error: null }); }, 6000);
    } else {
      setV({ status: 'idle', botId: null, callId: null, speaking: false, listening: false, thinking: false, working: [], startedAt: null });
    }
  }
}

/** Start a GPU call. Must be called from a user gesture (click) so audio can start. */
export function startAudiocppCall(botId: string) {
  if (current && !current.ended) {
    if (current.botId === botId) return;
    current.end();
  }
  current = new AudiocppCall(botId);
  void current.start();
}

export function endAudiocppCall() { current?.end(); }
export function isAudiocppCallActive() { return !!current && !current.ended; }
export function setAudiocppMuted(on: boolean) { current?.mute(on); }
export function audiocppLevels(): { out: number; mic: number } {
  const c = current;
  if (!c || c.ended) return { out: 0, mic: 0 };
  return { out: c.player.level(), mic: c.micLevel() };
}
