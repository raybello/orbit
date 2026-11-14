// Composer dictation: hold the mic to talk (or tap to start, tap again to stop).
// Two capture paths, same semantics and callbacks:
//   • on-device — when the server can run local STT and its model is downloaded, capture PCM with
//     MicCapture and POST it to /local/stt. No MediaRecorder, no compressed audio over the wire.
//   • cloud    — otherwise the original MediaRecorder → /stt proxy path, untouched.
import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceApi } from './api';
import { MicCapture, RATE, createAudioContext, micErrorMessage, openMic } from './audio';

export type DictationState = 'idle' | 'recording' | 'transcribing';

const HOLD_MS = 350;
const MIN_MS = 250;
const MAX_MS = 120_000;

/**
 * Concatenate float samples into one PCM16 LE buffer, clamping to [-1, 1]. Pure: no DOM, no
 * AudioContext, so the clamp and byte math are unit-testable in plain Node.
 */
export function floatToPcm16(chunks: Float32Array[], length = chunks.reduce((n, c) => n + c.length, 0)): Int16Array {
  const out = new Int16Array(length);
  let i = 0;
  for (const c of chunks) {
    for (let j = 0; j < c.length && i < length; j++, i++) {
      const v = c[j];
      const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
      out[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }
    if (i >= length) break;
  }
  return out;
}

/** On-device dictation needs the STT model on disk *and* the native addon loaded. */
async function hasLocalStt(): Promise<boolean> {
  try {
    const s = await voiceApi.localStatus();
    // `available` means "everything is ready" on the current server; the addon flag is the runtime check.
    return s.models.stt === 'ready' && (s.available || s.runtime.addon);
  } catch {
    return false; // no local voice endpoint (old server, offline): cloud path
  }
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return undefined;
}

interface BaseRec { downAt: number; cancelled: boolean; timer: ReturnType<typeof setTimeout> }
interface CloudRec extends BaseRec { kind: 'cloud'; mr: MediaRecorder; stream: MediaStream; chunks: Blob[] }
interface LocalRec extends BaseRec { kind: 'local'; ctx: AudioContext; stream: MediaStream; mic: MicCapture | null; chunks: Float32Array[]; samples: number }
type Rec = CloudRec | LocalRec;

export function useDictation(onText: (text: string) => void, onError: (msg: string) => void, language?: string) {
  const [state, setState] = useState<DictationState>('idle');
  const rec = useRef<Rec | null>(null);
  const starting = useRef(false);
  const toggleMode = useRef(false);
  const cb = useRef({ onText, onError, language });
  cb.current = { onText, onError, language };

  const stopLocal = useCallback(async (r: LocalRec) => {
    r.mic?.stop();
    rec.current = null;
    toggleMode.current = false;
    const pcm = floatToPcm16(r.chunks, r.samples);
    const ms = (pcm.length / RATE) * 1000;
    const close = () => { if (r.ctx.state !== 'closed') void r.ctx.close().catch(() => {}); };
    if (r.cancelled || !pcm.length || ms < MIN_MS) { setState('idle'); close(); return; }
    setState('transcribing');
    try {
      const text = await voiceApi.transcribeLocal(pcm, RATE);
      if (text) cb.current.onText(text);
    } catch (e) {
      cb.current.onError((e as Error).message || 'Transcription failed');
    } finally {
      setState('idle');
      close();
    }
  }, []);

  const finish = useCallback((cancel = false) => {
    const r = rec.current;
    if (!r) return;
    r.cancelled = cancel;
    clearTimeout(r.timer);
    if (r.kind === 'cloud') {
      if (r.mr.state !== 'inactive') r.mr.stop();
      else r.stream.getTracks().forEach((t) => t.stop());
    } else {
      void stopLocal(r);
    }
  }, [stopLocal]);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    starting.current = true;
    // Created here, before any await, so autoplay policy lets it run. The cloud path closes it.
    const ctx = createAudioContext();
    const downAt = Date.now();
    try {
      if (await hasLocalStt()) {
        const stream = await openMic();
        const r: LocalRec = { kind: 'local', ctx, stream, mic: null, chunks: [], samples: 0, downAt, cancelled: false, timer: setTimeout(() => finish(), MAX_MS) };
        rec.current = r;
        // MicCapture hands back PCM16 at RATE; keep the samples as floats so one clamped packer
        // (floatToPcm16) builds the buffer the server gets.
        r.mic = new MicCapture(ctx, stream, (frame) => {
          if (r.cancelled) return;
          const f = new Float32Array(frame.length);
          for (let i = 0; i < frame.length; i++) f[i] = frame[i] / 0x8000;
          r.chunks.push(f);
          r.samples += f.length;
        });
        await r.mic.start();
        if (r.cancelled) return; // released or unmounted while the worklet loaded
        setState('recording');
        return;
      }

      void ctx.close().catch(() => {}); // cloud path: MediaRecorder does the capture
      if (typeof MediaRecorder === 'undefined') { cb.current.onError('Dictation isn’t supported in this browser.'); return; }
      const stream = await openMic();
      const mime = pickMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const r: CloudRec = { kind: 'cloud', mr, stream, chunks: [], downAt, cancelled: false, timer: setTimeout(() => finish(), MAX_MS) };
      rec.current = r;
      mr.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
        toggleMode.current = false;
        if (r.cancelled || !r.chunks.length || Date.now() - r.downAt < MIN_MS) { setState('idle'); return; }
        setState('transcribing');
        try {
          const text = await voiceApi.transcribe(new Blob(r.chunks, { type: mr.mimeType || mime || 'audio/webm' }), cb.current.language);
          if (text) cb.current.onText(text);
        } catch (e) {
          cb.current.onError((e as Error).message || 'Transcription failed');
        } finally {
          setState('idle');
        }
      };
      mr.start(250);
      setState('recording');
    } catch (e) {
      // Whatever got as far as a recorder or a stream must not leak.
      const r = rec.current;
      if (r) {
        r.cancelled = true;
        clearTimeout(r.timer);
        if (r.kind === 'local') { r.mic?.stop(); if (r.ctx.state !== 'closed') void r.ctx.close().catch(() => {}); }
        else r.stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
      } else if (ctx.state !== 'closed') {
        void ctx.close().catch(() => {});
      }
      cb.current.onError(micErrorMessage(e));
      setState('idle');
    } finally {
      starting.current = false;
    }
  }, [finish]);

  // Pointer handlers: press-and-hold records until release; a quick tap toggles recording on, tap again stops.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (rec.current && toggleMode.current) { finish(); return; }
    void begin();
  }, [begin, finish]);

  const onPointerUp = useCallback(() => {
    const r = rec.current;
    if (!r) {
      // Still waiting on the permission prompt: treat as a tap.
      if (starting.current) toggleMode.current = true;
      return;
    }
    if (toggleMode.current) return;
    if (Date.now() - r.downAt < HOLD_MS) toggleMode.current = true; // tap: keep recording
    else finish();
  }, [finish]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (rec.current) finish();
    else { toggleMode.current = true; void begin(); }
  }, [begin, finish]);

  // Esc cancels; unmount stops.
  useEffect(() => {
    if (state !== 'recording') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [state, finish]);
  useEffect(() => () => finish(true), [finish]);

  return { state, onPointerDown, onPointerUp, onKeyDown, cancel: () => finish(true) };
}
