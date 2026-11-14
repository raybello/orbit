// Pure PCM helpers for the on-device call path. No DOM, no AudioContext: everything here runs in
// plain Node so the resampler's length, amplitude and clamp behaviour is unit-testable.
//
// MicCapture hands back PCM16 at `audio.RATE` (24 kHz — the worklet box-filters 48 kHz down to it).
// The local call session takes 16 kHz mono, so each frame goes Int16 → Float32 → resample → PCM16.

/** What `POST /api/voice/local/session` asks for, and what the socket expects on the wire. */
export const LOCAL_IN_RATE = 16000;

const EMPTY = new Float32Array(0);

/**
 * Linear-interpolation resample of a mono float buffer to 16 kHz. Stateless: the output is exactly
 * `floor(samples.length * 16000 / rate)` samples long and 16 kHz input is returned untouched, which
 * makes it an identity at the native rate.
 */
export function resampleTo16k(samples: Float32Array, rate: number): Float32Array {
  if (!samples.length) return EMPTY;
  if (!Number.isFinite(rate) || rate <= 0) return EMPTY;
  if (rate === LOCAL_IN_RATE) return samples.slice();
  const step = rate / LOCAL_IN_RATE;
  const out = new Float32Array(Math.floor(samples.length / step));
  for (let i = 0; i < out.length; i++) {
    const p = i * step;
    const i0 = p | 0;
    const t = p - i0;
    const a = samples[i0];
    out[i] = t === 0 || i0 + 1 >= samples.length ? a : a + (samples[i0 + 1] - a) * t;
  }
  return out;
}

/** Float samples → PCM16 LE, clamping outside [-1, 1] and mapping -1 to -32768 (as audio.ts does). */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const c = v > 1 ? 1 : v < -1 ? -1 : v;
    out[i] = Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
  }
  return out;
}

/**
 * The same linear resampler, but continuous across chunks: it carries the fractional read position
 * (and the one input sample the next output needs) between calls, so a long call neither drifts nor
 * clicks at frame boundaries. `resampleTo16k` is the stateless per-buffer version used by tests.
 */
export class StreamResampler {
  private carry: Float32Array = EMPTY;
  private pos = 0;

  constructor(private readonly outRate = LOCAL_IN_RATE) {}

  reset() {
    this.carry = EMPTY;
    this.pos = 0;
  }

  process(chunk: Float32Array, inRate: number): Float32Array {
    if (!chunk.length) return EMPTY;
    if (!Number.isFinite(inRate) || inRate <= 0) return EMPTY;
    if (inRate === this.outRate) return chunk;
    const step = inRate / this.outRate;
    const input = this.carry.length ? concat(this.carry, chunk) : chunk;
    // Only emit outputs whose interpolation partner is already in hand; the rest waits in `carry`.
    const n = Math.max(0, Math.floor((input.length - 1 - this.pos) / step) + 1);
    const out = new Float32Array(n);
    let p = this.pos;
    for (let i = 0; i < n; i++, p += step) {
      const i0 = p | 0;
      const t = p - i0;
      out[i] = t === 0 ? input[i0] : input[i0] + (input[i0 + 1] - input[i0]) * t;
    }
    const consumed = Math.min(Math.floor(p), input.length);
    this.carry = input.slice(consumed);
    this.pos = p - consumed;
    return out;
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
