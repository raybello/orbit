import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalPreviewResponse, LOCAL_TTS_RATE } from '../voice/api.js';
import { floatToPcm16 } from '../voice/dictation.js';

// Pure helpers for the on-device voice path: the float→PCM16 packer the dictation recorder uses,
// and the `X-Audio-Rate` parse for a local preview. No browser, no jsdom.

test('floatToPcm16 clamps values above 1 and below -1', () => {
  const pcm = floatToPcm16([new Float32Array([2, 1.5, 1, 0.5, 0, -0.5, -1, -1.5, -3])]);
  assert.deepEqual([...pcm], [32767, 32767, 32767, 16384, 0, -16384, -32768, -32768, -32768]);
});

test('floatToPcm16 keeps one sample per input sample and two bytes per sample', () => {
  const pcm = floatToPcm16([new Float32Array(1000), new Float32Array(250)]);
  assert.equal(pcm.length, 1250);
  assert.equal(pcm.byteLength, 2500);
});

test('floatToPcm16 concatenates chunks in order and stops at the requested length', () => {
  const pcm = floatToPcm16([new Float32Array([0.5, -0.5]), new Float32Array([0.25])], 2);
  assert.equal(pcm.length, 2);
  assert.deepEqual([...pcm], [16384, -16384]);
});

test('floatToPcm16 honours an explicit length longer than the samples given', () => {
  // The recorder can hand over a sample count taken before the final frame landed; the tail is silence.
  const pcm = floatToPcm16([new Float32Array([1])], 4);
  assert.equal(pcm.length, 4);
  assert.deepEqual([...pcm], [32767, 0, 0, 0]);
});

test('the preview parser reads the real rate from X-Audio-Rate', () => {
  const body = new Int16Array([1, -2, 3]);
  const { pcm, rate } = parseLocalPreviewResponse(new Headers({ 'X-Audio-Rate': '22050' }), body.buffer);
  assert.equal(rate, 22050);
  assert.deepEqual([...pcm], [1, -2, 3]);
});

test('the preview parser falls back to the Piper rate when the header is missing or nonsense', () => {
  const body = new Int16Array([7]).buffer;
  assert.equal(parseLocalPreviewResponse(new Headers(), body).rate, LOCAL_TTS_RATE);
  assert.equal(parseLocalPreviewResponse(new Headers({ 'X-Audio-Rate': 'nope' }), body).rate, LOCAL_TTS_RATE);
  assert.equal(parseLocalPreviewResponse(new Headers({ 'X-Audio-Rate': '0' }), body).rate, LOCAL_TTS_RATE);
});

test('the preview parser drops a trailing odd byte instead of throwing', () => {
  const { pcm } = parseLocalPreviewResponse(new Headers({ 'X-Audio-Rate': '22050' }), new Uint8Array([1, 0, 2]).buffer);
  assert.equal(pcm.length, 1);
  assert.equal(pcm[0], 1);
});
