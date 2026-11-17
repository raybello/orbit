/**
 * GPU voice (audio.cpp): the HTTP adapter's parsers, the call session's turn-taking and audio/video
 * framing with injected engines, and the endpoint helpers. None of these need a GPU.
 *
 * The "live" tests at the bottom talk to a real audiocpp_server at AUDIOCPP_URL (default
 * http://127.0.0.1:8080) configured like infra/audiocpp/server-config.json, and skip when nothing
 * answers there, so CI without a GPU stays green while a developer box exercises the real thing.
 */
import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { cleanupTmpEnv } from './helpers/tmp-env.js';

const audiocpp = await import('../voice-audiocpp.js');
const { AudiocppCallSession, ReplySegmenter, speakableText, cleanTranscript, FRAME_AUDIO, FRAME_VIDEO } = await import('../voice-audiocpp-session.js');
type AudiocppCallEvent = import('../voice-audiocpp-session.js').AudiocppCallEvent;
type AvatarStreamItem = import('../voice-audiocpp.js').AvatarStreamItem;
const endpoints = await import('../voice-audiocpp-endpoints.js');

after(async () => {
  // Windows cannot delete an open SQLite file: close it before the temp dir goes.
  (await import('../db.js')).db.close();
  cleanupTmpEnv();
});

const FIXTURES = new URL('./fixtures/voice/', import.meta.url);

// ---------- helpers ----------

/** A 16 kHz "utterance": silence, a loud 220 Hz tone, silence. */
function utterance(leadMs: number, speechMs: number, tailMs: number, amp = 0.3): Int16Array {
  const rate = 16000;
  const n = Math.round(((leadMs + speechMs + tailMs) / 1000) * rate);
  const out = new Int16Array(n);
  const from = Math.round((leadMs / 1000) * rate);
  const to = from + Math.round((speechMs / 1000) * rate);
  for (let i = from; i < to; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amp * 32767);
  return out;
}

/** Feed a clip in 20 ms frames, the way the browser does. */
function feed(session: { accept(c: Int16Array): void }, pcm: Int16Array) {
  for (let i = 0; i < pcm.length; i += 320) session.accept(pcm.subarray(i, i + 320));
}

function waitFor(events: AudiocppCallEvent[], type: AudiocppCallEvent['type'], ms = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (events.some((e) => e.type === type)) { clearInterval(t); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error(`no ${type} event; saw ${events.map((e) => e.type).join(',')}`)); }
    }, 10);
  });
}

async function* gen<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
  for (const x of items) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield x;
  }
}

// ---------- adapter ----------

test('pcm16ToWav and wavToPcm16 round-trip, and the reader walks chunks instead of assuming 44 bytes', () => {
  const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const wav = audiocpp.pcm16ToWav(pcm, 24000);
  const back = audiocpp.wavToPcm16(wav);
  assert.equal(back.rate, 24000);
  assert.deepEqual([...back.pcm], [...pcm]);
  // A LIST chunk before `data` (what many encoders write) must not be read as audio.
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
  const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);
  assert.deepEqual([...audiocpp.wavToPcm16(withList).pcm], [...pcm]);
});

test('sseEvents reassembles events split across reads, skips noise, and stops at [DONE]', async () => {
  const big = 'x'.repeat(200_000);
  const text = `: comment\n\ndata: {"type":"a","v":"${big}"}\n\ndata: not-json\n\ndata: {"type":"b"}\r\n\ndata: [DONE]\n\ndata: {"type":"after"}\n\n`;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 4093) c.enqueue(bytes.subarray(i, i + 4093));
      c.close();
    },
  });
  const seen: Record<string, unknown>[] = [];
  for await (const e of audiocpp.sseEvents(body)) seen.push(e);
  assert.deepEqual(seen.map((e) => e.type), ['a', 'b']);
  assert.equal((seen[0].v as string).length, big.length);
});

test('speakableText strips markdown and links and caps long replies at a sentence', () => {
  assert.equal(speakableText('**Done.** See [the doc](https://x.y/z) or https://a.b/c `code`.'), 'Done. See the doc or a link code.');
  const long = 'This is a sentence. '.repeat(120);
  const out = speakableText(long);
  assert.ok(out.length <= 1200 && out.endsWith('.'), `capped at a sentence (${out.length})`);
  assert.equal(cleanTranscript(' <nospeech> hello  there '), 'hello there');
});

// ---------- session ----------

test('an utterance is gated by the VAD, transcribed, relayed, and spoken as 0x01 frames', async () => {
  const events: AudiocppCallEvent[] = [];
  const frames: Buffer[] = [];
  const heard: number[] = [];
  const session = new AudiocppCallSession({
    callId: 'call_t1', botId: 'bot_x', voice: 'british_english_male',
    options: { fillerDelayMs: 60_000 },
    deps: {
      transcribe: async (pcm) => { heard.push(pcm.length); return 'hello there'; },
      relay: async (text) => `You said: ${text}.`,
      speech: (text) => gen([{ pcm: new Int16Array(2400).fill(1000), rate: 24000 }, { pcm: new Int16Array(2400).fill(-1000), rate: 24000 }]),
      onEvent: (e) => events.push(e),
      onBinary: (f) => frames.push(f),
    },
  });
  assert.deepEqual(events[0], { type: 'ready', ttsSampleRate: 24000, hasAvatar: false, voice: 'british_english_male' });
  feed(session, utterance(300, 800, 900));
  await waitFor(events, 'done');
  session.close();
  const types = events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 8), ['ready', 'listening', 'listening', 'thinking', 'transcript', 'reply', 'speaking', 'speaking']);
  assert.deepEqual(events.find((e) => e.type === 'reply'), { type: 'reply', text: 'You said: hello there.' });
  assert.ok(types.indexOf('done') > types.indexOf('transcript'));
  // The utterance keeps the preroll (the tone's onset) and drops most of the trailing silence.
  assert.equal(heard.length, 1);
  const ms = (heard[0] / 16000) * 1000;
  assert.ok(ms > 1000 && ms < 1700, `utterance ${ms} ms`);
  assert.equal(frames.length, 2);
  assert.ok(frames.every((f) => f[0] === FRAME_AUDIO && f.length === 1 + 4800));
});

test('silence and short clicks never start a turn', async () => {
  const events: AudiocppCallEvent[] = [];
  let calls = 0;
  const session = new AudiocppCallSession({
    callId: 'call_t2', botId: 'bot_x', voice: 'v',
    deps: { transcribe: async () => { calls++; return 'x'; }, onEvent: (e) => events.push(e) },
  });
  feed(session, utterance(2000, 0, 0));
  feed(session, utterance(100, 60, 1500)); // 60 ms: below the 96 ms onset
  await new Promise((r) => setTimeout(r, 100));
  session.close();
  assert.equal(calls, 0);
  assert.ok(!events.some((e) => e.type === 'thinking'));
});

test('avatar replies pair each video chunk with exactly its audio, then its frames', async () => {
  const events: AudiocppCallEvent[] = [];
  const frames: Buffer[] = [];
  const W = 4, H = 4, N = 24, FPS = 25;
  const rgb = Buffer.alloc(W * H * 3 * N, 7);
  const items: AvatarStreamItem[] = [
    { kind: 'audio', pcm: new Int16Array(12000).fill(5), rate: 24000 },
    { kind: 'audio', pcm: new Int16Array(12000).fill(6), rate: 24000 },
    { kind: 'video', rgb, frames: N, fps: FPS, width: W, height: H },
    { kind: 'audio', pcm: new Int16Array(500).fill(9), rate: 24000 }, // speech past the last chunk
  ];
  const session = new AudiocppCallSession({
    callId: 'call_t3', botId: 'bot_x', voice: 'v', portraitPath: '/p.jpg',
    options: { fillerDelayMs: 60_000 },
    deps: {
      transcribe: async () => 'hi',
      relay: async () => 'Hello!',
      avatar: () => gen(items),
      encodeFrame: async (frame, w, h) => Buffer.from(`jpeg:${frame.length}:${w}x${h}`),
      onEvent: (e) => events.push(e),
      onBinary: (f) => frames.push(f),
    },
  });
  assert.equal(session.hasAvatar, true);
  feed(session, utterance(200, 600, 900));
  await waitFor(events, 'done', 8000);
  session.close();
  const avatar = events.find((e) => e.type === 'avatar');
  assert.deepEqual(avatar, { type: 'avatar', frames: N, fps: FPS, width: W, height: H });
  // 24 frames at 25 fps = 0.96 s = 23 040 samples at 24 kHz, sent as one audio frame before the video.
  assert.equal(frames[0][0], FRAME_AUDIO);
  assert.equal((frames[0].length - 1) / 2, 23040);
  const video = frames.slice(1, 1 + N);
  assert.ok(video.every((f, i) => f[0] === FRAME_VIDEO && f.readUInt16LE(1) === i));
  assert.equal(video[0].subarray(3).toString(), `jpeg:${W * H * 3}:${W}x${H}`);
  // The rest of the speech (960 + 500 samples) still reaches the caller after the last chunk.
  const tail = frames.slice(1 + N);
  assert.equal(tail.length, 1);
  assert.equal((tail[0].length - 1) / 2, 960 + 500);
});

test('an avatar that fails before any audio falls back to speech without video', async () => {
  const events: AudiocppCallEvent[] = [];
  const frames: Buffer[] = [];
  const session = new AudiocppCallSession({
    callId: 'call_t4', botId: 'bot_x', voice: 'v', portraitPath: '/missing.jpg',
    options: { fillerDelayMs: 60_000 },
    deps: {
      transcribe: async () => 'hi',
      relay: async () => 'Hello!',
      // eslint-disable-next-line require-yield
      avatar: async function* () { throw new Error('reference image not found'); },
      speech: () => gen([{ pcm: new Int16Array(240), rate: 24000 }]),
      onEvent: (e) => events.push(e),
      onBinary: (f) => frames.push(f),
    },
  });
  feed(session, utterance(200, 600, 900));
  await waitFor(events, 'done');
  session.close();
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], FRAME_AUDIO);
  assert.ok(!events.some((e) => e.type === 'error'));
});

test('talking over the bot is barge-in: the reply stops and the new utterance becomes the turn', async () => {
  const events: AudiocppCallEvent[] = [];
  let aborted = false;
  const transcripts = ['first', 'second'];
  const session = new AudiocppCallSession({
    callId: 'call_t5', botId: 'bot_x', voice: 'v',
    options: { fillerDelayMs: 60_000 },
    deps: {
      transcribe: async () => transcripts.shift() ?? 'more',
      relay: async (t) => (t === 'first' ? 'A long answer.' : 'Short.'),
      speech: (text, signal) => (async function* () {
        signal.addEventListener('abort', () => { aborted = true; });
        if (text === 'A long answer.') {
          // Ten seconds of reply so far, and the GPU is still generating the rest when the caller
          // talks over it: the generation must be cancelled, not just the playback.
          yield { pcm: new Int16Array(240000), rate: 24000 };
          await new Promise((r) => signal.addEventListener('abort', r));
        } else yield { pcm: new Int16Array(240), rate: 24000 };
      })(),
      onEvent: (e) => events.push(e),
    },
  });
  feed(session, utterance(200, 600, 900));
  await waitFor(events, 'speaking');
  await new Promise((r) => setTimeout(r, 50));
  // Quiet echo of the bot's own voice is not barge-in…
  feed(session, utterance(0, 400, 0, 0.015));
  assert.ok(!events.some((e) => e.type === 'barge-in'), 'echo-level audio must not interrupt');
  // …a person speaking up is.
  feed(session, utterance(0, 900, 900, 0.4));
  await waitFor(events, 'barge-in');
  assert.ok(aborted, 'the reply stream was cancelled');
  await waitFor(events, 'done', 8000);
  session.close();
  const said = events.filter((e) => e.type === 'transcript').map((e) => (e as { text: string }).text);
  assert.deepEqual(said, ['first', 'second']);
});

test('ReplySegmenter: the first sentence goes out alone, later ones are gathered, code is never split', () => {
  const seg = new ReplySegmenter();
  assert.deepEqual(seg.push('Sure'), [], 'no sentence end yet');
  assert.deepEqual(seg.push('Sure. I checked'), ['Sure.']);
  assert.deepEqual(seg.push('Sure. I checked your calendar. You have'), [], 'later pieces wait for a comfortable size');
  const long = 'Sure. I checked your calendar. You have three meetings today, starting at nine with the design review. ';
  assert.deepEqual(seg.push(long), ['I checked your calendar. You have three meetings today, starting at nine with the design review.']);
  assert.deepEqual(seg.push(`${long}Then lunch.`, true), ['Then lunch.']);

  const code = new ReplySegmenter();
  assert.deepEqual(code.push('Run this: ```ls -la. echo hi.``` Done. More'), ['Run this: Done.'], 'the fence is dropped, not cut through');

  const runOn = new ReplySegmenter();
  const opening = 'Well, looking at everything you asked for this morning, including the budget and the hiring plan and the offsite, here is';
  assert.deepEqual(runOn.push(opening), ['Well, looking at everything you asked for this morning, including the budget and the hiring plan and the offsite,'], 'a long opening speaks its clauses');
});

test('a streamed reply is spoken piece by piece while it is still being written', async () => {
  const events: AudiocppCallEvent[] = [];
  const spoken: string[] = [];
  let release!: () => void;
  const rest = new Promise<void>((r) => { release = r; });
  const session = new AudiocppCallSession({
    callId: 'call_stream', botId: 'bot_x', voice: 'v',
    options: { fillerDelayMs: 60_000 },
    deps: {
      transcribe: async () => 'what is up',
      relayStream: () => (async function* () {
        yield { text: 'Not much. Still', final: false };
        await rest; // the model is still writing
        yield { text: 'Not much. Still working on the quarterly report, which should be finished by Friday afternoon at the latest.', final: true };
      })(),
      speech: (text) => (async function* () { spoken.push(text); yield { pcm: new Int16Array(24), rate: 24000 }; })(),
      onEvent: (e) => events.push(e),
    },
  });
  feed(session, utterance(200, 600, 900));
  await waitFor(events, 'reply');
  for (let i = 0; i < 50 && !spoken.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(spoken, ['Not much.'], 'the first sentence is spoken before the reply is finished');
  release();
  await waitFor(events, 'done');
  session.close();
  assert.deepEqual(spoken, ['Not much.', 'Still working on the quarterly report, which should be finished by Friday afternoon at the latest.']);
  const replies = events.filter((e) => e.type === 'reply').map((e) => (e as { text: string }).text);
  assert.equal(replies.at(-1), 'Not much. Still working on the quarterly report, which should be finished by Friday afternoon at the latest.', 'captions are cumulative');
});

test('mute drops input and ends a half-heard utterance', async () => {
  const events: AudiocppCallEvent[] = [];
  let calls = 0;
  const session = new AudiocppCallSession({
    callId: 'call_t6', botId: 'bot_x', voice: 'v',
    deps: { transcribe: async () => { calls++; return 'x'; }, onEvent: (e) => events.push(e) },
  });
  feed(session, utterance(100, 500, 0));
  session.setMuted(true);
  feed(session, utterance(0, 500, 1000));
  await new Promise((r) => setTimeout(r, 50));
  session.close();
  assert.equal(calls, 0);
  assert.deepEqual(events.filter((e) => e.type === 'listening').map((e) => (e as { on: boolean }).on), [true, false]);
  assert.equal(events.at(-1)?.type, 'end');
});

// ---------- endpoint helpers ----------

test('readDownloadStatus reads the sidecar file and treats a silent "downloading" as failed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiocpp-models-'));
  try {
    assert.equal(endpoints.readDownloadStatus(dir), null);
    const file = path.join(dir, '.orbit-status.json');
    fs.writeFileSync(file, JSON.stringify({ state: 'downloading', pct: 42, file: 'x.gguf', updated_at: Date.now() }));
    assert.deepEqual(endpoints.readDownloadStatus(dir), { state: 'downloading', pct: 42, file: 'x.gguf' });
    fs.writeFileSync(file, JSON.stringify({ state: 'downloading', pct: 42, file: 'x.gguf', updated_at: Date.now() - 600_000 }));
    assert.equal(endpoints.readDownloadStatus(dir)?.state, 'error');
    fs.writeFileSync(file, '{"state":"bogus"}');
    assert.equal(endpoints.readDownloadStatus(dir), null);
    // The same parser reads the file through `docker exec` when the api cannot see the volume.
    assert.deepEqual(endpoints.parseDownloadStatus('{"state":"ready","pct":100,"file":null}\n'), { state: 'ready', pct: 100, file: null });
    assert.equal(endpoints.parseDownloadStatus(''), null);
    // The sidecar records why audio.cpp exited, for the settings to show.
    assert.equal(endpoints.parseDownloadStatus('{"state":"ready","pct":100,"file":null,"server_error":"GGUF has no model spec"}')?.serverError, 'GGUF has no model spec');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizePortrait turns any image into a 512x512 JPEG', async () => {
  const { loadSharp } = await import('../voice-audiocpp-session.js');
  const sharp = await loadSharp();
  const png = await sharp({ create: { width: 900, height: 600, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 0.5 } } }).png().toBuffer();
  const jpeg = await endpoints.normalizePortrait(png);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
  await assert.rejects(endpoints.normalizePortrait(Buffer.from('not an image')));
});

// ---------- live: a real audio.cpp server ----------

const live = await audiocpp.audiocppReady(1500);
const models = live.ok ? await audiocpp.audiocppModels().catch(() => []) : [];
const has = (id: string) => models.some((m) => m.id === id);
const skipLive = live.ok ? false : `no audio.cpp server at ${process.env.AUDIOCPP_URL ?? 'http://127.0.0.1:8080'}`;

function fixturePcm(name: string): Int16Array {
  return audiocpp.wavToPcm16(fs.readFileSync(new URL(name, FIXTURES))).pcm;
}

test('live: OWSM transcribes the command fixture', { skip: skipLive || (!has(audiocpp.AUDIOCPP_MODELS.asr) && 'no ASR model') }, async () => {
  const r = await audiocpp.transcribe(fixturePcm('en-command.wav'));
  console.log(`  OWSM: "${r.text}" in ${r.ms} ms for ${r.audioMs} ms of audio`);
  assert.match(r.text.toLowerCase(), /kitchen lights/);
});

test('live: LFM3 streams 24 kHz speech', { skip: skipLive || (!has(audiocpp.AUDIOCPP_MODELS.tts) && 'no TTS model') }, async () => {
  const t0 = Date.now();
  let first = 0;
  const out = [];
  for await (const c of audiocpp.streamSpeech('Testing one two three.', 'british_english_male')) {
    if (!first) first = Date.now() - t0;
    out.push(c);
  }
  const samples = out.reduce((n, c) => n + c.pcm.length, 0);
  console.log(`  LFM3: first audio ${first} ms, ${(samples / 24000).toFixed(2)} s of speech`);
  assert.ok(out.every((c) => c.rate === 24000));
  assert.ok(samples > 24000 * 0.8, 'about a second of speech or more');
});

test('live: the speaking-avatar recipe yields synced audio and rgb24 video', { skip: skipLive || (!has(audiocpp.AUDIOCPP_MODELS.avatar) && 'no avatar model') }, async () => {
  const { loadSharp } = await import('../voice-audiocpp-session.js');
  const sharp = await loadSharp();
  // A synthetic face-sized image is enough for the pipeline (SoulX animates whatever it is given).
  const portrait = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 180, g: 140, b: 120 } } }).jpeg().toBuffer();
  const remote = await audiocpp.uploadToServer(portrait, 'orbit-test-portrait.jpg');
  const local = path.join(os.tmpdir(), 'orbit-test-portrait.jpg');
  if (!remote) fs.writeFileSync(local, portrait);
  const t0 = Date.now();
  let firstVideo = 0;
  let samples = 0;
  let frames = 0;
  let fps = 0;
  for await (const item of audiocpp.streamSpeakingAvatar('Hello there.', 'american_english_female', remote ?? local)) {
    if (item.kind === 'audio') samples += item.pcm.length;
    else {
      if (!firstVideo) firstVideo = Date.now() - t0;
      frames += item.frames;
      fps = item.fps;
      assert.equal(item.rgb.length, item.width * item.height * 3 * item.frames);
    }
  }
  console.log(`  SoulX: first video ${firstVideo} ms, ${frames} frames @ ${fps} fps for ${(samples / 24000).toFixed(2)} s of speech`);
  assert.ok(frames > 0, 'video frames arrived');
  // Video covers the speech to within one chunk.
  assert.ok(Math.abs(frames / fps - samples / 24000) < 1, 'audio and video durations agree');
});
