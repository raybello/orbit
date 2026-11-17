/**
 * A local voice call: microphone → VAD → streaming STT → the bot's agent → streaming TTS → speaker.
 *
 * Same shape as the xAI realtime call in voice.ts, but every engine runs here on the CPU (see
 * docs/voice-local-conventions.md and voice-runtime.ts for why: provider 'cpu' is the fast path, and
 * CoreML segfaults Piper VITS). The caller -- the browser -- only captures 16 kHz PCM16 and plays
 * 22 050 Hz PCM16 back; the turn-taking, endpointing and barge-in all happen in this file so the
 * latency budget does not depend on the network round trip of a control frame.
 *
 * Measured on this machine (see the test file for the live numbers): STT partials 25–36 ms after a
 * window, TTS time-to-first-audio 118–194 ms per sentence, VAD ~4 ms per 32 ms window.
 *
 * The module also owns the WebSocket relay (`attachLocalCallRelay`), mirroring attachVncRelay in
 * vnc.ts: noServer upgrade handling, auth from the session cookie or `?token=`, a raw 401 write for
 * an unauthenticated socket, and a map of call ids that a POST /local/session puts into and the
 * upgrade path takes out of.
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { userFromCookieHeader, userFromToken } from './lib/auth.js';
import { getBotRow } from './store.js';
import { LEAD_PAD_S, floatToPcm16, getRecognizer, getVad, synthesize, ttsSampleRate } from './voice-runtime.js';
import type { Vad, OnlineRecognizer, OnlineStream } from 'sherpa-onnx-node';

/** Audio the client sends: 16 kHz mono PCM16 (the client resamples before it hits the wire). */
export const CALL_SAMPLE_RATE = 16000;
/** Piper en_US-lessac-medium reports 22 050 Hz; the server never resamples it. */
export const CALL_TTS_SAMPLE_RATE = 22050;

/** Silero VAD window: 32 ms at 16 kHz. */
const WINDOW = 512;
const WINDOW_MS = (WINDOW / CALL_SAMPLE_RATE) * 1000;
/** The recognizer's feature hop: 10 ms at 16 kHz. The onset search and the leading silence are both
 * cut on this grid, so the utterance audio sits on the same frame grid the batch path gives it. */
const ONSET_BLOCK = 160;
/** Partials are pushed at most this often; the recognizer itself is faster than a caption can read. */
const PARTIAL_MS = 100;
/** How much audio before the VAD's first positive we keep, so the onset of the first word survives
 * the detector's minSpeechDuration (0.25 s) delay. */
const PREROLL_MS = 1500;
/** Backstop endpoint: VAD silence this long ends an utterance even when the ASR never endpoints
 * (e.g. it emitted no tokens). The recognizer's own rule1 (0.8 s) normally fires first. */
const END_SILENCE_MS = 500;
/** Audio out: 100 ms frames at 22 050 Hz. Paced in real time so barge-in can actually stop it. */
const FRAME_MS = 100;
const FRAME_SAMPLES = Math.round((CALL_TTS_SAMPLE_RATE * FRAME_MS) / 1000); // 2 205 at 22 050 Hz
/** A sentence longer than this is cut at a word boundary before synthesis: Piper's prosody falls
 * apart on a 400-character "sentence", and the reply is meant to be spoken, not read. */
const MAX_SENTENCE_CHARS = 240;
/** An unclaimed call id (POST /session without a socket ever connecting) expires. */
const UNCLAIMED_TTL_MS = 5 * 60_000;
const RELAY_TIMEOUT_MS = 120_000;
const RELAY_POLL_MS = 150;

/**
 * Conversational behaviour while a slow agent works. Measured on this machine: Piper's first audio
 * for a two-word phrase lands 118–252 ms after the call, so a filler that starts this late is
 * audible well inside the second after the transcript.
 *
 * Said if the agent has not answered shortly after the transcript.
 */
const FILLER_TEXT = 'One moment.';
/** Said once if the agent is still working 20 s in. */
const PROGRESS_TEXT = 'Still working on that.';
/** Said at the hard deadline, after which the turn gives up and reports done. */
const TIMEOUT_TEXT = "That's taking too long — I'll message you the answer.";
/** The filler waits this long for the answer first: a reply faster than this never hears it, so a
 * quick turn is not slowed down by a needless synthesise-and-play. */
const FILLER_DELAY_MS = 400;
const PROGRESS_MS = 20_000;
/** Hard deadline for the agent, this long after the transcript. The default relay's own 120 s poll
 * is the backstop behind it for the process, not for the caller. */
const TURN_DEADLINE_MS = 90_000;

/**
 * Thresholds the tests drive directly, so the 20 s nudge and the 90 s deadline can be exercised in
 * seconds rather than minutes. Production uses the defaults above; nothing on the wire changes.
 */
export interface LocalCallOptions {
  /** Silence fed to the recognizer before an utterance's first speech block. Default 300 ms, the
   * same lead the batch path applies (LEAD_PAD_S in voice-runtime.ts). */
  leadPadMs?: number;
  /** RMS a 10 ms block must exceed to count as speech when locating the onset in the preroll ring.
   * Default 0.006: above a quiet room's floor (~0.002–0.004) and below the fixture's /s/ fricative
   * (0.009–0.019), which is the quietest part of real speech here. */
  speechRms?: number;
  fillerDelayMs?: number;
  progressMs?: number;
  relayTimeoutMs?: number;
}

export interface LocalCallDeps {
  /** Injected in tests: turns a final transcript into the bot's spoken reply. */
  relay?: (text: string) => Promise<string>;
  /**
   * Injected in tests. A synchronous `{ pcm, rate }` is honoured as-is, and so is a promise: the
   * production engine (voice-runtime.synthesize) is async, and callers must not have to lie about it.
   */
  synthesize?: (text: string, opts?: { model?: string }) => { pcm: Int16Array; rate: number } | Promise<{ pcm: Int16Array; rate: number }>;
  onEvent?: (e: LocalCallEvent) => void;
  /**
   * Binary frames are not control events: the 100 ms PCM16 frames that make up the bot's voice get
   * their own sink so they can go straight down a WebSocket as binary (see the frame table in
   * docs/voice-local-conventions.md).
   */
  onAudio?: (pcm: Int16Array, sampleRate: number) => void;
}

export type LocalCallEvent =
  | { type: 'ready'; ttsSampleRate: number; model?: string }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'thinking' }
  | { type: 'speaking'; on: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'end' };

/** What the socket does with the session's output. Set by attachLocalCallRelay, never by callers. */
interface Transport {
  event(e: LocalCallEvent): void;
  audio(pcm: Int16Array, sampleRate: number): void;
}

/**
 * The transport binding, kept in a WeakMap so the public class surface stays exactly the four
 * methods in the conventions doc: the relay is the only thing that needs it, and it lives here.
 */
const binders = new WeakMap<LocalCallSession, (t: Transport | null) => void>();
const created = new WeakMap<LocalCallSession, number>();

/** Wire a socket to a session; the relay is the only caller. */
function bindTransport(session: LocalCallSession, transport: Transport | null) {
  binders.get(session)?.(transport);
}

interface Utterance {
  stream: OnlineStream;
  /** Trailing VAD silence in this utterance, in ms. */
  silentMs: number;
  lastPartialAt: number;
  lastPartialText: string;
}

type RelayOutcome =
  | { kind: 'reply'; reply: string }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

function errText(e: unknown): string {
  return String((e as { message?: string })?.message ?? e).slice(0, 300);
}

/** RMS of float samples in [-1, 1]; a block of digital silence is exactly 0. */
function rmsOf(samples: Float32Array, from = 0, count = samples.length - from): number {
  let energy = 0;
  let n = 0;
  for (let i = from; i < Math.min(from + count, samples.length); i++) {
    energy += samples[i] * samples[i];
    n++;
  }
  return n ? Math.sqrt(energy / n) : 0;
}

/** Where the utterance starts in the preroll ring: the first 32 ms window above the speech floor,
 * then the first 10 ms block above it inside that window. */
interface Onset {
  window: number;
  /** Samples to skip at the start of that window (the quiet tail of it). */
  skip: number;
}

function findOnset(windows: Float32Array[], threshold: number): Onset | null {
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    if (rmsOf(window) <= threshold) continue;
    for (let skip = 0; skip + ONSET_BLOCK <= window.length; skip += ONSET_BLOCK) {
      if (rmsOf(window, skip, ONSET_BLOCK) > threshold) return { window: i, skip };
    }
    return { window: i, skip: 0 };
  }
  return null;
}

/**
 * Split a reply into speakable sentences: on `.!?` boundaries, and any sentence still over
 * MAX_SENTENCE_CHARS is cut at the last word boundary that fits. Never returns an empty piece.
 */
function splitForSpeech(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)) {
    let sentence = raw.trim();
    while (sentence.length > MAX_SENTENCE_CHARS) {
      const cut = sentence.lastIndexOf(' ', MAX_SENTENCE_CHARS);
      const at = cut > 40 ? cut : MAX_SENTENCE_CHARS;
      out.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (sentence) out.push(sentence);
  }
  return out;
}

export class LocalCallSession {
  readonly callId: string;
  readonly botId: string;

  private readonly deps: LocalCallDeps;
  private readonly options: Required<LocalCallOptions>;
  private transport: Transport | null = null;

  private vad: Vad | null = null;
  private recognizer: OnlineRecognizer | null = null;
  private utterance: Utterance | null = null;

  /** Accepted-but-not-yet-windowed samples. */
  private chunks: Float32Array[] = [];
  private pendingSamples = 0;
  /** Pre-speech ring, so the first word is not lost to the VAD's confirmation delay. */
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;

  private muted = false;
  private closed = false;
  private pumping = false;

  private speaking = false;
  /** Bumped by barge-in and by every new turn: an older turn's audio queue sees the change and dies. */
  private turnGen = 0;
  private readonly wakers = new Set<() => void>();
  /** Timers and waits that belong to the turn in flight; releasing the turn clears every one. */
  private turnTimers = new Set<ReturnType<typeof setTimeout>>();
  private turnWaits = new Set<() => void>();
  /** Bumped when a cue ('One moment.', the nudge) is superseded: one that has not started is dropped. */
  private cueToken = 0;
  /** The cue currently playing, so the answer never interleaves with it. */
  private cuePlaying: Promise<void> | null = null;
  /** Set when the turn's wait for the agent ends: the filler must not start after that. */
  private turnSettled = true;

  /** On-device TTS model this call speaks with (the bot's `voice_model`). */
  private readonly model: string;
  /** Its native sample rate: 22 050 for Piper lessac, 24 000 for Kokoro. Never resampled. */
  private readonly ttsRate: number;

  constructor(opts: { callId: string; botId: string; model?: string; deps?: LocalCallDeps; options?: LocalCallOptions }) {
    this.callId = opts.callId;
    this.botId = opts.botId;
    this.model = opts.model ?? 'piper-lessac-medium';
    this.ttsRate = ttsSampleRate(this.model);
    this.deps = opts.deps ?? {};
    this.options = {
      leadPadMs: LEAD_PAD_S * 1000,
      speechRms: 0.006,
      fillerDelayMs: FILLER_DELAY_MS,
      progressMs: PROGRESS_MS,
      relayTimeoutMs: TURN_DEADLINE_MS,
      ...opts.options,
    };
    created.set(this, Date.now());
    binders.set(this, (transport) => {
      this.transport = transport;
      // A socket that attaches late still needs its first frame; the constructor's copy went to
      // whatever deps.onEvent it was given (in tests, the listener).
      if (transport) transport.event({ type: 'ready', ttsSampleRate: this.ttsRate, model: this.model });
    });
    this.emit({ type: 'ready', ttsSampleRate: this.ttsRate, model: this.model });
  }

  /** 16 kHz mono PCM16, any chunk size; VAD runs on 32 ms windows (512 samples). */
  accept(chunk: Int16Array): void {
    if (this.closed || this.muted || !chunk || !chunk.length) return;
    this.chunks.push(toFloat(chunk));
    this.pendingSamples += chunk.length;
    void this.pump();
  }

  /** Mute drops input before the VAD: it never stops the reply that is already playing. */
  setMuted(on: boolean): void {
    if (this.closed) return;
    this.muted = !!on;
    if (this.muted) {
      this.chunks = [];
      this.pendingSamples = 0;
      this.preroll = [];
      this.prerollSamples = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.speaking) {
      this.speaking = false;
      this.emit({ type: 'speaking', on: false });
    }
    this.turnGen++;
    this.cueToken++;
    this.releaseTurn();
    this.wakeAll();
    this.chunks = [];
    this.pendingSamples = 0;
    this.preroll = [];
    this.prerollSamples = 0;
    this.utterance = null;
    sessions.delete(this.callId);
    this.emit({ type: 'end' });
    this.transport = null;
  }

  // ---------- input path ----------

  private takeWindow(): Float32Array | null {
    if (this.pendingSamples < WINDOW) return null;
    const out = new Float32Array(WINDOW);
    let filled = 0;
    while (filled < WINDOW) {
      const head = this.chunks[0];
      const need = WINDOW - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.chunks.shift();
        this.pendingSamples -= head.length;
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        this.pendingSamples -= need;
        filled = WINDOW;
      }
    }
    return out;
  }

  /**
   * Drain the accepted audio a 32 ms window at a time. Runs serially (model loads are async, decode
   * is sync) so windows never interleave, and stops as soon as the buffer is short again.
   */
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      this.vad ??= await getVad();
      while (!this.closed) {
        const window = this.takeWindow();
        if (!window) break;
        await this.onWindow(window);
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.pumping = false;
    }
    if (!this.closed && this.pendingSamples >= WINDOW) void this.pump();
  }

  private async onWindow(window: Float32Array): Promise<void> {
    const vad = this.vad!;
    vad.acceptWaveform(window);
    const detected = vad.isDetected();

    // Barge-in: the person started talking over the bot. Nothing queued may play after this point.
    if (detected && this.speaking) this.bargeIn();

    if (!this.utterance) {
      this.preroll.push(window);
      this.prerollSamples += window.length;
      while (this.prerollSamples > (PREROLL_MS / 1000) * CALL_SAMPLE_RATE) {
        const dropped = this.preroll.shift()!;
        this.prerollSamples -= dropped.length;
      }
      if (!detected) return;
      await this.startUtterance();
      return;
    }

    const utterance = this.utterance;
    this.feed(utterance, window);
    utterance.silentMs = detected ? 0 : utterance.silentMs + WINDOW_MS;
    this.emitPartials(utterance);
    // Endpoint: the recognizer's trailing-silence rule, or the VAD-silence backstop.
    if (this.recognizer!.isEndpoint(utterance.stream) || utterance.silentMs >= END_SILENCE_MS) this.finishUtterance();
  }

  private async startUtterance(): Promise<void> {
    const recognizer = (this.recognizer ??= await getRecognizer());
    if (this.closed) return;
    // The caller has started a new utterance: whatever the last turn was still waiting on (or
    // still saying) is over. Barge-in covers the audible case; this covers a turn that is only
    // waiting for the agent.
    this.turnGen++;
    this.cueToken++;
    this.releaseTurn();
    const stream = recognizer.createStream();
    const { lead, windows } = this.leadIn();
    if (lead > 0) stream.acceptWaveform({ samples: new Float32Array(lead), sampleRate: CALL_SAMPLE_RATE });
    for (const window of windows) stream.acceptWaveform({ samples: window, sampleRate: CALL_SAMPLE_RATE });
    this.preroll = [];
    this.prerollSamples = 0;
    this.decode(stream);
    this.utterance = { stream, silentMs: 0, lastPartialAt: 0, lastPartialText: '' };
  }

  /**
   * Onset normalisation. This model's first word depends on how much silence the stream starts with
   * — the synthetic fixture transcribes "SWITCH" at 0.3 s of lead and "ON THE KIDS" at 0.5 s, because
   * the amount of silence shifts the chunk grid. Feeding a fixed pad plus however much preroll the
   * caller happened to leave made the transcript vary with their pause before speaking, so the stream
   * now always starts with the same thing: exactly the batch path's 0.3 s of silence, then the audio
   * from the first window of speech in the preroll ring. Everything older is dropped.
   *
   * No onset found (a caller quieter than the speech floor) keeps the ring as it is: better to feed
   * the audio than to invent a lead for something the recognizer may still hear.
   */
  private leadIn(): { lead: number; windows: Float32Array[] } {
    const lead = Math.max(0, Math.round((this.options.leadPadMs / 1000) * CALL_SAMPLE_RATE));
    const onset = findOnset(this.preroll, this.options.speechRms);
    if (!onset) return { lead: 0, windows: this.preroll };
    const windows = this.preroll.slice(onset.window);
    if (onset.skip) windows[0] = windows[0].subarray(onset.skip);
    return { lead, windows };
  }

  private feed(utterance: Utterance, window: Float32Array): void {
    utterance.stream.acceptWaveform({ samples: window, sampleRate: CALL_SAMPLE_RATE });
    this.decode(utterance.stream);
  }

  private decode(stream: OnlineStream): void {
    const recognizer = this.recognizer!;
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  }

  /** Partial transcripts, throttled to ~100 ms: a caption that updates faster than that is noise. */
  private emitPartials(utterance: Utterance): void {
    const now = performance.now();
    if (now - utterance.lastPartialAt < PARTIAL_MS) return;
    const text = String(this.recognizer!.getResult(utterance.stream).text ?? '').trim();
    if (!text || text === utterance.lastPartialText) return;
    utterance.lastPartialAt = now;
    utterance.lastPartialText = text;
    this.emit({ type: 'transcript', text, final: false });
  }

  private finishUtterance(): void {
    const utterance = this.utterance;
    this.utterance = null;
    this.preroll = [];
    this.prerollSamples = 0;
    if (!utterance) return;
    const text = String(this.recognizer!.getResult(utterance.stream).text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    try {
      this.recognizer!.reset(utterance.stream);
    } catch {
      /* the stream is dropped anyway */
    }
    if (!text) return;
    this.emit({ type: 'transcript', text, final: true });
    void this.respond(text);
  }

  // ---------- turn ----------

  /**
   * One turn: the agent is asked, and while it works the caller hears something. Three clocks run
   * against the relay — the filler (after fillerDelayMs), one progress nudge (after progressMs) and
   * the hard deadline (after relayTimeoutMs) — and every one of them is dropped the moment the
   * answer, a barge-in or a hang-up makes it pointless. Releasing the turn clears all of them, so a
   * finished turn leaves no timer behind.
   */
  private async respond(text: string): Promise<void> {
    const gen = ++this.turnGen;
    this.releaseTurn();
    this.cueToken++;
    this.turnSettled = false;
    this.emit({ type: 'thinking' });

    const relayed = this.relay(text).then(
      (reply) => ({ ok: true as const, reply }),
      (error) => ({ ok: false as const, error }),
    );

    // A race, not a step: a reply faster than the filler's grace delay is spoken instead of it.
    void this.filler(gen);
    const outcome = await this.waitForRelay(relayed, gen);
    if (this.closed || gen !== this.turnGen) return;

    if (outcome.kind === 'cancelled') return;

    if (outcome.kind === 'failed') {
      this.emit({ type: 'error', message: `relay failed: ${errText(outcome.error)}` });
      this.close();
      return;
    }

    if (outcome.kind === 'timeout') {
      // 90 s with no answer: say so, report the turn done and let go of everything. The default
      // relay's own 120 s poll is the process-level backstop; its late resolve finds this turn
      // finished and is ignored, as is any nudge still queued.
      this.cueToken++;
      await this.finishCue();
      await this.speakCue(TIMEOUT_TEXT, gen);
      if (this.closed || gen !== this.turnGen) return;
      this.releaseTurn();
      this.cueToken++;
      this.emit({ type: 'done' });
      return;
    }

    const reply = String(outcome.reply ?? '').replace(/\s+/g, ' ').trim();
    if (!reply) {
      this.cueToken++;
      this.emit({ type: 'error', message: 'the bot did not answer' });
      this.close();
      return;
    }
    // Whatever cue is audible finishes first (it is one short phrase); a cue that has not started
    // is dropped by the token bump above, so the answer is never behind a needless 'One moment.'.
    this.cueToken++;
    await this.finishCue();
    if (this.closed || gen !== this.turnGen) return;
    await this.speak(reply, gen);
    if (!this.closed && gen === this.turnGen) this.emit({ type: 'done' });
    this.releaseTurn();
  }

  private relay(text: string): Promise<string> {
    return this.deps.relay ? this.deps.relay(text) : defaultRelay(this.botId, this.callId, text);
  }

  /**
   * Wait for the agent, with the turn's two remaining clocks armed: one progress nudge at
   * progressMs, and the hard deadline at relayTimeoutMs. Resolves with whatever happened first.
   */
  private waitForRelay(
    relayed: Promise<{ ok: true; reply: string } | { ok: false; error: unknown }>,
    gen: number,
  ): Promise<RelayOutcome> {
    return new Promise<RelayOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: RelayOutcome) => {
        if (settled) return;
        settled = true;
        this.turnSettled = true;
        this.turnWaits.delete(cancel);
        this.cueToken++; // a cue that is not already audible has nothing left to cover
        this.releaseTurn();
        resolve(outcome);
      };
      // Barge-in and hang-up stop the wait without waiting for an answer nobody will hear.
      const cancel = () => finish({ kind: 'cancelled' });
      this.turnWaits.add(cancel);
      this.armTurnTimer(this.options.progressMs, () => void this.progressCue(gen));
      this.armTurnTimer(this.options.relayTimeoutMs, () => finish({ kind: 'timeout' }));
      relayed.then((r) => (r.ok ? finish({ kind: 'reply', reply: r.reply }) : finish({ kind: 'failed', error: r.error })));
    });
  }

  private async filler(gen: number): Promise<void> {
    await this.turnSleep(this.options.fillerDelayMs);
    if (this.turnSettled || this.closed || gen !== this.turnGen) return;
    await this.speakCue(FILLER_TEXT, gen);
  }

  /** 'Still working on that.' — armed once per turn, so it can never be said twice. */
  private async progressCue(gen: number): Promise<void> {
    if (this.closed || gen !== this.turnGen) return;
    await this.speakCue(PROGRESS_TEXT, gen);
  }

  /**
   * Speak one short cue under the same pacing and barge-in rules as a reply. Cues queue behind each
   * other rather than talking over each other, and one that is still being synthesised when the agent
   * answers is dropped before it makes a sound (the token bump in respond/waitForRelay).
   */
  private speakCue(text: string, gen: number): Promise<void> {
    const token = this.cueToken;
    const previous = this.cuePlaying;
    const started = (async () => {
      if (previous) await previous;
      if (!this.cueAudible(gen, token)) return;
      let out: { pcm: Int16Array; rate: number };
      try {
        out = await this.synth(text);
      } catch (e) {
        this.emit({ type: 'error', message: `speech synthesis failed: ${errText(e)}` });
        return;
      }
      if (!this.cueAudible(gen, token)) return;
      await this.playPhrase(out, gen);
    })();
    this.cuePlaying = started;
    void started.finally(() => {
      if (this.cuePlaying === started) this.cuePlaying = null;
    });
    return started;
  }

  /** Whether a cue may still start: its turn is current and nothing newer has superseded it. */
  private cueAudible(gen: number, token: number): boolean {
    return !this.closed && gen === this.turnGen && token === this.cueToken;
  }

  /** Let a cue that can still be heard finish before the answer starts; drop one that cannot. */
  private async finishCue(): Promise<void> {
    const playing = this.cuePlaying;
    if (playing) await playing;
  }

  /** Play one cue with the reply's 100 ms pacing, so barge-in can stop it mid-phrase. */
  private async playPhrase(out: { pcm: Int16Array; rate: number }, gen: number): Promise<void> {
    const frameSamples = out.rate > 0 ? Math.max(1, Math.round((out.rate * FRAME_MS) / 1000)) : FRAME_SAMPLES;
    let started = false;
    let nextAt = 0;
    for (let i = 0; i < out.pcm.length; i += frameSamples) {
      if (this.closed || gen !== this.turnGen) break;
      const wait = nextAt - performance.now();
      if (wait > 0) await this.sleep(wait);
      if (this.closed || gen !== this.turnGen) break;
      if (!started) {
        started = true;
        this.speaking = true;
        this.emit({ type: 'speaking', on: true });
        nextAt = performance.now();
      }
      this.pushAudio(out.pcm.subarray(i, Math.min(i + frameSamples, out.pcm.length)), out.rate);
      nextAt = Math.max(nextAt + FRAME_MS, performance.now() - 5);
    }
    if (started && this.speaking && !this.closed && gen === this.turnGen) {
      this.speaking = false;
      this.emit({ type: 'speaking', on: false });
    }
  }

  /** A timer that belongs to the current turn; unref'd so a pending one never holds the process. */
  private armTurnTimer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.turnTimers.delete(timer);
      if (!this.closed) fn();
    }, Math.max(0, ms));
    timer.unref?.();
    this.turnTimers.add(timer);
    return timer;
  }

  /** Sleep inside a turn: released early by the answer arriving, a barge-in or a hang-up. */
  private turnSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) {
          clearTimeout(timer);
          this.turnTimers.delete(timer);
        }
        this.turnWaits.delete(finish);
        resolve();
      };
      timer = this.armTurnTimer(ms, finish);
      this.turnWaits.add(finish);
    });
  }

  /** Drop everything the turn in flight owns: every timer and every wait. Idempotent. */
  private releaseTurn(): void {
    for (const timer of [...this.turnTimers]) {
      clearTimeout(timer);
      this.turnTimers.delete(timer);
    }
    for (const wake of [...this.turnWaits]) wake();
  }

  private async synth(text: string): Promise<{ pcm: Int16Array; rate: number }> {
    if (this.deps.synthesize) {
      const out = await this.deps.synthesize(text);
      return { pcm: out.pcm, rate: out.rate };
    }
    const audio = await synthesize(text, { model: this.model });
    return { pcm: new Int16Array(floatToPcm16(audio.samples)), rate: audio.sampleRate };
  }

  /**
   * Speak the reply sentence by sentence, emitting each sentence's 100 ms frames as soon as it is
   * synthesised. Frames are paced at real time (one per 100 ms) rather than dumped: the model runs
   * ~17× faster than playback, and a queue that is minutes deep cannot be cancelled by a barge-in.
   */
  private async speak(reply: string, gen: number): Promise<void> {
    let started = false;
    let nextAt = 0;
    for (const sentence of splitForSpeech(reply)) {
      if (this.closed || gen !== this.turnGen) return;
      let out: { pcm: Int16Array; rate: number };
      try {
        out = await this.synth(sentence);
      } catch (e) {
        this.emit({ type: 'error', message: `speech synthesis failed: ${errText(e)}` });
        return;
      }
      if (this.closed || gen !== this.turnGen) return;
      const frameSamples = out.rate > 0 ? Math.max(1, Math.round((out.rate * FRAME_MS) / 1000)) : FRAME_SAMPLES;
      for (let i = 0; i < out.pcm.length; i += frameSamples) {
        if (this.closed || gen !== this.turnGen) return;
        const wait = nextAt - performance.now();
        if (wait > 0) await this.sleep(wait);
        if (this.closed || gen !== this.turnGen) return;
        if (!started) {
          started = true;
          this.speaking = true;
          this.emit({ type: 'speaking', on: true });
          nextAt = performance.now();
        }
        this.pushAudio(out.pcm.subarray(i, Math.min(i + frameSamples, out.pcm.length)), out.rate);
        // Catch up after a slow sentence without ever bursting the whole backlog: pace from now.
        nextAt = Math.max(nextAt + FRAME_MS, performance.now() - 5);
      }
    }
    if (this.speaking && !this.closed && gen === this.turnGen) {
      this.speaking = false;
      this.emit({ type: 'speaking', on: false });
    }
  }

  /** Speech over the bot: drop the rest of this turn's sentences and any frame it has not sent. */
  private bargeIn(): void {
    if (!this.speaking) return;
    this.speaking = false;
    this.turnGen++; // invalidates the speaking turn's remaining frames and its {type:'done'}
    this.cueToken++;
    this.releaseTurn(); // and its pending filler/nudge/deadline: the new utterance owns the call now
    this.emit({ type: 'speaking', on: false });
    this.wakeAll();
  }

  // ---------- out ----------

  private emit(e: LocalCallEvent): void {
    try {
      this.deps.onEvent?.(e);
    } catch {
      /* a broken listener must not break the call */
    }
    try {
      this.transport?.event(e);
    } catch {
      /* ditto for the socket */
    }
  }

  private pushAudio(pcm: Int16Array, sampleRate: number): void {
    // Copy: the frame must not alias the sentence buffer the next subarray mutates.
    const frame = new Int16Array(pcm);
    try {
      this.deps.onAudio?.(frame, sampleRate);
    } catch {}
    try {
      this.transport?.audio(frame, sampleRate);
    } catch {}
  }

  private fail(e: unknown): void {
    this.emit({ type: 'error', message: errText(e) });
    this.close();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this.wakers.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, Math.max(0, ms));
      this.wakers.add(finish);
    });
  }

  /** Wake every pacing sleep early (barge-in, close) so nothing waits out a 100 ms frame. */
  private wakeAll(): void {
    for (const wake of [...this.wakers]) wake();
  }
}

// ---------- the registry of call ids ----------

const sessions = new Map<string, LocalCallSession>();

/** Drop call ids nobody ever claimed: a POST /session whose socket never opened must not linger. */
function sweep() {
  const now = Date.now();
  for (const [callId, session] of sessions) {
    if (now - (created.get(session) ?? 0) < UNCLAIMED_TTL_MS) continue;
    sessions.delete(callId);
    session.close();
  }
}
setInterval(sweep, 60_000).unref();

/** Mint a call id's session. POST /local/session calls this; the socket upgrade claims it. */
export function createLocalCall(callId: string, botId: string, opts: { model?: string } = {}): LocalCallSession {
  sweep();
  const session = new LocalCallSession({ callId, botId, model: opts.model });
  sessions.set(callId, session);
  return session;
}

/** Claim a call id for a socket. Unknown, already claimed or expired ids return undefined. */
export function takeLocalCall(callId: string): LocalCallSession | undefined {
  sweep();
  const session = sessions.get(callId);
  if (!session) return undefined;
  sessions.delete(callId);
  return session;
}

/** Diagnostics and the leak test: how many call ids are waiting for a socket. */
export function pendingLocalCalls(): number {
  return sessions.size;
}

// ---------- the default relay ----------

/** The `rows` body the relay reads: a finished assistant message. */
interface AssistantMessageBody {
  type?: string;
  role?: string;
  streaming?: boolean;
  text?: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Production relay: post the transcript into the bot's chat as a voice message, hand the same
 * request to the agent loop with the '[Voice call: …]' prompt voice.ts uses for send_task, then
 * wait for the turn's assistant message to stop streaming. Returns '' on timeout, which makes the
 * session report an error and hang up.
 *
 * VOICE_CALL_RELAY=echo short-circuits all of that and returns the transcript uppercased, so a
 * socket test can run end to end with no agent and no provider key. That switch is for tests and
 * diagnostics only; nothing in production sets it.
 */
export async function defaultRelay(botId: string, callId: string, text: string): Promise<string> {
  if ((process.env.VOICE_CALL_RELAY ?? '').trim().toLowerCase() === 'echo') return text.toUpperCase();

  const [{ appendRow, getBotRow: botRow }, { enqueue }, { db }] = await Promise.all([
    import('./store.js'),
    import('./agent/loop.js'),
    import('./db.js'),
  ]);
  const bot = botRow(botId);
  if (!bot) return '';

  const row = appendRow(botId, 'message', {
    type: 'message',
    role: 'user',
    text,
    from: { kind: 'voice', id: callId, name: 'Voice call' },
  });

  const firstName = String((db.prepare('SELECT name FROM users WHERE id=?').get(bot.user_id) as { name?: string } | undefined)?.name ?? 'the user').split(/\s+/)[0] || 'the user';
  enqueue(botId, {
    type: 'user',
    text: `[Voice call: ${firstName} asked for this on a live voice call with you. Do the work, then reply in plain, short text with the outcome. Your reply is read aloud on the call, so lead with the answer and skip markdown, links and IDs unless asked.]\n${text}`,
  });

  // The turn lands as rows; the answer is the first non-streaming assistant message after ours.
  const deadline = Date.now() + RELAY_TIMEOUT_MS;
  const generation = bot.generation;
  while (Date.now() < deadline) {
    await wait(RELAY_POLL_MS);
    const rows = db
      .prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND seq>? AND kind='message' ORDER BY seq ASC LIMIT 50")
      .all(botId, generation, row.seq) as { body: string }[];
    for (const r of rows) {
      let body: AssistantMessageBody;
      try {
        body = JSON.parse(r.body) as AssistantMessageBody;
      } catch {
        continue;
      }
      if (body?.type === 'message' && body.role === 'assistant' && !body.streaming && typeof body.text === 'string' && body.text.trim()) {
        return body.text;
      }
    }
  }
  return '';
}

// ---------- the WebSocket relay ----------

/** PCM16 LE bytes from a binary frame → samples. */
function pcm16From(buf: Buffer): Int16Array {
  const n = buf.length >> 1; // a trailing odd byte is dropped rather than misread
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/**
 * WebSocket relay for /api/voice/local/call/:callId, mounted the same way as attachVncRelay.
 *
 * Upgrade rules: no session cookie (or ?token=) is a raw 401 on the socket; an unknown, expired or
 * already claimed call id is a 404; a call that belongs to someone else's bot is a 403 and the
 * session is closed rather than handed over.
 */
export function attachLocalCallRelay(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/voice\/local\/call\/([^/]+)$/);
    if (!m) return; // not ours

    const refuse = (status: string) => {
      try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch {
        /* the peer may already be gone */
      }
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
    const session = takeLocalCall(callId);
    if (!session) return refuse('404 Not Found');

    const bot = getBotRow(session.botId);
    if (!bot || bot.user_id !== user.id) {
      session.close();
      return refuse('403 Forbidden');
    }

    wss.handleUpgrade(req, socket, head, (client) => runCall(client, session));
  });
}

function runCall(client: WebSocket, session: LocalCallSession): void {
  const send = (data: string | Buffer) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  };

  bindTransport(session, {
    event: (e) => send(JSON.stringify(e)),
    audio: (pcm, rate) => send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
  });

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
      return; // a malformed control frame is ignored, never fatal
    }
    if (msg?.type === 'mute') session.setMuted(!!msg.on);
    else if (msg?.type === 'end') {
      session.close();
      try {
        client.close(1000, 'ended');
      } catch {
        /* already closing */
      }
    }
  });

  client.on('close', () => {
    bindTransport(session, null);
    session.close();
  });
  client.on('error', () => {
    bindTransport(session, null);
    session.close();
  });
}
