# Local STT/TTS — implementation status

Branch `feat/local-voice`. Plan source: `Local STTTTS — Implementation Plan.md`. Measured facts and the
binding contracts are in `docs/voice-local-conventions.md`; this file is what was verified, what was
not, and what a reviewer should look at first.

## Verified, with the evidence

| Flow | Evidence |
| --- | --- |
| Batch dictation over HTTP | live server: `POST /api/voice/local/stt` with the command clip's PCM → `SWITCH ON THE KITCHEN LIGHTS AND TELL ME THE WEATHER` in 146 ms (2 383 ms of audio, ~16× real-time) |
| Voice preview | `POST /api/voice/local/preview` → 50 944 samples at 22 050 Hz (`X-Audio-Rate` header), peak 0.661, RMS 0.102; transcribing that audio back returns the sentence |
| UI: models present | built bundle + real server: `On-device · Ready` in the Voice chat section; Preview fires only `/api/voice/local/preview` (no cloud call) |
| UI: first run | empty model dir: `Not downloaded (0 of 263 MB)` + `Download on-device models · 263 MB`; clicking it downloaded all 250 files and the row flipped to `Ready` (~20 s) |
| Live call, echo relay | streamed the fixture over `WS /api/voice/local/call/:id`: partials, final transcript, `thinking`, 21–23 × 100 ms PCM frames (2.0–2.3 s, peak 0.64–0.70), `speaking:false`, `done` |
| Live call, real agent | real managed Hermes gateway (DeepSeek): transcript → `thinking` → gateway up → 50 s agent turn → `speaking` → 286 KB of PCM → `done`. The DB shows the relay's voice-attributed user row and the assistant's answer that was spoken |
| Barge-in | speech during the reply emits `speaking:false` and zero frames afterwards; the interruption (LibriSpeech clip) is transcribed at similarity 0.946 |
| Auth | 401 without a session; 404 for an unknown/claimed call id; 403 for someone else's bot (socket closes) |
| Docker | image built; `require('sherpa-onnx-node')` succeeds inside it (`gcompat` + `libstdc++`); types report `addon:true` |
| Regression suite | server 148/148, stable over three consecutive runs; web 22 `tsx --test` + 59 vitest |

Measured latency (2 threads, this Mac): STT first partial 25–53 ms, STT 17–24× real-time once warm,
TTS first audio 183–252 ms after the transcript, TTS 10–17× real-time, VAD 325× real-time, endpoint
~0.9 s after speech stops (500 ms backstop + VAD's 350 ms).

**Cold start is slower**: the first decode after the engine loads runs at ~7.5× real-time (520 ms for
3.9 s of audio) instead of ~20×, because ONNX Runtime has not warmed its kernels. Absolute latency is
still fine, but the first utterance after a fresh server boot is roughly twice as slow as the numbers
above; a warm-up decode in `getRecognizer()` would remove it if it ever matters.

## Built but not exercised here

- **A real microphone and the browser `AudioWorklet`.** The client path is unit-tested (resampler,
  PCM conversion, store transitions) and driven in a fake-Web-Audio harness, but no real mic was used.
  The first manual test should be: open a bot → Voice chat → Start voice chat → speak a sentence.
- **macOS native stack (`NativeStackController`).** The engine works under Electron-as-node only if the
  addon is in the shipped server bundle. `apps/desktop` packaging was not touched; the Docker stack is
  the path that was verified.
- **Linux CUDA.** Not possible with this npm package: the prebuilt `sherpa-onnx-linux-*` binaries carry
  no CUDA execution provider (zero matching strings), so `provider` is `cpu` on every platform.

## Known limitations

- The bilingual streaming model mishears the first word of a synthetic `say` clip depending on padding
  ("SWITCH" ↔ "ON"). Real speech (LibriSpeech) is fine. Tests gate real speech at 0.9 and keep the
  synthetic clip's 0.9 gate only on the batch path, where padding is fixed and it measures 1.000.
- The session's relay is a single blocking turn: while the bot is thinking (50 s in the live run) the
  caller hears nothing but the `thinking` state; there is no filler phrase and no timeout message
  until 120 s.
- Piper's duration predictor is stochastic: the same sentence produces 1.9–2.3 s of audio, so length
  assertions are bands.
- Voice picker (Phase 3 'model menu'), per-bot `voiceProvider` persistence, mobile, and Kokoro quality
  tier are **not implemented** — the plan's Phase 3.

## Files

New: `voice-runtime.ts`, `voice-models.ts`, `voice-model-files.ts` (generated), `voice-local.ts`,
`voice-local-session.ts`, `types/sherpa-onnx-node.d.ts`, `apps/web/src/voice/{local-call,resample}.ts`,
`apps/web/src/lib/{voice-pcm,voice-resample}.test.ts`, two test files, fixtures, this doc and the
conventions doc, `scripts/voice-models-manifest.mjs`.

Changed: `voice.ts` (one mount), `env.ts` (`VOICE_MODELS_DIR`), `index.ts` (one attach line),
`apps/server/Dockerfile` (two apk packages), `packages/contracts/src/index.ts` (additive types),
`apps/web/src/voice/{api,dictation,call}.ts`, `VoiceSettings.tsx`, `apps/server/package.json` +
lockfile (`sherpa-onnx-node@1.13.8`).

`pnpm --filter @orbit/server test` needs the models: `VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models`
(or a cache the app downloads from the UI). Without them the model tests skip instead of failing.
