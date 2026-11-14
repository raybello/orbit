# Local STT/TTS — Implementation Plan

## Overview

Replace Orbit's dependency on xAI's cloud STT/TTS APIs with fully local models running on the user's machine. The current voice pipeline (`apps/server/src/voice.ts`) mints an xAI realtime client secret and lets the browser connect directly to `wss://api.x.ai`. The new local pipeline runs STT and TTS as Node.js native addons on the server and uses a WebSocket protocol of our own.

**Goals**

- Zero cloud round-trip for audio — all processing stays on the user's device.
- Fast enough for real-time conversation: STT first-chunk under 300 ms, TTS first audio under 200 ms.
- Both features managed (download, upgrade, unload) by the Orbit desktop app itself.
- Existing xAI realtime call path stays as a fallback when no compatible GPU is detected at startup.
- GPU-only: Metal/CoreML on all Apple Silicon Macs (native stack) and NVIDIA CUDA on Linux Docker. CPU-only machines fall back to xAI automatically — no models downloaded, no degraded latency.

---

## Model Selection

### STT — sherpa-onnx streaming Zipformer

**Package:** `sherpa-onnx-node` (npm)\
**Model:** `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` (\~40 MB)\
**Why:** sherpa-onnx-node is the only npm package that ships native bindings for both streaming ASR *and* streaming TTS in a single install. The 20M Zipformer variant runs online (chunk-by-chunk) so words appear as the user speaks, not after they stop. On Apple Silicon the ONNX Runtime back-end reaches 30–50× real-time, putting per-chunk latency well under 100 ms.

Alternative if accuracy matters more than speed: `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` or `whisper.cpp tiny.en` via `nodejs-whisper`. The Zipformer 20M is recommended for the first implementation.

### TTS — sherpa-onnx + Piper (en\_US-lessac-medium)

**Package:** `sherpa-onnx-node` (same install as STT)\
**Model:** Piper `en_US-lessac-medium.onnx` + `en_US-lessac-medium.onnx.json` (\~63 MB)\
**Why:** Piper via ONNX is the fastest local TTS option in independent 2026 benchmarks, synthesising roughly 30× faster than real-time on CPU. Time-to-first-audio on Apple Silicon is under 50 ms for a short sentence. The lessac-medium voice is natural-sounding and licensed CC0. Kokoro-82M is higher quality but requires Python/mlx-audio and is slower to first audio (\~3.6 s FTTS in benchmarks); it can be added as a premium option in a later phase.

**Voice library for future phases:** sherpa-onnx also ships Kokoro ONNX, MeloTTS, and Coqui VITS voices, so a voice picker needs no second runtime.

---

## Architecture

### Current (xAI realtime)

```
Browser ──────── POST /api/voice/session ──────────── Server
  │                 (mints xAI client secret)              │
  └── WebSocket wss://api.x.ai/v1/realtime ──────── xAI cloud
                     (STT + VAD + LLM + TTS all in cloud)
```

### New (local)

```
Browser ──── POST /api/voice/local/session ───────── Server
  │             (creates LocalCallSession)                 │
  └── WebSocket /api/voice/local/call/:callId ──── LocalCallSession
       │  PCM audio frames (20 ms chunks, 24 kHz mono)        │
       │                                              sherpa-onnx VAD
       │                                              sherpa-onnx STT  ← 20M Zipformer
       │                                              enqueue() (agent loop)
       │                                              sherpa-onnx TTS  ← Piper lessac
       └─ PCM audio frames (streamed back as words arrive)
```

The browser side gains a `LocalCall` class (parallel to the existing `VoiceCall`) in `apps/web/src/voice/`. The server gains a `voice-local.ts` module with its own Hono sub-router mounted at `/api/voice/local`.

The native stack (`apps/desktop/src/native-stack.ts`) downloads models on first use and stores them in `{userData}/voice-models/`. The Docker stack shares the same server binary; on startup the server probes for a CUDA execution provider. If none is found, gpuAvailable is false and all /local/\* endpoints return { available: false }, causing the browser to fall back to xAI. No models are downloaded on CPU-only machines.

---

## GPU Detection

The server probes for acceleration at startup in `voice-gpu.ts` and exports `gpuAvailable: boolean` and `gpuProvider: 'coreml' | 'cuda' | 'none'`.

**Apple Silicon (native stack):** ONNX Runtime ships a `CoreMLExecutionProvider` that runs on the Neural Engine of every M-series chip. `gpuAvailable` is always `true` on the native stack — no probe needed.

**Linux with NVIDIA GPU (Docker stack):** The server spawns `nvidia-smi --query-gpu=name --format=csv,noheader` at startup. Exit code 0 with at least one GPU name → `gpuProvider = 'cuda'`, `CUDAExecutionProvider` is passed to sherpa-onnx. Any other result → `gpuAvailable = false`.

**When `gpuAvailable` is `false`:**

- `GET /api/voice/local/status` returns `{ available: false, reason: 'no-gpu' }`.
- All other `/local/*` endpoints return the same without loading sherpa-onnx.
- The browser treats this identically to "models not downloaded" and uses the xAI realtime path.
- No model files are downloaded, saving disk space on CPU-only machines.

---

## Phase 1 — Local Dictation and TTS Preview

**Goal:** swap the two simplest endpoints (`POST /api/voice/stt` and `POST /api/voice/preview`) to use local models. No change to the realtime call path yet.

### Steps

1. **Add GPU detection first.** Create `apps/server/src/voice-gpu.ts`. On macOS arm64 set `gpuProvider = 'coreml'` unconditionally. On Linux, spawn `nvidia-smi` and inspect exit code. Export `gpuAvailable` and `gpuProvider`. Import this in `voice-local.ts` as the very first thing — if `gpuAvailable` is false, register the router but have every handler return `{ available: false, reason: 'no-gpu' }` without touching sherpa-onnx.
2. **Add `sherpa-onnx-node` to `apps/server/package.json`.**  The package ships prebuilt binaries for macOS arm64, macOS x64 and Linux x64 — no compile step.
3. **Create `apps/server/src/voice-models.ts`** — model manager.
   - `ensureModel(name, urls, destDir)`: checks SHA-256, downloads if missing, emits `model:progress` events on a shared EventEmitter.
   - `modelState(name)`: `'missing' | 'downloading' | 'ready'`.
   - Models live in `process.env.VOICE_MODELS_DIR ?? path.join(process.env.DATA_DIR ?? './data', 'voice-models')`.
4. **Create `apps/server/src/voice-local.ts`** with two endpoints:
   - `POST /local/stt`: accepts a `multipart/form-data` audio blob (same shape as the existing `/stt`). Runs `OfflineRecognizer` from sherpa-onnx-node. Returns `{ text }`. Falls back to the xAI STT if the model is not ready.
   - `POST /local/preview`: accepts `{ text, voice?, speed? }`. Runs `OfflineTts` from sherpa-onnx-node with the Piper model. Returns raw PCM at 24 kHz. Falls back to xAI TTS.
5. **Mount the new router** in `apps/server/src/index.ts` at `/api/voice/local`.
6. **Update `apps/web/src/voice/api.ts`** to prefer `/local/stt` and `/local/preview` when `GET /api/voice/local/status` reports both models ready.
7. **Add a `GET /local/status` endpoint** that returns `{ stt: ModelState, tts: ModelState }` and triggers a background model download the first time it is called on a native stack.

### Deliverables

- Dictation (`dictation.ts`) uses local STT — no network call.
- Voice preview button uses local TTS — no network call.
- Download progress visible in the voice settings panel.

---

## Phase 2 — Full Local Voice Calls

**Goal:** a complete voice call without any cloud dependency.

### New server: `LocalCallSession`

Each call is a `LocalCallSession` instance:

- **VAD:** sherpa-onnx `VoiceActivityDetector` (Silero VAD, bundled with the package). Detects speech start/end in 20 ms chunks.
- **STT:** sherpa-onnx `OnlineRecognizer` (streaming Zipformer). Text partial results are emitted per chunk; a final transcript is emitted on speech-end.
- **Agent relay:** calls `enqueue()` with the transcribed text, identical to `send_task` in the existing voice agent. Awaits the response string.
- **TTS:** sherpa-onnx `OfflineTts` with Piper. Synthesises the response text into PCM. For long responses, splits on sentence boundaries and streams each sentence immediately (time-to-first-audio ≈ 50 ms on the first sentence).
- **WebSocket protocol:** binary frames are raw PCM (Int16, 24 kHz, mono). JSON control frames (text messages) carry `{type}` events: `ready`, `transcript` (partial + final), `speaking`, `done`, `error`, `end`.

### New browser: `LocalCall`

Parallel to the existing `VoiceCall` class. Handles:

- `MediaStream` → `ScriptProcessorNode` / `AudioWorklet` → 20 ms PCM chunks → WebSocket binary frames.
- Incoming PCM frames → `AudioContext` scheduling (same `PcmPlayer` already used in `audio.ts`).
- Incoming JSON control frames → updates `useVoice` state store (same zustand store).
- Mute: drops mic chunks before sending.

### New settings

Per-bot setting `voiceProvider: 'cloud' | 'local'` (default `'cloud'` until local models are confirmed ready, then `'local'`). The settings panel shows a "Local (on-device)" option only when `GET /api/voice/local/status` returns both models ready. If models are still downloading, it shows a progress bar.

### Deliverables

- `POST /api/voice/local/session` — creates a `LocalCallSession`, returns `{ callId }`.
- `WebSocket /api/voice/local/call/:callId` — the streaming audio channel.
- `apps/web/src/voice/local-call.ts` — the browser-side `LocalCall` class.
- `apps/web/src/voice/call.ts` updated to dispatch to `LocalCall` or `VoiceCall` based on `voiceProvider`.
- Existing xAI realtime path **unchanged**.

---

## Phase 3 — Model Manager UI

**Goal:** let the user see, download and switch voice models from the Orbit UI.

### Steps

1. **`GET /api/voice/local/models`** — returns available model variants with sizes, download state and current selection.
2. **`POST /api/voice/local/models/:name/download`** — triggers a background download; progress is pushed over the existing SSE stream as `{ type: 'voice-model-progress', name, pct }` events.
3. **`POST /api/voice/local/models/:name/select`** — sets the active STT or TTS model for a given `kind`.
4. **Model picker in the voice settings panel** (web) — shows each model's name, size, latency tier (Fast / Best), and download state. A "Download" button, a progress bar, and a "Use this" toggle.

### Model menu (initial set)

| Kind | Name | Size | Speed | Quality |
| --- | --- | --- | --- | --- |
| STT | Zipformer 20M | 40 MB | Fastest | Good |
| STT | Zipformer 100M | 170 MB | Fast | Better |
| STT | Whisper tiny.en | 39 MB | Fast | Good |
| TTS | Piper lessac-medium | 63 MB | Fastest | Good |
| TTS | Piper lessac-high | 120 MB | Fast | Better |
| TTS | Kokoro ONNX | 310 MB | Medium | Best |

---

## File Map

| New / changed file | What changes |
| --- | --- |
| `apps/server/src/voice-models.ts` | New — model downloader and state tracker |
| `apps/server/src/voice-gpu.ts` | New — GPU detection (CoreML / CUDA / none), exports gpuAvailable |
| `apps/server/src/voice-local.ts` | New — local STT, TTS, and call session endpoints |
| `apps/server/src/voice.ts` | Add `voiceProvider` to bot settings; mount local router |
| `apps/server/src/types.ts` | Add `voiceProvider` to `Bot` type |
| `apps/server/src/env.ts` | Add `VOICE_MODELS_DIR` |
| `apps/web/src/voice/local-call.ts` | New — `LocalCall` browser class |
| `apps/web/src/voice/call.ts` | Dispatch to `LocalCall` or `VoiceCall` |
| `apps/web/src/voice/api.ts` | Add `localStatus()`, `startLocalSession()` |
| `apps/desktop/src/native-stack.ts` | Trigger model pre-download on stack start |
| `packages/contracts/src/index.ts` | Add `voiceProvider`, `VoiceModelInfo` types |

---

## Open Questions

1. **Docker + CUDA setup:** The Compose file needs `deploy.resources.reservations.devices` with the `nvidia` runtime to expose the GPU to the container. It also needs `DATA_DIR` on a named volume so downloaded model files survive container restarts. Does the current Compose file already bind `DATA_DIR` to a named volume, or does that volume mount need to be added?
2. **Mobile:** The Expo client currently has no voice call UI. When it gets one, should it use the server's local pipeline (audio streamed over WebSocket from the phone) or the xAI realtime path? The server-side approach avoids a second native dependency on mobile.
3. **Multi-language:** Zipformer 20M is English-only. When `voiceLanguage` is set to a non-English locale, the app should fall back to the xAI realtime path or offer a multilingual model (e.g. the bilingual zh/en Zipformer, or Whisper small).
4. **Interruption / barge-in:** The xAI realtime path handles barge-in natively. For the local path, barge-in means detecting speech from the VAD while TTS audio is playing, then cancelling the in-flight TTS and queuing the new STT result. This needs careful state management in `LocalCallSession` and is deferred to a follow-up.
5. **Kokoro quality tier:** Kokoro ONNX (Phase 3) gives noticeably better voice quality but its first-audio latency on a sentence is \~300 ms vs \~50 ms for Piper. For conversational use the speed difference is noticeable. Consider a hybrid: Piper for the first sentence, Kokoro for the rest.
