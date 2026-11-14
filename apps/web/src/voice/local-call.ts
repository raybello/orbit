// On-device voice calls: mic → 16 kHz PCM16 over a WebSocket to the local STT/TTS session, replies
// come back as PCM16 at the rate the server reports (Piper lessac-medium: 22 050 Hz).
//
// Contract: docs/voice-local-conventions.md, "Phase 2 addendum". Wire shape:
//   POST /api/voice/local/session { botId } -> { callId, sampleRate, ttsSampleRate }
//   WS   /api/voice/local/call/:callId       binary PCM16 16 kHz in, PCM16 out + JSON control frames
// Client → server text: {type:'mute', on}, {type:'end'}.
// Server → client text: ready, transcript{text,final}, thinking, speaking{on}, done, error, end.
//
// This module drives the same `useVoice` store as the cloud VoiceCall so the call bar, captions and
// mute button work unchanged.
import type { Caption } from './call';
import { useVoice } from './call';
import { LOCAL_TTS_RATE, startLocalSession } from './api';
import { MicCapture, PcmPlayer, createAudioContext, micErrorMessage, openMic } from './audio';
import { LOCAL_IN_RATE, StreamResampler, toPcm16 } from './resample';

// The pure resampler helpers live in resample.ts so they can be unit-tested without a browser;
// re-exported here because this is the module the call path owns.
export { LOCAL_IN_RATE, StreamResampler, resampleTo16k, toPcm16 } from './resample';

const WS_PATH = '/api/voice/local/call';
const CONNECT_TIMEOUT_MS = 15000;

const setV = (p: Partial<ReturnType<typeof useVoice.getState>>) => useVoice.setState(p);

type ServerFrame =
  | { type: 'ready'; ttsSampleRate?: number }
  | { type: 'transcript'; text?: string; final?: boolean }
  | { type: 'thinking' }
  | { type: 'speaking'; on?: boolean }
  | { type: 'done' }
  | { type: 'error'; message?: string }
  | { type: 'end' };

let current: LocalCall | null = null;

class LocalCall {
  ended = false;
  readonly ctx: AudioContext;
  readonly player: PcmPlayer;
  private mic: MicCapture | null = null;
  private ws: WebSocket | null = null;
  private ready = false;
  /** Server's reply rate; the session values are a fallback until `ready` lands. */
  private ttsRate = LOCAL_TTS_RATE;
  private readonly resampler = new StreamResampler();
  /** Capture context, deliberately 16 kHz; `this.ctx` stays at the device rate for playback. */
  private readonly captureCtx: AudioContext;
  /** The open (non-final) user caption, replaced in place until the transcript is final. */
  private userCaptionId: string | null = null;
  private captionSeq = 0;
  /** True between the first partial of an utterance and its final — drives barge-in. */
  private userSpeaking = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private onUnload = () => this.end();

  constructor(readonly botId: string) {
    // Created synchronously inside the click so autoplay policy lets it run.
    this.ctx = createAudioContext();
    this.player = new PcmPlayer(this.ctx);
    // Capture runs on its own 16 kHz context: the browser resamples the device once, at full
    // quality, and the worklet then hands us 16 kHz frames with nothing left to interpolate.
    this.captureCtx = createAudioContext(LOCAL_IN_RATE);
    // The server drives speaking via its own frames; the player only reports when audio drains.
    this.player.onIdle = () => setV({ speaking: false });
  }

  micLevel() {
    return useVoice.getState().muted ? 0 : this.mic?.level ?? 0;
  }

  async start() {
    setV({ status: 'connecting', botId: this.botId, callId: null, muted: false, speaking: false, listening: false, thinking: false, working: [], captions: [], error: null, startedAt: null });
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
      const sess = await startLocalSession(this.botId);
      if (this.ended) return;
      if (Number.isFinite(sess.ttsSampleRate) && sess.ttsSampleRate > 0) this.ttsRate = sess.ttsSampleRate;
      setV({ callId: sess.callId });
      this.connect(sess.callId);
    } catch (e) {
      this.end((e as Error).message || 'Could not start the call');
    }
  }

  private connect(callId: string) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}/${encodeURIComponent(callId)}`);
    ws.binaryType = 'arraybuffer'; // cookies ride along on the upgrade; no token needed
    this.ws = ws;
    this.connectTimer = setTimeout(() => { if (!this.ready) this.end('Couldn’t connect the call'); }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ended) return;
      // A mute toggled before the socket opened was never sent; the mic is already silent, tell the session.
      if (useVoice.getState().muted) this.sendRaw(JSON.stringify({ type: 'mute', on: true }));
    };
    ws.onmessage = (m: MessageEvent<string | ArrayBuffer | Blob>) => {
      if (this.ended) return;
      if (typeof m.data === 'string') {
        try { this.handle(JSON.parse(m.data) as ServerFrame); } catch (e) { console.warn('[voice] bad local event', e); }
        return;
      }
      if (m.data instanceof ArrayBuffer) { this.play(m.data); return; }
      if (m.data instanceof Blob) void m.data.arrayBuffer().then((b) => { if (!this.ended) this.play(b); }).catch(() => {});
    };
    ws.onclose = () => {
      if (this.ended) return;
      this.end(this.ready ? 'Call dropped' : 'Couldn’t connect the call');
    };
    ws.onerror = () => {
      if (this.ended) return;
      this.end(this.ready ? 'Call dropped' : 'Couldn’t connect the call');
    };
  }

  private sendRaw(data: string | ArrayBuffer) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(data); } catch (e) { console.warn('[voice] local send failed', e); }
  }

  /** MicCapture hands back PCM16 at 24 kHz in ~40 ms frames; the session wants 16 kHz mono. */
  private sendAudio(frame: Int16Array) {
    if (this.ended || !frame.length) return;
    if (useVoice.getState().muted) return; // mute drops frames entirely
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const f = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) f[i] = frame[i] / 0x8000;
    const pcm = toPcm16(this.resampler.process(f, LOCAL_IN_RATE));
    if (pcm.length) this.sendRaw(pcm.buffer as ArrayBuffer);
  }

  private play(buf: ArrayBuffer) {
    const pcm = new Int16Array(buf, 0, buf.byteLength >> 1);
    if (!pcm.length) return;
    this.player.push(pcm, this.ttsRate);
  }

  mute(on: boolean) {
    if (this.mic) this.mic.muted = on;
    this.sendRaw(JSON.stringify({ type: 'mute', on }));
    setV({ muted: on, listening: on ? false : useVoice.getState().listening });
  }

  // ---------- server frames ----------

  private handle(ev: ServerFrame) {
    switch (ev.type) {
      case 'ready':
        this.ready = true;
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
        if (ev.ttsSampleRate && ev.ttsSampleRate > 0) this.ttsRate = ev.ttsSampleRate;
        setV({ status: 'live', startedAt: Date.now() });
        return;

      case 'transcript':
        this.transcript(ev.text ?? '', !!ev.final);
        return;

      case 'thinking':
        setV({ thinking: true, listening: false });
        return;

      case 'speaking':
        // Audio may still be buffered locally when the server says it stopped; trust the player then.
        if (ev.on) setV({ speaking: true, thinking: false, listening: false });
        else setV({ speaking: this.player.playing });
        return;

      case 'done':
        setV({ thinking: false, speaking: this.player.playing });
        return;

      case 'error':
        this.end(ev.message || 'Voice service error');
        return;

      case 'end':
        this.end();
        return;
    }
  }

  /**
   * Partial transcripts carry the whole utterance so far, so they replace the open caption; the final
   * one settles it. A new partial while the bot is talking is barge-in: drop the queued reply audio.
   */
  private transcript(text: string, final: boolean) {
    const t = text.trim();
    if (!final) {
      const id = (this.userCaptionId ??= `local-${++this.captionSeq}`);
      this.caption(id, t, false);
      if (t) {
        if (!this.userSpeaking) {
          this.userSpeaking = true;
          if (this.player.playing) this.player.clear();
        }
        setV({ listening: true });
      }
      return;
    }
    const id = this.userCaptionId ?? `local-${++this.captionSeq}`;
    this.userCaptionId = null;
    this.userSpeaking = false;
    const known = useVoice.getState().captions.some((c) => c.id === id);
    if (t || known) this.caption(id, t, true);
    setV({ listening: false });
  }

  private caption(id: string, text: string, final: boolean) {
    const caps = useVoice.getState().captions;
    const i = caps.findIndex((c) => c.id === id);
    const role: Caption['role'] = 'user';
    if (i < 0) {
      setV({ captions: [...caps, { id, role, text, final }].slice(-200) });
      return;
    }
    const prev = caps[i];
    const copy = caps.slice();
    copy[i] = { ...prev, text: text || prev.text, final: final || prev.final };
    setV({ captions: copy });
  }

  // ---------- teardown ----------

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('pagehide', this.onUnload);
    window.removeEventListener('beforeunload', this.onUnload);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    // Tell the session to hang up before the socket goes; a close alone also ends it server-side.
    if (!error) this.sendRaw(JSON.stringify({ type: 'end' }));
    try { this.ws?.close(1000, 'call ended'); } catch { /* already gone */ }
    this.ws = null;
    this.mic?.stop();
    this.player.dispose();
    void this.ctx.close().catch(() => {});
    void this.captureCtx.close().catch(() => {});
    if (current === this) current = null;
    if (error) {
      setV({ status: 'error', error, speaking: false, listening: false, thinking: false, working: [] });
      setTimeout(() => { if (useVoice.getState().status === 'error' && !current) setV({ status: 'idle', botId: null, error: null }); }, 6000);
    } else {
      setV({ status: 'idle', botId: null, callId: null, speaking: false, listening: false, thinking: false, working: [], startedAt: null });
    }
  }
}

/** Start an on-device call. Must be called from a user gesture (click) so audio can start. */
export function startLocalCall(botId: string) {
  if (current && !current.ended) {
    if (current.botId === botId) return;
    current.end();
  }
  current = new LocalCall(botId);
  void current.start();
}

export function endLocalCall() { current?.end(); }

export function isLocalCallActive() { return !!current && !current.ended; }

export function setLocalMuted(on: boolean) { current?.mute(on); }

/** Mirrors `callLevels()` in call.ts so the call bar animates for local calls too. */
export function localLevels(): { out: number; mic: number } {
  const c = current;
  if (!c || c.ended) return { out: 0, mic: 0 };
  return { out: c.player.level(), mic: c.micLevel() };
}
