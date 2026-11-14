/**
 * The local call session and its WebSocket relay, on the real engines and the fixture audio.
 *
 * No engine is mocked: this loads the actual sherpa-onnx addon, the 263 MB model cache and the
 * fixtures. The only injected things are the two things a call cannot do in a test -- talking to a
 * live agent (so the relay echoes) -- and the client's microphone (the fixture WAV stands in for it).
 * Every assertion prints the measured number so a regression is diagnosable from CI output alone.
 *
 * Run with the cache:  VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models pnpm --filter @orbit/server test
 */
import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { WebSocket } from 'ws';
import { cleanupTmpEnv } from './helpers/tmp-env.js';

const FIXTURES = new URL('./fixtures/voice/', import.meta.url).pathname;
const MODELS_DIR = process.env.VOICE_MODELS_DIR ?? path.join(os.homedir(), '.hermes', 'cache', 'voice-models');
process.env.VOICE_MODELS_DIR = MODELS_DIR;
process.env.VOICE_AUTO_DOWNLOAD = '0';
// The socket test runs the production relay path with no agent behind it: the echo switch returns
// the transcript uppercased (see voice-local-session.ts).
process.env.VOICE_CALL_RELAY = 'echo';

const sessionModule = await import('../voice-local-session.js');
const { LocalCallSession, createLocalCall, takeLocalCall, pendingLocalCalls, attachLocalCallRelay } = sessionModule;
/** The class's instance type; a destructured binding does not carry it. */
type Session = InstanceType<typeof LocalCallSession>;
const { synthesize, pcm16ToFloat, floatToPcm16 } = await import('../voice-runtime.js');
const { localVoiceApi } = await import('../voice-local.js');
const { db } = await import('../db.js');

after(() => cleanupTmpEnv());

// ---------- fixtures ----------

interface ManifestFile {
  file: string;
  audioMs: number;
  transcript: string;
  minSimilarity: number;
}
const MANIFEST: { files: ManifestFile[]; silence: { file: string; audioMs: number } } = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'),
);
const COMMAND = MANIFEST.files.find((f) => f.file === 'en-command.wav')!;

interface Wav {
  sampleRate: number;
  /** PCM16 LE payload, exactly what a client streams over the socket. */
  pcm: Buffer;
  samples: Int16Array;
  durationMs: number;
}

/** Minimal RIFF/WAVE reader; the fixtures are 16 kHz mono PCM16 but the header is read honestly. */
function readWav(file: string): Wav {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', `${path.basename(file)} is not a RIFF file`);
  let pos = 12;
  let sampleRate = 16000;
  let dataOffset = -1;
  let dataLength = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(pos + 12);
    else if (id === 'data') {
      dataOffset = pos + 8;
      dataLength = Math.min(size, buf.length - dataOffset);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  assert.ok(dataOffset >= 0, `${path.basename(file)} has no data chunk`);
  const pcm = buf.subarray(dataOffset, dataOffset + dataLength);
  const samples = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
  return { sampleRate, pcm, samples, durationMs: Math.round((samples.length / sampleRate) * 1000) };
}

const COMMAND_WAV = readWav(path.join(FIXTURES, COMMAND.file));
/** Real human speech (LibriSpeech), used for the interrupted utterance: the synthetic command clip
 * sits right on this model's decision boundary ("SWITCH" ↔ "ON"), so it cannot gate accuracy. */
const LONG = MANIFEST.files.find((f) => f.file === 'en-librispeech-long.wav')!;
const LONG_WAV = readWav(path.join(FIXTURES, LONG.file));
const SILENCE_WAV = readWav(path.join(FIXTURES, MANIFEST.silence.file));

/** Word-overlap similarity the manifest specifies: 2·LCS / (len_a + len_b) over normalised words. */
function words(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}
function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 1;
  let prev = new Array<number>(y.length + 1).fill(0);
  let cur = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return (2 * prev[y.length]) / (x.length + y.length);
}

/** The model cache: same files the phase-1 tests check for. */
const NEEDS = [
  path.join(MODELS_DIR, 'stt', 'encoder-epoch-99-avg-1.int8.onnx'),
  path.join(MODELS_DIR, 'stt', 'tokens.txt'),
  path.join(MODELS_DIR, 'tts', 'en_US-lessac-medium.onnx'),
  path.join(MODELS_DIR, 'tts', 'espeak-ng-data', 'en_dict'),
  path.join(MODELS_DIR, 'vad', 'silero_vad.onnx'),
];
const missing = NEEDS.filter((p) => !fs.existsSync(p));
const skipModels = missing.length ? `voice models not present (${MODELS_DIR}: missing ${missing.map((m) => path.relative(MODELS_DIR, m)).join(', ')})` : false;
const ADDON_LOG = (await import('../voice-runtime.js')).runtimeInfo();

// ---------- fixtures in the database: a user with a bot, and a stranger ----------

const USER = 'usr_voice_call';
const TOKEN = 'voice-call-test-token';
const BOT = 'bot_voice_call';
const OTHER_USER = 'usr_voice_call_other';
const OTHER_TOKEN = 'voice-call-other-token';
const OTHER_BOT = 'bot_voice_call_other';
const nowMs = Date.now();
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'voice-call@test.local', 'Ray Bello', nowMs);
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(OTHER_USER, 'voice-call-other@test.local', 'Someone Else', nowMs);
db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(TOKEN, USER, nowMs, nowMs + 3600_000);
db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(OTHER_TOKEN, OTHER_USER, nowMs, nowMs + 3600_000);
db.prepare('INSERT OR REPLACE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(BOT, USER, 'Doug', nowMs, nowMs);
db.prepare('INSERT OR REPLACE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(OTHER_BOT, OTHER_USER, 'Not Yours', nowMs, nowMs);

// ---------- helpers ----------

const FRAME_MS = 20; // the client's 20 ms chunks; the session re-windows them to 32 ms
const CHUNK = (16000 * FRAME_MS) / 1000;

const ms = (n: number) => `${n.toFixed(0)} ms`;
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));

/** Feed PCM16 in 20 ms frames, yielding the event loop so the session's pump can keep up. */
async function feed(session: Session, samples: Int16Array, opts: { every?: number } = {}) {
  const every = opts.every ?? 25;
  let sent = 0;
  for (let i = 0; i < samples.length; i += CHUNK, sent++) {
    session.accept(samples.subarray(i, Math.min(i + CHUNK, samples.length)));
    if (sent % every === 0) await sleep(0);
  }
}

/** Silence, as the client would send it, to let the endpoint rule fire. */
async function feedSilence(session: Session, msToSend: number) {
  await feed(session, new Int16Array(Math.round((16000 * msToSend) / 1000)));
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 30_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return performance.now() - started;
    await sleep(10);
  }
  throw new Error(`timed out after ${ms(timeoutMs)} waiting for ${what}`);
}

interface Recorded {
  events: { e: any; at: number }[];
  audio: { samples: Int16Array; rate: number; at: number }[];
}

/** A session wired to a recorder, so assertions can talk about frames and their ordering. */
function recorder(
  deps: { relay?: (t: string) => Promise<string>; synthesize?: any } = {},
  options?: Record<string, number>,
) {
  const rec: Recorded = { events: [], audio: [] };
  const session = new LocalCallSession({
    callId: `call_test_${Math.random().toString(36).slice(2, 9)}`,
    botId: BOT,
    deps: {
      ...deps,
      onEvent: (e) => rec.events.push({ e, at: performance.now() }),
      onAudio: (samples, rate) => rec.audio.push({ samples, rate, at: performance.now() }),
    },
    options,
  });
  return { rec, session };
}

/**
 * The real Piper engine, wrapped so a test can name the phrases the session asked for: the audio
 * is genuine (the engine is not mocked), the log says which phrase it belongs to.
 */
function spokenThrough(log: { text: string; at: number }[]) {
  return async (text: string) => {
    const out = await synthesize(text);
    log.push({ text, at: performance.now() });
    return { pcm: new Int16Array(floatToPcm16(out.samples)), rate: out.sampleRate };
  };
}

/**
 * A short deterministic phrase for the tests whose subject is the clock and the ordering, not the
 * voice: real PCM16 frames at the voice's rate, synthesised instantly, so a 3 s wait costs 3 s and
 * not 3 s plus Piper. The real engine's filler latency is measured by the test above.
 */
function tonePhrase(ms = 120, rate = 22050): { pcm: Int16Array; rate: number } {
  const n = Math.max(1, Math.round((rate * ms) / 1000));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return { pcm, rate };
}

/** tonePhrase per text, logging what was asked for; `msFor` lets a filler last long enough to be
 * interrupted. */
function tonesThrough(log: { text: string; at: number }[], msFor: (text: string) => number = () => 120) {
  return (text: string) => {
    log.push({ text, at: performance.now() });
    return tonePhrase(msFor(text));
  };
}

/** One utterance as the client sends it: optional silence, the fixture, then enough to endpoint
 * (the recognizer's own rule is 0.8 s of trailing silence, so 1.2 s is enough with margin). */
async function utterance(session: Session, samples: Int16Array, leadMs = 0) {
  if (leadMs > 0) await feedSilence(session, leadMs);
  await feed(session, samples);
  await feedSilence(session, 1200);
}

/** Run one fixture through a session and return the final transcript it produced. */
async function sessionTranscript(samples: Int16Array, leadMs: number, options?: Record<string, number>) {
  const spoken: { text: string; at: number }[] = [];
  const { rec, session } = recorder(
    { relay: async (text) => `${text.toLowerCase()}.`, synthesize: tonesThrough(spoken) },
    options,
  );
  await utterance(session, samples, leadMs);
  await waitFor('the final transcript', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  const final = rec.events.find((x) => x.e.type === 'transcript' && x.e.final)!.e as { text: string };
  session.close();
  return final.text;
}

/**
 * The reference length of a spoken sentence. Piper's VITS duration predictor is sampled per call, so
 * the same text synthesises to slightly different lengths each time (measured: 47 504–51 968 samples
 * for the same sentence); a few runs give the band the session's own audio must land in.
 */
async function referenceMs(text: string, runs = 3): Promise<{ min: number; max: number }> {
  const lengths: number[] = [];
  for (let i = 0; i < runs; i++) lengths.push((await synthesize(text)).samples.length);
  return { min: Math.min(...lengths), max: Math.max(...lengths) };
}

const peakOf = (frames: { samples: Int16Array }[]) => {
  let peak = 0;
  for (const f of frames) for (const s of f.samples) peak = Math.max(peak, Math.abs(s) / 32768);
  return peak;
};
const samplesOf = (frames: { samples: Int16Array }[]) => frames.reduce((n, f) => n + f.samples.length, 0);

// ---------- 1. the fixture flows through the whole pipeline ----------

test('streams en-command.wav: partials, final transcript, then 22 050 Hz audio frames', { skip: skipModels }, async (t) => {
  assert.equal(ADDON_LOG.addon, true, `the sherpa-onnx addon must load on ${ADDON_LOG.platform}-${ADDON_LOG.arch}`);

  // The relay echoes, so the reply is known exactly and its audio can be measured independently.
  let relayed = '';
  const { rec, session } = recorder({
    relay: async (text) => {
      relayed = `${text.toLowerCase()}.`;
      return relayed;
    },
  });

  // Warm the TTS engine (model load is ~420 ms) so the measured first-audio latency is the call
  // path, not the first-ever model load.
  await synthesize('warm up');

  const firstPartialAt = () => rec.events.find((x) => x.e.type === 'transcript' && !x.e.final)?.at ?? null;
  const started = performance.now();

  await feed(session, COMMAND_WAV.samples);
  const speechFedAt = performance.now();
  // The fixture ends on the last word; a real call has silence after it, which is what endpoints.
  await feedSilence(session, 2200);

  await waitFor('the final transcript', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  const finalEvent = rec.events.find((x) => x.e.type === 'transcript' && x.e.final)!;
  const final = finalEvent.e as { text: string; final: boolean };
  const sim = similarity(final.text, COMMAND.transcript);
  assert.ok(
    sim >= COMMAND.minSimilarity,
    `transcript similarity ${sim.toFixed(3)} < ${COMMAND.minSimilarity}; heard ${JSON.stringify(final.text)} ` +
      `for ${JSON.stringify(COMMAND.transcript)} (${COMMAND.audioMs} ms of audio)`,
  );
  assert.equal(relayed, `${final.text.toLowerCase()}.`, 'the relay receives the final transcript');

  await waitFor('the answer to be spoken', () => rec.audio.length > 0);
  const firstAudioEvent = rec.events.find((x) => x.e.type === 'speaking' && x.e.on)!;
  assert.ok(firstAudioEvent, 'speaking:true must precede the first audio frame');
  assert.ok(
    rec.events.indexOf(firstAudioEvent) < rec.events.length,
    'speaking:true arrives before the frames it announces',
  );
  assert.ok(firstAudioEvent.at <= rec.audio[0].at, 'speaking:true is emitted before the first frame is pushed');

  await waitFor('the turn to finish', () => rec.events.some((x) => x.e.type === 'done'), 60_000);
  const doneAt = rec.events.find((x) => x.e.type === 'done')!.at;
  const turnMs = doneAt - finalEvent.at;

  // -- frames --
  assert.ok(rec.audio.length > 0, 'the reply must be spoken');
  for (const frame of rec.audio) assert.equal(frame.rate, 22050, `every frame carries the voice's own rate, got ${frame.rate}`);
  const frameLengths = new Set(rec.audio.map((f) => f.samples.length));
  const fullFrames = rec.audio.filter((f) => f.samples.length === 2205).length;
  assert.ok(
    fullFrames >= rec.audio.length - 2,
    `frames are the 2205-sample (100 ms) shape from the conventions doc; lengths seen: ${[...frameLengths].join(', ')}`,
  );

  // The same sentence synthesised directly is the reference for the reply's length. Piper samples
  // its durations per call, so the band is a few runs wide rather than one exact number.
  const reference = await referenceMs(relayed);
  const total = samplesOf(rec.audio);
  const emittedMs = (total / 22050) * 1000;
  const referenceBand = ((reference.min + reference.max) / 2 / 22050) * 1000;
  assert.ok(
    emittedMs > referenceBand * 0.8 && emittedMs < referenceBand * 1.2,
    `frames must sum to the reply's audio: ${total} samples = ${emittedMs.toFixed(0)} ms at 22 050 Hz, ` +
      `reference ${(reference.min / 22050 * 1000).toFixed(0)}–${(reference.max / 22050 * 1000).toFixed(0)} ms for ` +
      JSON.stringify(relayed),
  );

  const peak = peakOf(rec.audio);
  assert.ok(peak > 0.05, `the frames must be audible, peak amplitude ${peak.toFixed(3)} (needs > 0.05)`);

  // -- partials --
  const partials = rec.events.filter((x) => x.e.type === 'transcript' && !x.e.final);
  assert.ok(partials.length >= 1, 'streaming STT must emit partial transcripts before the final one');
  const gaps: number[] = [];
  for (let i = 1; i < partials.length; i++) gaps.push(partials[i].at - partials[i - 1].at);
  const minGap = gaps.length ? Math.min(...gaps) : Infinity;
  assert.ok(gaps.every((g) => g >= 90), `partials are throttled to ~100 ms; smallest gap measured ${minGap.toFixed(0)} ms`);
  assert.ok(firstPartialAt()! - started < COMMAND.audioMs, 'the first partial arrives while the person is still talking');

  // -- control order --
  const order = rec.events.map((x) => x.e.type);
  assert.equal(order[0], 'ready', `the first frame is ready, got ${order[0]}`);
  assert.ok(order.indexOf('thinking') < order.indexOf('speaking'), 'thinking precedes the answer');
  const errors = rec.events.filter((x) => x.e.type === 'error');
  assert.equal(errors.length, 0, `no error frames expected: ${JSON.stringify(errors.map((x) => x.e))}`);
  const speaking = rec.events.filter((x) => x.e.type === 'speaking').map((x) => (x.e as any).on);
  assert.deepEqual(speaking, [true, false], `speaking goes on then off, got ${JSON.stringify(speaking)}`);
  assert.equal(order.at(-1), 'done', `done is the last frame of a turn, got ${JSON.stringify(order.slice(-3))}`);

  t.diagnostic(
    `${COMMAND.file}: similarity ${sim.toFixed(3)}/${COMMAND.minSimilarity}; ` +
      `first partial ${ms((firstPartialAt() ?? started) - started)} after the first frame was accepted; ` +
      `final transcript ${ms(finalEvent.at - speechFedAt)} after the last speech frame; ` +
      `${partials.length} partials (min gap ${minGap === Infinity ? 'n/a' : ms(minGap)}); ` +
      `first audio ${ms(rec.audio[0].at - finalEvent.at)} after the transcript; ` +
      `${rec.audio.length} frames, ${total} samples = ${emittedMs.toFixed(0)} ms at 22 050 Hz ` +
      `(reference ${(reference.min / 22050 * 1000).toFixed(0)}–${(reference.max / 22050 * 1000).toFixed(0)} ms), ` +
      `peak ${peak.toFixed(3)}, ` +
      `turn ${ms(turnMs)}; STT heard ${JSON.stringify(final.text)}`,
  );
  session.close();
});

// ---------- 2. silence is not an utterance ----------

test('silence produces no transcript and no audio', { skip: skipModels }, async (t) => {
  const { rec, session } = recorder({ relay: async (text) => text });
  const started = performance.now();
  await feed(session, SILENCE_WAV.samples);
  await feedSilence(session, 1500);
  await sleep(1200);
  const waited = performance.now() - started;

  assert.equal(rec.events.filter((x) => x.e.type === 'transcript').length, 0, `silence must not transcribe; events: ${JSON.stringify(rec.events.map((x) => x.e.type))}`);
  assert.equal(rec.audio.length, 0, `silence must not produce audio frames, got ${rec.audio.length}`);
  assert.equal(rec.events.filter((x) => x.e.type === 'thinking').length, 0, 'silence must not start a turn');
  assert.deepEqual(rec.events.map((x) => x.e.type), ['ready'], `only the ready frame is expected, got ${JSON.stringify(rec.events.map((x) => x.e.type))}`);

  t.diagnostic(`${SILENCE_WAV.durationMs} ms of silence + 1500 ms: 0 transcripts, 0 frames after ${ms(waited)}`);
  session.close();
});

// ---------- 3. mute drops input before the VAD ----------

test('muted input is dropped before the VAD, unmuting restores it, and mute never cuts the reply', { skip: skipModels }, async (t) => {
  const { rec, session } = recorder({ relay: async (text) => `${text.toLowerCase()}.` });
  session.setMuted(true);
  await feed(session, COMMAND_WAV.samples);
  await feedSilence(session, 1200);
  await sleep(1000);
  assert.equal(
    rec.events.filter((x) => x.e.type === 'transcript').length,
    0,
    `muted audio must not transcribe; events: ${JSON.stringify(rec.events.map((x) => x.e.type))}`,
  );
  assert.equal(rec.audio.length, 0, `muted audio must not start a turn, got ${rec.audio.length} frames`);

  // Not vacuous: the same bytes transcribe once the microphone is live again.
  session.setMuted(false);
  await feed(session, COMMAND_WAV.samples);
  await feedSilence(session, 2200);
  const waited = await waitFor('the transcript after unmuting', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  const final = rec.events.find((x) => x.e.type === 'transcript' && x.e.final)!.e as { text: string };
  const sim = similarity(final.text, COMMAND.transcript);
  assert.ok(sim >= COMMAND.minSimilarity, `unmuted audio must transcribe: similarity ${sim.toFixed(3)}, heard ${JSON.stringify(final.text)}`);

  // Muting the microphone never stops the reply that is already playing.
  await waitFor('the answer to start', () => rec.audio.length > 0);
  const playing = rec.audio.length;
  session.setMuted(true);
  await waitFor('the answer to keep playing while muted', () => rec.audio.length > playing + 2, 10_000);
  session.setMuted(false);
  const speakingDuringMute = rec.audio.length - playing;

  t.diagnostic(
    `muted: 0 transcripts over ${COMMAND_WAV.durationMs} ms of speech; ` +
      `unmuted: similarity ${sim.toFixed(3)} after ${ms(waited)}; ` +
      `mute pressed mid-reply: ${speakingDuringMute} more frames still played, no speaking:false`,
  );
  session.close();
});

// ---------- 4. barge-in ----------

test('speech during the answer cuts it off: speaking:false and no further frames', { skip: skipModels }, async (t) => {
  let turn = 0;
  const reply = 'The kitchen lights are on. The weather outside is sunny and mild. Anything else you need?';
  const { rec, session } = recorder({
    relay: async (text) => {
      turn++;
      return turn === 1 ? reply : `(second turn) ${text.toLowerCase()}.`;
    },
  });

  // The person speaks, the bot answers...
  await feed(session, COMMAND_WAV.samples);
  await feedSilence(session, 2200);
  await waitFor('the final transcript', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  await waitFor('the answer to start', () => rec.audio.length > 0);
  // Let a few 100 ms frames out first: this is a barge-in mid-reply, not a race with the first frame.
  await waitFor('the reply to be under way', () => rec.audio.length >= 4);
  const framesBefore = rec.audio.length;
  const wholeReply = await referenceMs(reply);
  assert.ok(framesBefore > 0 && framesBefore < 100, `the answer is paced, not dumped: ${framesBefore} frames out when the interruption starts`);

  // ...and talks over it. The interruption is the LibriSpeech clip: real speech, so the accuracy
  // assertion below is about the engine rather than about how well `say` imitates a person.
  const interruptAt = Date.now();
  await feed(session, LONG_WAV.samples);
  await feedSilence(session, 2200);
  const interruptMs = Date.now() - interruptAt;

  const offs = rec.events.filter((x) => x.e.type === 'speaking' && !x.e.on);
  assert.ok(offs.length >= 1, `barge-in must emit speaking:false; events: ${JSON.stringify(rec.events.map((x) => `${x.e.type}${x.e.type === 'speaking' ? `:${x.e.on}` : ''}`))}`);
  const bargeAt = offs[0].at;
  const afterBarge = rec.audio.filter((f) => f.at > bargeAt);
  assert.equal(afterBarge.length, 0, `${afterBarge.length} audio frames were pushed after speaking:false; the queue must be dropped`);

  // The rest of the first reply was dropped rather than spoken out.
  const cutoff = rec.audio.filter((f) => f.at <= bargeAt);
  const played = samplesOf(cutoff);
  assert.ok(
    played < wholeReply.min * 0.9,
    `the remaining sentences must be dropped: ${played} samples played of at least ${wholeReply.min} ` +
      `synthesised for the whole three-sentence reply`,
  );

  // The new utterance still reaches the recognizer and gets its own turn.
  const finals = rec.events.filter((x) => x.e.type === 'transcript' && x.e.final);
  await waitFor('the interruption to be transcribed', () => finals.length >= 2, 30_000);
  const second = finals[1].e as { text: string };
  const sim = similarity(second.text, LONG.transcript);
  assert.ok(
    sim >= LONG.minSimilarity,
    `the barge-in utterance must transcribe: similarity ${sim.toFixed(3)} < ${LONG.minSimilarity}, ` +
      `heard ${JSON.stringify(second.text.slice(0, 160))}`,
  );

  t.diagnostic(
    `barge-in after ${framesBefore} frames (${((samplesOf(cutoff) / 22050) * 1000).toFixed(0)} ms of audio): ` +
      `speaking:false emitted, ${afterBarge.length} frames after it, ${LONG_WAV.durationMs} ms of ` +
      `interruption transcribed with similarity ${sim.toFixed(3)} in ${interruptMs} ms`,
  );
  session.close();
});

// ---------- 4b. the error path ----------

test('a relay that fails reports error and ends the call, without a done frame', { skip: skipModels }, async (t) => {
  const { rec, session } = recorder({
    relay: async () => {
      throw new Error('engine unreachable');
    },
  });
  await feed(session, COMMAND_WAV.samples);
  await feedSilence(session, 2200);
  await waitFor('the error frame', () => rec.events.some((x) => x.e.type === 'error'));
  await waitFor('the end frame', () => rec.events.some((x) => x.e.type === 'end'));

  const types = rec.events.map((x) => x.e.type);
  const error = rec.events.find((x) => x.e.type === 'error')!.e as { message: string };
  assert.match(error.message, /engine unreachable/, `the error must carry the cause, got ${JSON.stringify(error.message)}`);
  assert.ok(types.includes('transcript'), 'the transcript is emitted before the failure');
  assert.ok(!types.includes('done'), `a failed turn must not report done: ${JSON.stringify(types)}`);
  assert.equal(types.at(-1), 'end', `the call ends after the error, got ${JSON.stringify(types.slice(-2))}`);
  assert.equal(rec.audio.length, 0, 'a failed relay must not speak anything');
  t.diagnostic(`error path: ${JSON.stringify(error.message)} then end; frames ${JSON.stringify(types)}`);
});

// ---------- 4c. the synthetic fixture on the session path (the onset gate) ----------

/**
 * The gate this phase had to earn: streamed through the session — VAD, preroll ring, onset
 * normalisation — the synthetic command clip must transcribe as well as the batch path does
 * (1.000 with its fixed 0.3 s pad). Before onset normalisation this measured 0.842 at 1.5 s of
 * leading silence, because the lead the caller left shifted the recognizer's chunk grid.
 */
test('the session transcribes en-command.wav at similarity >= 0.9', { skip: skipModels }, async (t) => {
  const text = await sessionTranscript(COMMAND_WAV.samples, 0);
  const sim = similarity(text, COMMAND.transcript);
  assert.ok(
    sim >= COMMAND.minSimilarity,
    `session transcript similarity ${sim.toFixed(3)} < ${COMMAND.minSimilarity}; heard ${JSON.stringify(text)} ` +
      `for ${JSON.stringify(COMMAND.transcript)}`,
  );
  t.diagnostic(`${COMMAND.file} through the session: similarity ${sim.toFixed(3)}/${COMMAND.minSimilarity}, heard ${JSON.stringify(text)}`);
});

/**
 * The same clip with 1.5 s of leading silence — a caller who paused before speaking. The lead into
 * the recognizer must be the same 0.3 s of silence either way; if it were not, this is the case that
 * used to measure 0.842.
 */
test('1.5 s of leading silence leaves the fixture transcribing at >= 0.9 (the lead is normalised)', { skip: skipModels }, async (t) => {
  const late = await sessionTranscript(COMMAND_WAV.samples, 1500);
  const lateSim = similarity(late, COMMAND.transcript);
  assert.ok(
    lateSim >= COMMAND.minSimilarity,
    `after 1500 ms of leading silence similarity ${lateSim.toFixed(3)} < ${COMMAND.minSimilarity}; heard ${JSON.stringify(late)}`,
  );
  t.diagnostic(
    `lead normalisation: 1500 ms of client silence before the fixture -> ${lateSim.toFixed(3)} ${JSON.stringify(late)}; ` +
      `the no-lead case is the test above (both must clear ${COMMAND.minSimilarity})`,
  );
});

// ---------- 4d. the filler while a slow agent works ----------

test('a caller quieter than the speech floor still reaches the recognizer (no onset: the ring as it is)', { skip: skipModels }, async (t) => {
  // speechRms above anything real: no window qualifies, so the fallback feeds the ring unchanged
  // rather than inventing a 0.3 s lead. The audio must still transcribe.
  const text = await sessionTranscript(COMMAND_WAV.samples, 600, { speechRms: 1 });
  const sim = similarity(text, COMMAND.transcript);
  assert.ok(
    sim >= COMMAND.minSimilarity,
    `the no-onset fallback must still transcribe: similarity ${sim.toFixed(3)}, heard ${JSON.stringify(text)}`,
  );
  t.diagnostic(`no onset found (speechRms 1): ring fed as-is, similarity ${sim.toFixed(3)} ${JSON.stringify(text)}`);
});

test('a slow agent hears "One moment." within a second, once, before the answer', { skip: skipModels }, async (t) => {
  const spoken: { text: string; at: number }[] = [];
  const { rec, session } = recorder({
    relay: async (text) => {
      await sleep(3000);
      return 'Yes, the lights are on.'; // a short answer keeps the real-engine cost down
    },
    synthesize: spokenThrough(spoken),
  });

  // Warm the voice so the measured delay is the call path, not the first model load.
  await synthesize('warm up');

  await utterance(session, COMMAND_WAV.samples);
  await waitFor('the final transcript', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  const finalAt = rec.events.find((x) => x.e.type === 'transcript' && x.e.final)!.at;

  await waitFor('the filler phrase', () => spoken.some((s) => s.text === 'One moment.'), 5000);
  const fillerSynthAt = spoken.find((s) => s.text === 'One moment.')!.at;
  await waitFor('the first filler frame', () => rec.audio.some((f) => f.at >= fillerSynthAt), 5000);
  const fillerFrameAt = rec.audio.find((f) => f.at >= fillerSynthAt)!.at;
  const fillerDelay = fillerFrameAt - finalAt;

  await waitFor('the turn to finish', () => rec.events.some((x) => x.e.type === 'done'), 30_000);
  const replies = spoken.filter((s) => s.text !== 'One moment.' && s.text !== 'Still working on that.');
  const fillers = spoken.filter((s) => s.text === 'One moment.');

  assert.equal(fillers.length, 1, `the filler must be spoken exactly once per turn, got ${fillers.length}: ${JSON.stringify(spoken.map((s) => s.text))}`);
  assert.ok(replies.length >= 1, `the answer must still be spoken after the filler: ${JSON.stringify(spoken.map((s) => s.text))}`);
  assert.ok(
    spoken.indexOf(fillers[0]) < spoken.indexOf(replies[0]),
    `the filler comes before the answer: ${JSON.stringify(spoken.map((s) => s.text))}`,
  );
  assert.ok(
    fillerDelay < 1000,
    `the filler must be audible within 1 s of the transcript, measured ${ms(fillerDelay)} (relay resolves after 3000 ms)`,
  );
  const answerSynthAt = replies[0].at;
  const answerFrames = rec.audio.filter((f) => f.at >= answerSynthAt);
  assert.ok(answerFrames.length > 0, 'the answer has audio after the filler');

  t.diagnostic(
    `relay 3000 ms: filler synthesised +${ms(fillerSynthAt - finalAt)} and first frame +${ms(fillerDelay)} after the transcript, ` +
      `spoken once, answer synthesised +${ms(answerSynthAt - finalAt)}; phrases ${JSON.stringify(spoken.map((s) => s.text))}`,
  );
  session.close();
});

test('a fast agent is answered without a filler frame in front of it', { skip: skipModels }, async (t) => {
  const spoken: { text: string; at: number }[] = [];
  const { rec, session } = recorder({
    relay: async (text) => {
      await sleep(180); // a 180 ms agent: inside the 400 ms the filler waits
      return `${text.toLowerCase()}.`;
    },
    synthesize: tonesThrough(spoken),
  });

  await utterance(session, COMMAND_WAV.samples);
  await waitFor('the final transcript', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  const finalAt = rec.events.find((x) => x.e.type === 'transcript' && x.e.final)!.at;
  await waitFor('the answer to be spoken', () => rec.audio.length > 0);
  await waitFor('the turn to finish', () => rec.events.some((x) => x.e.type === 'done'), 30_000);

  assert.equal(
    spoken.filter((s) => s.text === 'One moment.').length,
    0,
    `a relay faster than the grace delay must not get a filler: ${JSON.stringify(spoken.map((s) => s.text))}`,
  );
  const answerAt = spoken[0].at;
  const firstFrame = rec.audio[0].at;
  assert.ok(firstFrame >= answerAt, 'the first audio frame of a fast turn belongs to the answer');
  assert.ok(
    firstFrame - finalAt < 1000,
    `the answer must start promptly: first frame ${ms(firstFrame - finalAt)} after the transcript`,
  );

  t.diagnostic(
    `relay 180 ms: no filler, first frame ${ms(firstFrame - finalAt)} after the transcript ` +
      `(${ms(firstFrame - answerAt)} after synthesis); phrases ${JSON.stringify(spoken.map((s) => s.text))}`,
  );
  session.close();
});

test('speech over the filler cuts it off, and the answer it was covering is never spoken', { skip: skipModels }, async (t) => {
  const spoken: { text: string; at: number }[] = [];
  let turn = 0;
  const covering = 'The kitchen lights are on.';
  const { rec, session } = recorder({
    relay: async (text) => {
      turn++;
      if (turn === 1) {
        await sleep(3000); // the answer the filler is covering for
        return covering;
      }
      return `(second turn) ${text.toLowerCase()}.`;
    },
    // A 1.5 s tone for the filler, so the interruption lands while it is still playing; the answers
    // are short. What matters here is the cancellation, not the voice.
    synthesize: tonesThrough(spoken, (text) => (text === 'One moment.' ? 1500 : 120)),
  });
  await utterance(session, COMMAND_WAV.samples);
  await waitFor('the final transcript', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  await waitFor('the filler phrase', () => spoken.some((s) => s.text === 'One moment.'), 5000);
  const fillerSynthAt = () => spoken.find((s) => s.text === 'One moment.')!.at;
  await waitFor('the filler to be under way', () => rec.audio.filter((f) => f.at >= fillerSynthAt()).length >= 3);
  const fillerFrames = rec.audio.filter((f) => f.at >= fillerSynthAt()).length;

  // The caller talks over the filler. Any real utterance will do — this is about the cancellation,
  // and the command clip is 2.4 s where the LibriSpeech clip is 16.7 s.
  await feed(session, COMMAND_WAV.samples);
  await feedSilence(session, 1600);
  const offs = rec.events.filter((x) => x.e.type === 'speaking' && !x.e.on);
  assert.ok(offs.length >= 1, `a barge-in over the filler must emit speaking:false: ${JSON.stringify(rec.events.map((x) => `${x.e.type}${x.e.type === 'speaking' ? `:${x.e.on}` : ''}`))}`);
  const bargeAt = offs[0].at;

  await waitFor('the interruption to be transcribed', () => rec.events.filter((x) => x.e.type === 'transcript' && x.e.final).length >= 2, 30_000);
  await waitFor("the interruption's own answer", () => spoken.some((s) => s.text.startsWith('(second turn)')), 15_000);
  const secondReplyAt = spoken.find((s) => s.text.startsWith('(second turn)'))!.at;

  const leaked = rec.audio.filter((f) => f.at > bargeAt && f.at < secondReplyAt);
  assert.equal(leaked.length, 0, `${leaked.length} audio frames played between the barge-in and the next answer`);
  assert.ok(
    !spoken.some((s) => s.text === covering),
    `the answer the filler was covering must be dropped, not spoken later: ${JSON.stringify(spoken.map((s) => s.text))}`,
  );

  t.diagnostic(
    `filler cut off after ${fillerFrames} frames: speaking:false at +${ms(bargeAt - fillerSynthAt())} of the filler, ` +
      `0 frames until the next turn, covered answer never spoken; phrases ${JSON.stringify(spoken.map((s) => s.text))}`,
  );
  session.close();
});

test('a stalled agent gets one nudge, then a spoken apology and a clean done at the deadline', { skip: skipModels }, async (t) => {
  const spoken: { text: string; at: number }[] = [];
  // The production thresholds are 20 s and 90 s; the same clocks at test speed keep this honest and
  // the whole case under a few seconds.
  const PROGRESS = 600;
  const DEADLINE = 1600;
  let answer: (text: string) => void = () => {};
  const stalled = new Promise<string>((resolve) => {
    answer = resolve;
  });
  const { rec, session } = recorder(
    // Short deterministic phrases: this test is about the clocks, and the tone is real PCM the
    // session paces like any other audio.
    { relay: () => stalled, synthesize: tonesThrough(spoken) },
    { fillerDelayMs: 80, progressMs: PROGRESS, relayTimeoutMs: DEADLINE },
  );

  await utterance(session, COMMAND_WAV.samples);
  await waitFor('the final transcript', () => rec.events.some((x) => x.e.type === 'transcript' && x.e.final));
  const finalAt = rec.events.find((x) => x.e.type === 'transcript' && x.e.final)!.at;

  await waitFor('the nudge', () => spoken.some((s) => s.text === 'Still working on that.'), 10_000);
  const nudgeAt = spoken.find((s) => s.text === 'Still working on that.')!.at;
  assert.ok(nudgeAt - finalAt >= PROGRESS - 100, `the nudge waits for the progress threshold: ${ms(nudgeAt - finalAt)} of ${PROGRESS} ms`);
  assert.ok(
    rec.audio.some((f) => f.at >= nudgeAt),
    'the nudge must actually be spoken, not just synthesised',
  );

  await waitFor('the turn to finish after the deadline', () => rec.events.some((x) => x.e.type === 'done'), 20_000);
  const doneAt = rec.events.find((x) => x.e.type === 'done')!.at;
  const apology = spoken.filter((s) => s.text.startsWith("That's taking too long"));
  assert.equal(apology.length, 1, `the apology must be spoken once: ${JSON.stringify(spoken.map((s) => s.text))}`);
  assert.ok(apology[0].at > nudgeAt, 'the apology follows the nudge');
  assert.ok(rec.audio.some((f) => f.at >= apology[0].at), 'the apology must be audible');
  assert.equal(
    spoken.filter((s) => s.text === 'Still working on that.').length,
    1,
    `the nudge is said once, not once per threshold: ${JSON.stringify(spoken.map((s) => s.text))}`,
  );
  assert.ok(doneAt - finalAt >= DEADLINE - 100, `done waits for the deadline: ${ms(doneAt - finalAt)} of ${DEADLINE} ms`);

  // Nothing dangles: the turn released every timer it armed, and the relay answering late is ignored.
  const active = (session as unknown as { turnTimers: Set<unknown> }).turnTimers;
  assert.equal(active.size, 0, `the finished turn must leave no timer armed, ${active.size} still pending`);
  const eventsAfterDone = rec.events.length;
  const framesAfterDone = rec.audio.length;
  answer('a very late reply.');
  await sleep(500);
  assert.equal(rec.audio.length, framesAfterDone, 'a reply that arrives after the deadline must not be spoken');
  assert.equal(rec.events.length, eventsAfterDone, `no events after done, got ${JSON.stringify(rec.events.slice(eventsAfterDone).map((x) => x.e.type))}`);
  const types = rec.events.map((x) => x.e.type);
  assert.equal(types.at(-1), 'done', `done is the last frame of the abandoned turn: ${JSON.stringify(types.slice(-4))}`);

  t.diagnostic(
    `stalled agent: nudge +${ms(nudgeAt - finalAt)} (threshold ${PROGRESS} ms), apology +${ms(apology[0].at - finalAt)}, ` +
      `done +${ms(doneAt - finalAt)} (deadline ${DEADLINE} ms), ${active.size} timers left, late reply ignored; ` +
      `phrases ${JSON.stringify(spoken.map((s) => s.text))}`,
  );
  session.close();
});

// ---------- 5. the socket ----------

/** Connect and report the HTTP status of a refused upgrade (or throw when it unexpectedly opens). */
function refused(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('the upgrade neither opened nor was refused'));
    }, 8000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('the upgrade unexpectedly succeeded'));
    });
    ws.on('error', () => {
      /* the refusal arrives through unexpected-response; a socket error after it is noise */
    });
  });
}

test('the relay refuses bad upgrades and streams a real call end to end', { skip: skipModels }, async (t) => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachLocalCallRelay(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  const post = (body: unknown, token = TOKEN) =>
    localVoiceApi.request('/session', {
      method: 'POST',
      headers: { cookie: `grokbot_session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  // Unauthenticated: the router needs a session before it will even mint an id.
  const anonymous = await localVoiceApi.request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: BOT }) });
  assert.equal(anonymous.status, 401, `an unauthenticated POST /session must be 401, got ${anonymous.status}`);

  // Someone else's bot is not a call you can start.
  const foreign = await post({ botId: OTHER_BOT });
  assert.equal(foreign.status, 404, `another user's bot must be 404, got ${foreign.status}`);

  // Upgrade refusals, before any session exists.
  assert.equal(await refused(`${wsBase}/api/voice/local/call/call_nope`, {}), 401, 'an unauthenticated upgrade must be 401');
  assert.equal(await refused(`${wsBase}/api/voice/local/call/call_nope`, { cookie: `grokbot_session=${TOKEN}` }), 404, 'an unknown call id must be 404');

  // A real call id, minted by the route.
  const minted = await post({ botId: BOT });
  assert.equal(minted.status, 200, `POST /session returned ${minted.status}: ${await minted.clone().text()}`);
  const { callId, sampleRate, ttsSampleRate } = (await minted.json()) as { callId: string; sampleRate: number; ttsSampleRate: number };
  assert.ok(callId.startsWith('call_'), `call ids are prefixed, got ${callId}`);
  assert.equal(sampleRate, 16000, `the input rate is 16 kHz, got ${sampleRate}`);
  assert.equal(ttsSampleRate, 22050, `the voice is 22 050 Hz, got ${ttsSampleRate}`);
  assert.equal(pendingLocalCalls(), 1, `the minted call must be waiting for its socket, got ${pendingLocalCalls()}`);

  assert.equal(await refused(`${wsBase}/api/voice/local/call/${callId}`, {}), 401, 'the call id must still demand a session');

  // A call id belongs to the person whose bot it is: a stranger's cookie is refused and the call
  // is closed rather than handed over.
  const stolen = await post({ botId: BOT });
  const stolenId = ((await stolen.json()) as { callId: string }).callId;
  assert.equal(
    await refused(`${wsBase}/api/voice/local/call/${stolenId}`, { cookie: `grokbot_session=${OTHER_TOKEN}` }),
    403,
    "another user's call id must be 403",
  );
  assert.equal(await refused(`${wsBase}/api/voice/local/call/${stolenId}`, { cookie: `grokbot_session=${TOKEN}` }), 404, 'a refused call id is closed, not reusable');
  assert.equal(pendingLocalCalls(), 1, `only the real call should still be pending, got ${pendingLocalCalls()}`);

  // The authenticated socket gets the session and streams the fixture.
  const frames: Buffer[] = [];
  const control: any[] = [];
  const ws = new WebSocket(`${wsBase}/api/voice/local/call/${encodeURIComponent(callId)}`, {
    headers: { cookie: `grokbot_session=${TOKEN}` },
  });
  // Attach before the handshake resolves: the ready frame is the first thing on the wire.
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) frames.push(Buffer.from(data));
    else control.push(JSON.parse(Buffer.from(data).toString('utf8')));
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  await waitFor('the ready frame', () => control.some((c) => c.type === 'ready'));
  assert.equal(control[0].type, 'ready', `the first frame is ready, got ${JSON.stringify(control[0])}`);
  assert.equal(control[0].ttsSampleRate, 22050, `ready must report the voice rate, got ${control[0].ttsSampleRate}`);
  assert.equal(pendingLocalCalls(), 0, `the socket must claim the call id, ${pendingLocalCalls()} still pending`);

  // A second socket for the same id is refused: the id is single use.
  assert.equal(await refused(`${wsBase}/api/voice/local/call/${callId}`, { cookie: `grokbot_session=${TOKEN}` }), 404, 'a claimed call id must be 404');

  const started = performance.now();
  for (let i = 0; i < COMMAND_WAV.pcm.length; i += CHUNK * 2) {
    ws.send(COMMAND_WAV.pcm.subarray(i, Math.min(i + CHUNK * 2, COMMAND_WAV.pcm.length)));
    if ((i / (CHUNK * 2)) % 25 === 0) await sleep(0);
  }
  const speechFedAt = performance.now();
  const silence = Buffer.alloc(2 * 16000 * 2.2);
  for (let i = 0; i < silence.length; i += CHUNK * 2) {
    ws.send(silence.subarray(i, Math.min(i + CHUNK * 2, silence.length)));
    if ((i / (CHUNK * 2)) % 25 === 0) await sleep(0);
  }

  await waitFor('the transcript over the socket', () => control.some((c) => c.type === 'transcript' && c.final));
  const final = control.find((c) => c.type === 'transcript' && c.final);
  const sim = similarity(final.text, COMMAND.transcript);
  assert.ok(sim >= COMMAND.minSimilarity, `socket transcript similarity ${sim.toFixed(3)} < ${COMMAND.minSimilarity}; heard ${JSON.stringify(final.text)}`);
  const finalAt = performance.now();

  await waitFor('audio over the socket', () => frames.length > 0);
  await waitFor('the turn to finish', () => control.some((c) => c.type === 'done'), 60_000);
  const totalMs = performance.now() - speechFedAt;

  // Binary frames: PCM16 at 22 050 Hz, 2205 samples each, audible.
  const pcm = Buffer.concat(frames);
  assert.ok(pcm.length > 0, 'audio frames must arrive as binary');
  assert.ok(frames.every((f) => f.length % 2 === 0), 'every frame is whole PCM16 samples');
  const decoded = pcm16ToFloat(pcm);
  let peak = 0;
  for (const s of decoded) peak = Math.max(peak, Math.abs(s));
  const reference = await referenceMs(final.text.toUpperCase());
  const audioMs = (decoded.length / 22050) * 1000;
  const fullBytes = frames.filter((f) => f.length === 4410).length;
  assert.ok(
    fullBytes >= frames.length - 2,
    `frames are 2205-sample (100 ms) PCM16 at 22 050 Hz; ${fullBytes} of ${frames.length} frames are 4410 bytes`,
  );
  const referenceBand = ((reference.min + reference.max) / 2 / 22050) * 1000;
  assert.ok(
    audioMs > referenceBand * 0.8 && audioMs < referenceBand * 1.2,
    `socket audio must be the reply's length: ${decoded.length} samples = ${audioMs.toFixed(0)} ms, ` +
      `reference ${(reference.min / 22050 * 1000).toFixed(0)}–${(reference.max / 22050 * 1000).toFixed(0)} ms`,
  );
  assert.ok(peak > 0.05, `socket audio must be audible, peak ${peak.toFixed(3)} (needs > 0.05)`);
  const controlOrder = control.map((c) => c.type);
  for (const kind of ['thinking', 'speaking', 'done']) assert.ok(controlOrder.includes(kind), `missing ${kind} frame; got ${JSON.stringify(controlOrder)}`);

  t.diagnostic(
    `socket: similarity ${sim.toFixed(3)}; ${frames.length} binary frames, ${decoded.length} samples ` +
      `= ${audioMs.toFixed(0)} ms at 22 050 Hz (peak ${peak.toFixed(3)}, ${((pcm.length / (totalMs / 1000) / 1024) | 0)} KB/s avg); ` +
      `transcript in ${ms(finalAt - speechFedAt)}, turn ${ms(totalMs)}; ` +
      `refusals: 401 unauthenticated, 404 unknown, 403 not yours, 404 already claimed`,
  );

  // The mute control frame is honoured over the wire: muted audio reaches no recognizer.
  const transcriptsBefore = control.filter((c) => c.type === 'transcript').length;
  ws.send(JSON.stringify({ type: 'mute', on: true }));
  await sleep(50);
  for (let i = 0; i < COMMAND_WAV.pcm.length; i += CHUNK * 2) {
    ws.send(COMMAND_WAV.pcm.subarray(i, Math.min(i + CHUNK * 2, COMMAND_WAV.pcm.length)));
    if ((i / (CHUNK * 2)) % 25 === 0) await sleep(0);
  }
  for (let i = 0; i < silence.length; i += CHUNK * 2) {
    ws.send(silence.subarray(i, Math.min(i + CHUNK * 2, silence.length)));
    if ((i / (CHUNK * 2)) % 25 === 0) await sleep(0);
  }
  await sleep(800);
  assert.equal(
    control.filter((c) => c.type === 'transcript').length,
    transcriptsBefore,
    `muted audio over the socket must produce no transcripts; frames: ${JSON.stringify(control.map((c) => c.type))}`,
  );

  // Closing the socket ends the call and leaves nothing behind.
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  ws.send(JSON.stringify({ type: 'end' }));
  await closed;
  assert.equal(pendingLocalCalls(), 0, `the call map must not grow after the call ends, ${pendingLocalCalls()} entries left`);
  assert.equal(takeLocalCall(callId), undefined, 'a finished call id must be unknown, not resurrectable');

  // Ten more mint/claim cycles leave the registry empty: no leak across calls.
  for (let i = 0; i < 10; i++) {
    const r = await post({ botId: BOT });
    const id = ((await r.json()) as { callId: string }).callId;
    assert.equal(takeLocalCall(id)!.callId, id, 'the freshly minted id must be claimable');
  }
  assert.equal(pendingLocalCalls(), 0, `after ten mint/claim cycles the map must be empty, got ${pendingLocalCalls()}`);
});

// ---------- 6. the registry, without a model ----------

test('call ids are single use, expire unclaimed, and close() ends the call', async (t) => {
  const before = pendingLocalCalls();
  const created = createLocalCall('call_registry_check', BOT);
  assert.equal(pendingLocalCalls(), before + 1, 'createLocalCall must register the id');
  assert.equal(takeLocalCall('call_registry_check')?.callId, 'call_registry_check', 'the minted id must be claimable');
  assert.equal(takeLocalCall('call_registry_check'), undefined, 'takeLocalCall is single use');
  assert.equal(pendingLocalCalls(), before, 'a claimed id leaves the map');

  // close() is idempotent and emits exactly one end frame.
  const events: any[] = [];
  const session = new LocalCallSession({ callId: 'call_close_check', botId: BOT, deps: { onEvent: (e) => events.push(e) } });
  session.close();
  session.close();
  session.accept(new Int16Array(512)); // after close: ignored, never an error
  assert.deepEqual(events.map((e) => e.type), ['ready', 'end'], `close() must emit one end: ${JSON.stringify(events.map((e) => e.type))}`);
  created.close();
  t.diagnostic('registry: single use, close() idempotent, accept() after close ignored');
});
