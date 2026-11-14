# Local STT/TTS — implementation status

Branch `feat/local-voice`. Plan source: `Local STTTTS — Implementation Plan.md`. Measured facts and the
binding contracts are in `docs/voice-local-conventions.md`; this file is what was verified, what was
not, and what a reviewer should look at first. Screenshots and the screen recording are in
`docs/evidence/`.

Voice runs on-device when the machine can do it and falls back to the xAI realtime path otherwise. There
are two TTS tiers (Piper by default, Kokoro as an opt-in quality tier), an English + Mandarin streaming
recogniser, Silero VAD, and a per-bot choice of pipeline and voice.

## Verified, with the evidence

| Flow | Evidence |
| --- | --- |
| Batch dictation over HTTP | live server: `POST /api/voice/local/stt` with the command clip's PCM → the exact sentence in 119–146 ms (2 383 ms of audio, ~17× real-time) |
| Voice preview | `POST /preview` → 50 944 samples at 22 050 Hz (`X-Audio-Rate`), peak 0.66, RMS 0.10; the audio transcribes back to the sentence it was told to say |
| Second TTS tier (Kokoro) | `/models` reports it `optional`, 359.7 MB, 24 000 Hz; once on disk `/preview` answers `x-audio-rate: 24000`, and a Kokoro bot's call emits `{ready, ttsSampleRate: 24000, model:'kokoro-multi-lang'}` with 4 800-byte frames — 2 400 samples, exactly 100 ms at 24 kHz |
| Model menu + per-bot choice | `/models` lists all four models with tier/state/size/rate; `PATCH /api/bots/:id {voiceProvider, voiceModel}` persists and `POST /api/bots` accepts both; the picker renders them with rate, size and an honest latency hint (screenshot `docs/evidence/03-voice-picker.png`) |
| Cold start removed | `warmUp()` at boot logs `recognizer 797 ms, voice 571 ms`; the first `/stt` after boot takes 133 ms instead of ~5 s |
| Live call, echo relay | real WebSocket: partials, final transcript, `thinking`, ~22 × 100 ms PCM frames, `speaking:false`, `done` |
| Live call, real agent | real managed Hermes gateway (DeepSeek): transcript → 50 s agent turn → 286 KB of spoken audio → `done`, with the voice-attributed row in the DB; the caller hears `One moment.` at +480 ms and one nudge at 20 s, then a spoken apology if the turn hits 90 s |
| Live call, real browser | Chrome for Testing drives the built app with a synthetic 48 kHz MediaStream as the microphone: captions stream into the call bar, `thinking` → `speaking` → `done`; `docs/evidence/call.gif` is that run |
| Barge-in | speech during the reply → `speaking:false` and zero frames afterwards; the interruption (real speech) transcribes at 0.946–0.957 |
| Endpointing | 0.9 s of trailing silence closes the turn with a complete transcript (500 ms backstop + the VAD's own 350 ms) |
| Recognition robustness | leading silence is normalised to 0.3 s: the synthetic fixture transcribes at 1.000 with client leads of 0/200/300/500/800/1000/1500/3000 ms (0.842 at 200 ms and 1.5 s before the fix) |
| Auth | 401 without a session; 404 for an unknown/claimed call id; 403 for someone else's bot (socket closed) |
| Docker (the desktop dev target) | image rebuilt on a glibc base: inside it `/status` → `addon:true, available:true`, `/stt` → exact sentence in 137 ms (17.4× warm; 9.8× cold in a separate bench), `/preview` → 22 050 Hz, `hermes --version` → v0.23.1 on CPython 3.14.10 |
| macOS native stack | `node scripts/verify-server-bundle.mjs <tar.xz \| dir>` prints a 7-point checklist and exits non-zero when the archive cannot carry local voice. Against a 33 MB bundle holding the real `sherpa-onnx-node@1.13.8` + `sherpa-onnx-darwin-arm64` it prints `PASS — local voice will work from this bundle (7 checks, 0 skipped)` and its `require` probe really dlopens the binary; without `node_modules` it prints `FAIL — 1 of 7 checks failed` and exits 1. `node --test scripts/verify-server-bundle.test.mjs` is 13/13 |
| Degraded path (no addon) | `voice-runtime-degraded.test.ts`, through the test-only `__setAddonLoaderForTests()` seam: `runtimeInfo().addon === false`, `/local/status` → `{available:false, reason:'unsupported-runtime'}`, `/stt` and `/preview` → 503, no download started, no crash. A second test restores the seam and proves the real path again |
| Regression suite | server 167/167 (three consecutive runs), web 31 `tsx --test` + 68 vitest, bundle checker 13/13 |

Measured latency, warm, 2 threads, this Mac: STT first partial 25–40 ms, STT 17–24× real-time, TTS first
audio 183–300 ms after the transcript, TTS 10–17× real-time, VAD 325× real-time.

## Not verified here

- **A physical microphone.** The browser path is exercised through the app's own `getUserMedia` →
  AudioWorklet → WebSocket chain at real device rates, but the last centimetre — a human speaking into a
  real mic — is not something this environment can do. First manual test: open a bot → Voice chat →
  On-device → Start voice chat → speak.
- **Kokoro by ear.** Its rate, frame size and latency are verified; whether it sounds better than Piper
  is a listener's judgement.
- **The published macOS server bundle.** The checker and the degraded path are verified; the archive
  itself is built elsewhere and must pass `verify-server-bundle.mjs` before it ships.
- **Mobile.** The Expo client still has no voice UI, so local calls are desktop-web only.

## Known limitations

- Kokoro runs at ~1× real-time on this CPU (2.5 s to synthesise a 2.7 s sentence): fine for answers, not
  for a conversational first word. Hence Piper is the default and the picker says "Best · slower".
- The recogniser covers English and Mandarin; other languages should fall back to the cloud path.
- While the agent works, the caller hears a filler and then a 20 s nudge; the wait itself is the agent's,
  not the voice stack's.
- Piper's duration predictor is stochastic (1.9–2.3 s for the same sentence), so tests assert bands plus
  a transcribe-it-back check rather than exact lengths.
- The glibc base makes the server image ~230 MB larger (852 MB vs 618 MB). That is the price of a
  working onnxruntime: under musl the addon loads but every session creation aborts.
- Linux CUDA is not possible with this npm package — the prebuilt `sherpa-onnx-linux-*` binaries carry no
  CUDA execution provider (zero matching strings), so `provider` is `cpu` everywhere.

## Files

New: `voice-runtime.ts`, `voice-models.ts`, `voice-model-files.ts` (generated), `voice-local.ts`,
`voice-local-session.ts`, `types/sherpa-onnx-node.d.ts`, `apps/web/src/voice/{local-call,resample}.ts`,
`apps/web/src/lib/{voice-pcm,voice-resample,voice-local-api}.test.ts`,
`apps/web/src/__tests__/VoiceSettings.test.tsx`, three server test files,
`apps/server/src/__tests__/fixtures/voice/`,
`scripts/{verify-server-bundle.mjs,verify-server-bundle.test.mjs,voice-models-manifest.mjs}`,
this doc, the conventions doc, `docs/evidence/`.

Changed: `voice.ts` (mount), `env.ts` (`VOICE_MODELS_DIR`), `index.ts` (WS relay + warm-up at boot),
`db.ts` (`voice_provider`, `voice_model`), `routes.ts` (create/PATCH mapping), `store.ts` (`toBot`),
`apps/server/Dockerfile` (glibc base), `packages/contracts` (Bot fields + voice types),
`apps/web/src/voice/{api,dictation,call,audio}.ts`, `VoiceSettings.tsx`, `infra/compose/*.yml`
(`VOICE_MODELS_DIR=/data/voice-models`), `apps/server/package.json` + lockfile
(`sherpa-onnx-node@1.13.8`).

Run the suites with the models present:

```bash
export VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models
pnpm --filter @orbit/server test     # 167 tests; the model tests skip without the cache
pnpm --filter @orbit/web test        # 31 tsx + 68 vitest
node --test scripts/verify-server-bundle.test.mjs
```
