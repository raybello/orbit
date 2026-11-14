import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamResampler, resampleTo16k, toPcm16 } from '../voice/resample.js';
import { startLocalSession } from '../voice/api.js';

// The local call path resamples the mic before it hits the socket (24 kHz → 16 kHz) and packs the
// result as PCM16. Pure functions only: no browser, no jsdom, no AudioContext.

const sine = (rate: number, hz: number, amp: number, seconds = 1) => {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
};

const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

test('resampleTo16k is an identity at 16 kHz', () => {
  const input = sine(16000, 440, 0.5, 0.1);
  const out = resampleTo16k(input, 16000);
  assert.equal(out.length, input.length);
  assert.deepEqual(Array.from(out), Array.from(input));
});

test('resampleTo16k returns the documented length for each capture rate', () => {
  // MicCapture delivers 24 kHz frames of 960 samples (40 ms); one frame must become 640 samples.
  assert.equal(resampleTo16k(sine(24000, 440, 0.5, 0.04), 24000).length, 640);
  assert.equal(resampleTo16k(sine(48000, 440, 0.5, 0.1), 48000).length, 1600);
  assert.equal(resampleTo16k(sine(44100, 440, 0.5, 0.1), 44100).length, 1600);
  // An odd length still lands on floor(n / step) rather than throwing.
  assert.equal(resampleTo16k(new Float32Array(961), 24000).length, 640);
});

test('a 48 kHz sine keeps its amplitude within 2% at 16 kHz', () => {
  const input = sine(48000, 440, 0.5);
  const out = resampleTo16k(input, 48000);
  const p = peak(out);
  const r = rms(out);
  assert.ok(Math.abs(p - peak(input)) / 0.5 < 0.02, `peak ${p.toFixed(5)} vs 0.5`);
  assert.ok(Math.abs(r - rms(input)) / rms(input) < 0.02, `rms ${r.toFixed(5)} vs ${rms(input).toFixed(5)}`);
});

test('resampleTo16k preserves DC', () => {
  for (const rate of [48000, 44100, 24000]) {
    const out = resampleTo16k(new Float32Array(480).fill(0.25), rate);
    assert.ok(out.length > 0);
    for (const v of out) assert.ok(Math.abs(v - 0.25) < 1e-6, `${rate} Hz DC drifted to ${v}`);
  }
});

test('resampleTo16k handles empty and nonsense input without NaN', () => {
  assert.equal(resampleTo16k(new Float32Array(0), 48000).length, 0);
  assert.equal(resampleTo16k(new Float32Array(64), 0).length, 0);
  assert.equal(resampleTo16k(new Float32Array(64), Number.NaN).length, 0);
  assert.equal(resampleTo16k(new Float32Array(1), 48000).length, 0);
});

test('StreamResampler carries its fractional position across frames', () => {
  const frames: Float32Array[] = [];
  const whole = sine(24000, 1000, 0.5, 0.4);
  for (let i = 0; i + 960 <= whole.length; i += 960) frames.push(whole.subarray(i, i + 960));
  const stream = new StreamResampler();
  const parts = frames.map((f) => stream.process(f, 24000));
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { joined.set(p, at); at += p.length; }
  // The one-shot resampler is the same linear grid, so chunking must not change a single sample.
  const oneShot = resampleTo16k(whole.subarray(0, frames.length * 960), 24000);
  assert.equal(joined.length, oneShot.length);
  for (let i = 0; i < joined.length; i++) assert.ok(Math.abs(joined[i] - oneShot[i]) < 1e-6, `sample ${i} differs`);

  // Constant input is the drift check: 16 kHz out of 44.1 kHz in must not sag over 100 frames.
  const dc = new StreamResampler();
  for (let i = 0; i < 100; i++) {
    const out = dc.process(new Float32Array(441).fill(0.75), 44100);
    for (const v of out) assert.ok(Math.abs(v - 0.75) < 1e-6, `DC drifted to ${v}`);
  }
});

test('toPcm16 clamps and keeps one sample per input sample', () => {
  const pcm = toPcm16(new Float32Array([2, 1.5, 1, 0.5, 0, -0.5, -1, -1.5, -3]));
  assert.deepEqual(Array.from(pcm), [32767, 32767, 32767, 16384, 0, -16384, -32768, -32768, -32768]);
  const big = toPcm16(new Float32Array(1000));
  assert.equal(big.length, 1000);
  assert.equal(big.byteLength, 2000);
});

test('toPcm16 maps NaN to silence instead of garbage', () => {
  const pcm = toPcm16(new Float32Array([Number.NaN, 0.25]));
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], Math.round(0.25 * 0x7fff));
});

// The session POST is the other half of the wire contract; stub fetch so the URL and body are checked
// without a server (plain Node, no DOM).
function stubFetch(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('startLocalSession posts the botId and returns the socket sample rates', async () => {
  const s = stubFetch({ callId: 'call-1', sampleRate: 16000, ttsSampleRate: 22050 });
  try {
    const sess = await startLocalSession('bot-1');
    assert.deepEqual(sess, { callId: 'call-1', sampleRate: 16000, ttsSampleRate: 22050 });
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].url, '/api/voice/local/session');
    assert.equal(s.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(s.calls[0].init.body)), { botId: 'bot-1' });
  } finally {
    s.restore();
  }
});

test('startLocalSession falls back to the documented rates and rejects a session with no callId', async () => {
  const ok = stubFetch({ callId: 'call-2' });
  try {
    assert.deepEqual(await startLocalSession('bot-2'), { callId: 'call-2', sampleRate: 16000, ttsSampleRate: 22050 });
  } finally {
    ok.restore();
  }
  const bad = stubFetch({ ok: true, callId: 42 });
  try {
    await assert.rejects(() => startLocalSession('bot-3'), /session was not created/);
  } finally {
    bad.restore();
  }
});
