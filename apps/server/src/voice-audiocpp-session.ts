/**
 * A GPU voice call through audio.cpp: microphone → VAD gate → OWSM ASR → the bot's agent (Hermes) →
 * LFM3-Audio speech, with SoulX-FlashHead lip-synced portrait video when the bot has one.
 *
 * Same shape as voice-local-session.ts (call ids minted by POST /session, claimed by the WebSocket
 * upgrade, auth from the session cookie), with three differences:
 *
 * - Recognition is offline (OWSM): an utterance is gated by an energy VAD here and transcribed whole
 *   when it ends, so there are no partial captions.
 * - Replies are 24 kHz (LFM3-Audio), not Piper's 22 050 Hz.
 * - Binary frames to the browser are typed by their first byte:
 *     0x01 + PCM16 LE mono at `ttsSampleRate`             reply audio
 *     0x02 + u16 LE frame index + JPEG                    one avatar frame
 *   Avatar video comes from audio.cpp's `speaking-avatar` recipe, which feeds speech into SoulX while
 *   it is still being generated. Audio is the clock: for every video chunk (N frames at F fps) the
 *   session sends a JSON `{type:'avatar', frames, fps, width, height}`, then exactly N/F seconds of
 *   the reply audio as one 0x01 frame, then the chunk's N JPEG frames. The browser starts the chunk's
 *   frames when that audio starts playing, so lips stay on the words however the GPU's pace varies.
 *
 * Client → server: binary PCM16 LE mono 16 kHz; text {type:'mute', on}, {type:'end'}.
 * Server → client text: ready, listening{on}, transcript{text,final}, reply{text}, thinking,
 * speaking{on}, avatar, barge-in, done, error{message}, end.
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { userFromCookieHeader, userFromToken } from './lib/auth.js';
import { getBotRow } from './store.js';
import { defaultRelay } from './voice-local-session.js';
import * as audiocpp from './voice-audiocpp.js';

/** Audio the client sends: 16 kHz mono PCM16, the rate OWSM listens at. */
export const AUDIOCPP_CALL_SAMPLE_RATE = audiocpp.AUDIOCPP_ASR_RATE;
export const AUDIOCPP_CALL_TTS_RATE = audiocpp.AUDIOCPP_TTS_RATE;

export const FRAME_AUDIO = 0x01;
export const FRAME_VIDEO = 0x02;

/** VAD window: 32 ms at 16 kHz. */
const WINDOW = 512;
const WINDOW_MS = (WINDOW / AUDIOCPP_CALL_SAMPLE_RATE) * 1000;
/** Audio kept from before the VAD fires, so the first syllable is not clipped. */
const PREROLL_MS = 400;
/** Windows above the speech threshold, in a row, that start an utterance (~96 ms). */
const ONSET_WINDOWS = 3;
/** Windows that must be loud over the bot's own voice to count as barge-in (~190 ms). */
const BARGE_WINDOWS = 6;
/** Silence that ends an utterance. OWSM is offline, so this is the whole endpointing latency. */
const END_SILENCE_MS = 700;
/** Utterances shorter than this much speech are coughs and clicks, not turns. */
const MIN_SPEECH_MS = 250;
/** An utterance is cut (and transcribed) at this length even if the caller keeps talking. */
const MAX_UTTERANCE_MS = 25_000;
/** Speech threshold floor and multiple of the tracked noise floor (RMS in [-1, 1]). */
const MIN_SPEECH_RMS = 0.012;
const NOISE_MULTIPLE = 3.5;

const FILLER_TEXT = 'One moment.';
const TIMEOUT_TEXT = "That's taking too long. I'll message you the answer.";
const FILLER_DELAY_MS = 1200;
const TURN_DEADLINE_MS = 90_000;
/** Spoken replies are capped: a phone call is not the place to read out a report. */
const MAX_REPLY_CHARS = 1200;
const UNCLAIMED_TTL_MS = 5 * 60_000;
const JPEG_QUALITY = 78;

export type AudiocppCallEvent =
  | { type: 'ready'; ttsSampleRate: number; hasAvatar: boolean; voice: string }
  | { type: 'listening'; on: boolean }
  | { type: 'transcript'; text: string; final: boolean }
  /** What the bot is about to say (its caption), sent before the reply's audio. */
  | { type: 'reply'; text: string }
  | { type: 'thinking' }
  | { type: 'speaking'; on: boolean }
  | { type: 'avatar'; frames: number; fps: number; width: number; height: number }
  | { type: 'barge-in' }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'end' };

export interface AudiocppCallDeps {
  relay?: (text: string) => Promise<string>;
  transcribe?: (pcm: Int16Array, rate: number) => Promise<string>;
  speech?: (text: string, signal: AbortSignal) => AsyncIterable<{ pcm: Int16Array; rate: number }>;
  avatar?: (text: string, signal: AbortSignal) => AsyncIterable<audiocpp.AvatarStreamItem>;
  /** RGB24 frame → JPEG. Injected in tests so they need no native image library. */
  encodeFrame?: (rgb: Buffer, width: number, height: number) => Promise<Buffer>;
  onEvent?: (e: AudiocppCallEvent) => void;
  onBinary?: (frame: Buffer) => void;
}

export interface AudiocppCallOptions {
  fillerDelayMs?: number;
  relayTimeoutMs?: number;
  endSilenceMs?: number;
}

interface Transport {
  event(e: AudiocppCallEvent): void;
  binary(frame: Buffer): void;
}

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).slice(0, 300);

function rms(pcm: Int16Array): number {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += (pcm[i] / 32768) ** 2;
  return pcm.length ? Math.sqrt(s / pcm.length) : 0;
}

/** Reply text made speakable: no markdown, links or code; capped at a sentence boundary. */
export function speakableText(text: string): string {
  let t = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^[\s>#*\-+]+|[*_~#>|]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > MAX_REPLY_CHARS) {
    const cut = t.slice(0, MAX_REPLY_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = end > 200 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
  }
  return t;
}

/** OWSM marks non-speech with tags like `<nospeech>`; those are not words. */
export function cleanTranscript(text: string): string {
  return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

type Sharp = typeof import('sharp');
let sharpMod: Promise<Sharp> | null = null;
/**
 * Loaded on first use, so a host where the native module cannot load still serves everything else.
 * sharp is CommonJS (`export =`): the callable arrives as `default` at runtime under ESM.
 */
export function loadSharp(): Promise<Sharp> {
  return (sharpMod ??= import('sharp').then((m) => (m as unknown as { default?: Sharp }).default ?? (m as unknown as Sharp)));
}
async function jpegFrame(rgb: Buffer, width: number, height: number): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

function concat(parts: Int16Array[], n: number): Int16Array {
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const binders = new WeakMap<AudiocppCallSession, (t: Transport | null) => void>();
const created = new WeakMap<AudiocppCallSession, number>();

export class AudiocppCallSession {
  readonly callId: string;
  readonly botId: string;
  readonly voice: string;
  /** Server-local portrait path (in the audio.cpp server's filesystem), or null for audio only. */
  readonly portraitPath: string | null;
  private readonly language: string;
  private readonly deps: AudiocppCallDeps;
  private readonly options: Required<AudiocppCallOptions>;
  private transport: Transport | null = null;

  private closed = false;
  private muted = false;

  // input
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private preroll: Int16Array[] = [];
  private noiseFloor = 0.004;
  private loudRun = 0;
  private utterance: { chunks: Int16Array[]; samples: number; speechMs: number; silentMs: number } | null = null;

  // output
  private turnGen = 0;
  private speakAbort: AbortController | null = null;
  /** True while a reply stream is open or the browser is still playing what was sent. */
  private speaking = false;
  /** Wall-clock ms when the audio already sent will have finished playing in the browser. */
  private playbackEnd = 0;
  private wakers = new Set<() => void>();

  constructor(opts: {
    callId: string;
    botId: string;
    voice: string;
    portraitPath?: string | null;
    language?: string;
    deps?: AudiocppCallDeps;
    options?: AudiocppCallOptions;
  }) {
    this.callId = opts.callId;
    this.botId = opts.botId;
    this.voice = opts.voice;
    this.portraitPath = opts.portraitPath ?? null;
    this.language = opts.language ?? 'auto';
    this.deps = opts.deps ?? {};
    this.options = {
      fillerDelayMs: FILLER_DELAY_MS,
      relayTimeoutMs: TURN_DEADLINE_MS,
      endSilenceMs: END_SILENCE_MS,
      ...opts.options,
    };
    created.set(this, Date.now());
    binders.set(this, (t) => {
      this.transport = t;
      if (t) t.event(this.readyEvent());
    });
    this.emit(this.readyEvent());
  }

  get hasAvatar(): boolean {
    return !!this.portraitPath;
  }

  private readyEvent(): AudiocppCallEvent {
    return { type: 'ready', ttsSampleRate: AUDIOCPP_CALL_TTS_RATE, hasAvatar: this.hasAvatar, voice: this.voice };
  }

  /** 16 kHz mono PCM16, any chunk size. */
  accept(chunk: Int16Array): void {
    if (this.closed || this.muted || !chunk?.length) return;
    this.pending.push(chunk);
    this.pendingSamples += chunk.length;
    while (this.pendingSamples >= WINDOW) this.onWindow(this.takeWindow());
  }

  setMuted(on: boolean): void {
    if (this.closed) return;
    this.muted = !!on;
    if (this.muted) {
      this.pending = [];
      this.pendingSamples = 0;
      this.preroll = [];
      this.loudRun = 0;
      if (this.utterance) {
        this.utterance = null;
        this.emit({ type: 'listening', on: false });
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turnGen++;
    this.speakAbort?.abort();
    this.wakeAll();
    if (this.speaking) {
      this.speaking = false;
      this.emit({ type: 'speaking', on: false });
    }
    this.utterance = null;
    this.pending = [];
    this.preroll = [];
    sessions.delete(this.callId);
    this.emit({ type: 'end' });
    this.transport = null;
  }

  // ---------- input: energy VAD ----------

  private takeWindow(): Int16Array {
    const out = new Int16Array(WINDOW);
    let filled = 0;
    while (filled < WINDOW) {
      const head = this.pending[0];
      const need = WINDOW - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.pending.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.pending[0] = head.subarray(need);
        filled = WINDOW;
      }
    }
    this.pendingSamples -= WINDOW;
    return out;
  }

  /** The bot is audible: its stream is open, or the browser has not finished playing it. */
  private get botAudible(): boolean {
    return this.speaking || Date.now() < this.playbackEnd;
  }

  private onWindow(window: Int16Array): void {
    const level = rms(window);
    const threshold = Math.max(MIN_SPEECH_RMS, this.noiseFloor * NOISE_MULTIPLE);
    const loud = level > threshold;

    if (this.utterance) {
      const u = this.utterance;
      u.chunks.push(window);
      u.samples += window.length;
      if (loud) {
        u.speechMs += WINDOW_MS;
        u.silentMs = 0;
      } else u.silentMs += WINDOW_MS;
      const totalMs = (u.samples / AUDIOCPP_CALL_SAMPLE_RATE) * 1000;
      if (u.silentMs >= this.options.endSilenceMs || totalMs >= MAX_UTTERANCE_MS) this.finishUtterance();
      return;
    }

    // Not in an utterance: track the room's noise floor from quiet windows only.
    if (!loud) this.noiseFloor = this.noiseFloor * 0.95 + Math.min(level, 0.05) * 0.05;
    this.preroll.push(window);
    while (this.preroll.length * WINDOW_MS > PREROLL_MS) this.preroll.shift();

    // Over the bot's own voice (echo cancellation leaves some), speech has to be louder and longer.
    const audible = this.botAudible;
    const needed = audible ? BARGE_WINDOWS : ONSET_WINDOWS;
    const hot = audible ? level > threshold * 1.6 : loud;
    this.loudRun = hot ? this.loudRun + 1 : 0;
    if (this.loudRun < needed) return;
    this.loudRun = 0;
    if (audible) this.bargeIn();
    this.utterance = {
      chunks: this.preroll,
      samples: this.preroll.length * WINDOW,
      speechMs: needed * WINDOW_MS,
      silentMs: 0,
    };
    this.preroll = [];
    this.emit({ type: 'listening', on: true });
  }

  private finishUtterance(): void {
    const u = this.utterance;
    this.utterance = null;
    if (!u) return;
    this.emit({ type: 'listening', on: false });
    if (u.speechMs < MIN_SPEECH_MS) return;
    // Trim most of the trailing silence; OWSM needs a little, not 700 ms.
    const keep = Math.max(0, u.samples - Math.round(((u.silentMs - 200) / 1000) * AUDIOCPP_CALL_SAMPLE_RATE));
    const pcm = concat(u.chunks, u.samples).subarray(0, keep);
    void this.recognize(pcm);
  }

  private async recognize(pcm: Int16Array): Promise<void> {
    const gen = ++this.turnGen; // a new turn: whatever the last one was waiting on is over
    this.speakAbort?.abort();
    this.wakeAll();
    this.setSpeaking(false);
    this.emit({ type: 'thinking' });
    let text: string;
    try {
      text = cleanTranscript(
        this.deps.transcribe
          ? await this.deps.transcribe(pcm, AUDIOCPP_CALL_SAMPLE_RATE)
          : (await audiocpp.transcribe(pcm, AUDIOCPP_CALL_SAMPLE_RATE, { language: this.language })).text,
      );
    } catch (e) {
      if (this.closed || gen !== this.turnGen) return;
      this.emit({ type: 'error', message: `speech recognition failed: ${errText(e)}` });
      this.close();
      return;
    }
    if (this.closed || gen !== this.turnGen) return;
    if (!text) {
      this.emit({ type: 'done' });
      return;
    }
    this.emit({ type: 'transcript', text, final: true });
    await this.respond(text, gen);
  }

  // ---------- turn ----------

  private async respond(text: string, gen: number): Promise<void> {
    let settled = false;
    const relayed = (this.deps.relay ? this.deps.relay(text) : defaultRelay(this.botId, this.callId, text)).then(
      (reply) => ({ ok: true as const, reply }),
      (error) => ({ ok: false as const, error }),
    );
    const deadline = new Promise<{ ok: 'timeout' }>((resolve) => {
      const t = setTimeout(() => resolve({ ok: 'timeout' }), this.options.relayTimeoutMs);
      t.unref?.();
      void relayed.finally(() => clearTimeout(t));
    });
    // A quick answer is spoken instead of the filler; a slow one gets "One moment." first.
    const filler = (async () => {
      await this.sleep(this.options.fillerDelayMs);
      if (settled || this.closed || gen !== this.turnGen) return;
      await this.speak(FILLER_TEXT, gen, { audioOnly: true, keepSpeaking: true });
    })();
    const outcome = await Promise.race([relayed, deadline]);
    settled = true;
    this.wakeAll(); // a filler still waiting out its delay is not needed any more
    if (this.closed || gen !== this.turnGen) return;
    await filler;
    if (this.closed || gen !== this.turnGen) return;

    if (outcome.ok === 'timeout') {
      await this.speak(TIMEOUT_TEXT, gen, { audioOnly: true });
      if (!this.closed && gen === this.turnGen) this.emit({ type: 'done' });
      return;
    }
    if (!outcome.ok) {
      this.emit({ type: 'error', message: `relay failed: ${errText(outcome.error)}` });
      this.close();
      return;
    }
    const reply = speakableText(outcome.reply);
    if (!reply) {
      this.emit({ type: 'error', message: 'the bot did not answer' });
      this.close();
      return;
    }
    this.emit({ type: 'reply', text: reply });
    await this.speak(reply, gen);
    if (!this.closed && gen === this.turnGen) this.emit({ type: 'done' });
  }

  /**
   * Speak one reply: with the portrait when there is one, audio only otherwise (and for cues). An
   * avatar failure before any audio went out retries audio-only, so a broken portrait never costs
   * the caller the answer. Resolves once the browser has finished playing it (or barge-in).
   */
  private async speak(text: string, gen: number, opts: { audioOnly?: boolean; keepSpeaking?: boolean } = {}): Promise<void> {
    const abort = new AbortController();
    this.speakAbort = abort;
    this.setSpeaking(true);
    const progress = { sent: false };
    try {
      if (this.portraitPath && !opts.audioOnly) {
        try {
          await this.speakWithAvatar(text, gen, abort.signal, progress);
        } catch (e) {
          if (abort.signal.aborted || this.closed || gen !== this.turnGen) return;
          console.warn('[voice] audiocpp avatar failed, speaking without it:', errText(e));
          // Half a reply already played: retrying would repeat it. Otherwise say it without video.
          if (!progress.sent) await this.speakAudio(text, gen, abort.signal);
        }
      } else {
        await this.speakAudio(text, gen, abort.signal);
      }
      // Hold `speaking` until the browser has played what it was sent, so barge-in still works.
      while (!this.closed && gen === this.turnGen && Date.now() < this.playbackEnd) {
        await this.sleep(Math.min(250, this.playbackEnd - Date.now()));
      }
    } catch (e) {
      if (!abort.signal.aborted && !this.closed && gen === this.turnGen) {
        this.emit({ type: 'error', message: `speech failed: ${errText(e)}` });
        this.close();
      }
    } finally {
      if (this.speakAbort === abort) this.speakAbort = null;
      if (!opts.keepSpeaking && !this.closed && gen === this.turnGen) this.setSpeaking(false);
    }
  }

  private async speakAudio(text: string, gen: number, signal: AbortSignal): Promise<void> {
    const stream = this.deps.speech ? this.deps.speech(text, signal) : audiocpp.streamSpeech(text, this.voice, signal);
    for await (const chunk of stream) {
      if (this.closed || gen !== this.turnGen) return;
      this.sendAudio(chunk.pcm, chunk.rate);
    }
  }

  /** `progress.sent` records whether any audio reached the browser (then a failure cannot be retried). */
  private async speakWithAvatar(text: string, gen: number, signal: AbortSignal, progress: { sent: boolean }): Promise<void> {
    const stream = this.deps.avatar
      ? this.deps.avatar(text, signal)
      : audiocpp.streamSpeakingAvatar(text, this.voice, this.portraitPath!, signal);
    const encode = this.deps.encodeFrame ?? jpegFrame;
    let audio: Int16Array[] = [];
    let buffered = 0;
    let rate = AUDIOCPP_CALL_TTS_RATE;
    const take = (n: number): Int16Array => {
      const count = Math.min(n, buffered);
      const out = new Int16Array(count);
      let o = 0;
      while (o < count) {
        const head = audio[0];
        const k = Math.min(count - o, head.length);
        out.set(head.subarray(0, k), o);
        o += k;
        if (k === head.length) audio.shift();
        else audio[0] = head.subarray(k);
      }
      buffered -= count;
      return out;
    };
    try {
      for await (const item of stream) {
        if (this.closed || gen !== this.turnGen) return;
        if (item.kind === 'audio') {
          rate = item.rate;
          audio.push(item.pcm);
          buffered += item.pcm.length;
          continue;
        }
        const { frames, fps, width, height, rgb } = item;
        // Encode before sending anything, so the chunk's audio and its frames leave together.
        const size = width * height * 3;
        const jpegs = await Promise.all(Array.from({ length: frames }, (_, i) => encode(rgb.subarray(i * size, (i + 1) * size), width, height)));
        if (this.closed || gen !== this.turnGen) return;
        this.emit({ type: 'avatar', frames, fps, width, height });
        this.sendAudio(take(Math.round((frames / fps) * rate)), rate);
        progress.sent = true;
        jpegs.forEach((jpeg, i) => {
          const head = Buffer.alloc(3);
          head[0] = FRAME_VIDEO;
          head.writeUInt16LE(i, 1);
          this.sendBinary(Buffer.concat([head, jpeg]));
        });
      }
    } finally {
      // Speech beyond the last video chunk (or every sample, if the avatar failed) still gets heard.
      if (buffered && !this.closed && gen === this.turnGen) {
        this.sendAudio(take(buffered), rate);
        progress.sent = true;
      }
      audio = [];
    }
  }

  private bargeIn(): void {
    this.turnGen++;
    this.speakAbort?.abort();
    this.playbackEnd = 0;
    this.wakeAll();
    this.emit({ type: 'barge-in' });
    this.setSpeaking(false);
  }

  private setSpeaking(on: boolean): void {
    if (this.speaking === on) return;
    this.speaking = on;
    this.emit({ type: 'speaking', on });
  }

  // ---------- out ----------

  private sendAudio(pcm: Int16Array, rate: number): void {
    if (!pcm.length) return;
    const now = Date.now();
    this.playbackEnd = Math.max(now, this.playbackEnd) + (pcm.length / rate) * 1000;
    const frame = Buffer.alloc(1 + pcm.byteLength);
    frame[0] = FRAME_AUDIO;
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(frame, 1);
    this.sendBinary(frame);
  }

  private sendBinary(frame: Buffer): void {
    try {
      this.deps.onBinary?.(frame);
    } catch {}
    try {
      this.transport?.binary(frame);
    } catch {}
  }

  private emit(e: AudiocppCallEvent): void {
    try {
      this.deps.onEvent?.(e);
    } catch {}
    try {
      this.transport?.event(e);
    } catch {}
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wakers.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      this.wakers.add(finish);
    });
  }

  private wakeAll(): void {
    for (const w of [...this.wakers]) w();
  }
}

// ---------- the registry of call ids ----------

const sessions = new Map<string, AudiocppCallSession>();

function sweep() {
  const now = Date.now();
  for (const [callId, session] of sessions) {
    if (now - (created.get(session) ?? 0) < UNCLAIMED_TTL_MS) continue;
    sessions.delete(callId);
    session.close();
  }
}
setInterval(sweep, 60_000).unref();

export function createAudiocppCall(
  callId: string,
  botId: string,
  opts: { voice: string; portraitPath?: string | null; language?: string },
): AudiocppCallSession {
  sweep();
  const session = new AudiocppCallSession({ callId, botId, ...opts });
  sessions.set(callId, session);
  return session;
}

export function takeAudiocppCall(callId: string): AudiocppCallSession | undefined {
  sweep();
  const session = sessions.get(callId);
  if (session) sessions.delete(callId);
  return session;
}

export function pendingAudiocppCalls(): number {
  return sessions.size;
}

// ---------- the WebSocket relay ----------

function pcm16From(buf: Buffer): Int16Array {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** WebSocket relay for /api/voice/audiocpp/call/:callId; same upgrade rules as the local call relay. */
export function attachAudiocppCallRelay(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/voice\/audiocpp\/call\/([^/]+)$/);
    if (!m) return;
    const refuse = (status: string) => {
      try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch {}
      socket.destroy();
    };
    const user = userFromCookieHeader(req.headers.cookie) ?? userFromToken(url.searchParams.get('token') ?? undefined);
    if (!user) return refuse('401 Unauthorized');
    let callId: string;
    try {
      callId = decodeURIComponent(m[1]);
    } catch {
      return refuse('404 Not Found');
    }
    const session = takeAudiocppCall(callId);
    if (!session) return refuse('404 Not Found');
    const bot = getBotRow(session.botId);
    if (!bot || bot.user_id !== user.id) {
      session.close();
      return refuse('403 Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (client) => runCall(client, session));
  });
}

function runCall(client: WebSocket, session: AudiocppCallSession): void {
  const send = (data: string | Buffer) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  };
  binders.get(session)?.({ event: (e) => send(JSON.stringify(e)), binary: (frame) => send(frame) });
  client.on('message', (data: Buffer, isBinary: boolean) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
    if (isBinary) {
      session.accept(pcm16From(buf));
      return;
    }
    let msg: { type?: string; on?: boolean };
    try {
      msg = JSON.parse(buf.toString('utf8')) as { type?: string; on?: boolean };
    } catch {
      return;
    }
    if (msg?.type === 'mute') session.setMuted(!!msg.on);
    else if (msg?.type === 'end') {
      session.close();
      try {
        client.close(1000, 'ended');
      } catch {}
    }
  });
  const drop = () => {
    binders.get(session)?.(null);
    session.close();
  };
  client.on('close', drop);
  client.on('error', drop);
}
