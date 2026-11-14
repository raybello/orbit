# Local STT/TTS — measured baseline and implementation contracts

Everything below was measured on this machine (macOS 26.6.2, arm64, Node 22.23.2) or verified in
Docker (24.0.7, linux/arm64) while preparing this work. Treat it as the source of truth: the phase
plan in `Local STTTTS — Implementation Plan.md` is wrong about several of these and the agents must
not follow it where it disagrees with this file.

## Decisions that override the plan (with the evidence)

| Plan says | Reality | Decision |
| --- | --- | --- |
| `sherpa-onnx-node` latest | 2.0.1 **removed** the espeak-ng frontend: `vits.dataDir` is "deprecated and ignored", Piper synthesis fails with *"phoneme_codepoints is empty, no lexicon, and no frontend available"* | Pin **`sherpa-onnx-node@1.13.8`** (already in `apps/server/package.json`). It has the same prebuilt binaries and works. |
| STT: `streaming-zipformer-en-20M` (~40 MB) | That release drops the first ~1.5–2 s of every utterance (first token timestamp 2.04 s on its own `test_wavs/0.wav`; "Hello…" → "O THIS IS…"). Measured with both int8 and fp32 encoders and with both package versions. | Use **`sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`, int8 encoder/decoder/joiner**, 197 MB of ONNX + 56 KB tokens. It transcribes from 0.32 s, and its English accuracy on the fixtures is 1.0 (see below). Bonus: it is already zh+en. |
| TTS: `en_US-lessac-medium` | Works, but **22 050 Hz**, not 24 kHz | Keep Piper lessac-medium; the server reports the real rate and never resamples. |
| GPU detection: CoreML on Apple Silicon, CUDA in Docker | `provider: 'coreml'` **segfaults** the process on Piper VITS (exit 139) and makes streaming STT 3× *slower* (18.9× vs 56.5× real-time on CPU). The `sherpa-onnx-linux-*` prebuilt binaries contain **zero** CUDA strings — there is no CUDA execution provider in the npm package. | `provider: 'cpu'` everywhere. Report `accelerated: false` honestly; never claim CUDA. A GPU/CPU gate that disables local voice would disable it everywhere, including the desktop app, which runs this server. |
| Docker stack runs the same server, no image change | The image is `node:22-alpine` (musl). `require('sherpa-onnx-node')` fails there with `Error loading shared library ld-linux-aarch64.so.1`. | `apk add --no-cache gcompat libstdc++` in `apps/server/Dockerfile` — verified: the addon then loads inside `node:22-alpine`. |
| Models ~103 MB | STT 197 MB + TTS 63 MB + espeak-ng (English subset) 1.7 MB + VAD 0.6 MB = **263 MB**, 250 files | `apps/server/src/voice-model-files.ts` (generated, parent-owned) lists every file with size and HF LFS sha256. |
| Batch `/stt` over a multipart blob | There is no offline recognizer model in the set, and browsers give webm/opus which nothing here can decode | `/local/stt` takes **raw PCM16 LE mono** with an `X-Audio-Rate` header. Client decodes/resamples nothing: `MicCapture` already yields Float32; send `rate` and sherpa resamples internally. |

### Measured numbers (baseline for the latency budgets)

| What | Value |
| --- | --- |
| STT first partial (20 ms chunks, bilingual int8, 2 threads) | 25–36 ms |
| STT real-time factor | 23.6–24.3× |
| STT init (model load) | ~250 ms (int8, warm page cache) |
| TTS first audio chunk (`generateAsync` onProgress, per sentence) | 118–194 ms |
| TTS real-time factor | 17× (`generate`), ~14× (`generateAsync`) |
| TTS init | ~420 ms |
| VAD (silero) | 3.9 s audio in 12 ms; detects one segment 70 ms → 3904 ms |
| Round trip TTS→WAV→STT ("The quick brown fox…") | exact transcript |

**Padding recipe for batch transcription** (verified, this is not optional): prepend **0.3 s** of
silence and append **1.0 s** of silence before feeding the recognizer. Without the leading pad the
first word is lost ("SWITCH ON THE KITCHEN…" → "ON THE KITCHEN…"); without the trailing pad the last
word is truncated ("WEATHER" → "WEATH").

Accuracy of the chosen model on the fixtures, with that padding: `en-hello.wav` 1.00,
`en-command.wav` 1.00, `en-librispeech-long.wav` 0.957 (one spurious leading token). Regression
thresholds in the tests are set slightly below these (see the fixture manifest).

## Model cache layout

`VOICE_MODELS_DIR` (default `path.join(DATA_DIR ?? './data', 'voice-models')`) holds:

```
voice-models/
  stt/encoder-epoch-99-avg-1.int8.onnx
  stt/decoder-epoch-99-avg-1.int8.onnx
  stt/joiner-epoch-99-avg-1.int8.onnx
  stt/tokens.txt
  tts/en_US-lessac-medium.onnx
  tts/tokens.txt
  tts/espeak-ng-data/{phondata,phonindex,phontab,intonations,en_dict,lang/**,voices/**}
  vad/silero_vad.onnx
  .state.json          # { verifiedAt, files: { name: sha256 } }
```

A pre-populated cache for local test runs already exists at
`~/.hermes/cache/voice-models` — export `VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models` when
running the server tests by hand. Tests must **skip** (not fail) when the cache is absent, so CI
without a 263 MB download stays green.

## Server contracts

Mount: `voiceApi.route('/local', localVoiceApi)` inside `apps/server/src/voice.ts` (keeps
`routes.ts` and `index.ts` untouched), i.e. the public paths are `/api/voice/local/*`.

| Method + path | Body | Response |
| --- | --- | --- |
| `GET /api/voice/local/status` | — | `{ available, reason?, runtime: { platform, arch, provider: 'cpu', addon: boolean }, models: { stt, tts, vad }, bytes: { total, have }, download: { active, pct, name } }` |
| `POST /api/voice/local/stt` | raw PCM16 LE mono, header `X-Audio-Rate` (default 16000) | `{ text, audioMs, ms }` |
| `POST /api/voice/local/preview` | `{ text, speed? }` | raw PCM16, headers `Content-Type: audio/pcm`, `X-Audio-Rate: 22050` |
| `GET /api/voice/local/models` | — | `{ items: [{ kind, name, size, state, pct }], ready }` |
| `POST /api/voice/local/models/download` | `{ kind?: 'stt' \| 'tts' \| 'vad' }` | `{ started, state }` — idempotent, background |
| `POST /api/voice/local/session` | `{ botId }` | `{ callId, sampleRate: 16000, ttsSampleRate: 22050 }` |
| `WS /api/voice/local/call/:callId` | binary PCM16 16 kHz mono | control frames below |

`ModelState = 'missing' | 'downloading' | 'ready' | 'error'`. Every route requires
`requireUser` + an owned bot when a `botId` is given (use `ownBot`, same as `voice.ts`).

### WebSocket control frames

Client → server (text): `{type:'mute', on:boolean}`, `{type:'end'}`.
Server → client (text): `{type:'ready', ttsSampleRate}`, `{type:'transcript', text, final}`,
`{type:'thinking'}`, `{type:'speaking', on}`, `{type:'done'}`, `{type:'error', message}`,
`{type:'end'}`.

Binary frames are raw PCM16 mono; audio in is 16 kHz (server resamples if a client sends another
rate — read it from the first frame's paired `X`-free convention: the session is created with
`sampleRate: 16000` and the client must resample before sending). Audio out is 22 050 Hz.

## Shared types (parent-owned file: `packages/contracts/src/index.ts`)

```ts
export type VoiceProvider = 'cloud' | 'local';
export interface VoiceModelState { stt: VoiceModelStateValue; tts: VoiceModelStateValue; vad: VoiceModelStateValue }
export type VoiceModelStateValue = 'missing' | 'downloading' | 'ready' | 'error';
export interface VoiceLocalStatus { available: boolean; reason?: string; runtime: { platform: string; arch: string; provider: 'cpu'; addon: boolean }; models: VoiceModelState; bytes: { total: number; have: number }; download: { active: boolean; pct: number; name: string | null } }
```

`Bot.voiceProvider` is **not** added in this phase: the client decides per call from
`GET /local/status`, so no row mapper or schema changes are needed.

## File ownership (do not edit files you do not own)

| Owner | Files |
| --- | --- |
| **A — server core** | `apps/server/src/voice-runtime.ts` (new), `apps/server/src/voice-models.ts` (new), `apps/server/src/voice-local.ts` (new), the one mount line in `voice.ts`, `VOICE_MODELS_DIR` in `env.ts`, `apps/server/src/__tests__/voice-local.test.ts` (new) |
| **B — web client** | `apps/web/src/voice/api.ts`, `apps/web/src/voice/dictation.ts`, `apps/web/src/components/VoiceSettings.tsx`, `apps/web/src/components/VoiceSettings.css` if it exists |
| **C — infra** | `apps/server/Dockerfile` (apk line only), `apps/desktop/src/native-stack.ts` (model warm-up hook), `packages/contracts/src/index.ts` (types above only) |
| **D — call session** | `apps/server/src/voice-local-session.ts` (new), `apps/server/src/__tests__/voice-local-session.test.ts` (new) |
| **E — browser call** | `apps/web/src/voice/local-call.ts` (new), `apps/web/src/voice/call.ts` |
| **Parent** | `package.json`/lockfile, `voice-model-files.ts`, `voice-model-manifest` tools, fixtures, all gates |

Shared files nobody edits: `routes.ts`, `index.ts`, `store.ts`, `db.ts` — if you think you need one,
stop and say so in your summary.

## Repo facts the plan gets wrong

- No migration runner; not relevant here because there is no schema change.
- Server tests: `tsx --test src/__tests__/*.test.ts`, Node's `node:test` + `assert/strict`, no
  mocking library. A test that imports `env.ts` must first import
  `src/__tests__/helpers/tmp-env.ts`, then `await import()` the module under test.
- Web tests: `tsx --test src/lib/*.test.ts` then vitest (`src/**/*.test.tsx`, jsdom).
- Feature routers are their own Hono file with `AuthVars`, mounted in one line.

## Fixtures (parent-owned, do not modify)

`apps/server/src/__tests__/fixtures/voice/`:

| File | Duration | Content |
| --- | --- | --- |
| `en-hello.wav` | 3.92 s | "Hello, this is a test of the local speech recognition pipeline." |
| `en-command.wav` | 2.38 s | "Switch on the kitchen lights and tell me the weather." |
| `en-librispeech-long.wav` | 16.72 s | LibriSpeech: "As a direct consequence of the sin… blessed soul in heaven." |
| `en-silence.wav` | 1.00 s | silence (VAD negative) |

All 16 kHz mono PCM16. `fixtures/voice/manifest.json` carries the transcripts and the thresholds to
assert.

## Verification commands

```bash
cd apps/server && VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models pnpm --filter @orbit/server test
cd /Users/raybello/Github/Orbit/orbit-app && pnpm typecheck
pnpm --filter @orbit/web test
```

Budget assertions (server test): STT first partial < 300 ms, STT real-time factor ≥ 10×, TTS first
audio < 400 ms, TTS real-time factor ≥ 5×, transcript similarity ≥ threshold per fixture. Print the
measured value in the assertion message so a regression is diagnosable from CI output alone.

## Phase 2 addendum — the local call session

Phase 1 landed as commit `0122046` (141 server tests green, HTTP surface verified live). Phase 2 adds
the streaming call path. Rules from above still hold; this section only adds what is new.

### Server: `apps/server/src/voice-local-session.ts`

```ts
export interface LocalCallDeps {
  /** Injected in tests: turns a final transcript into the bot's spoken reply. */
  relay?: (text: string) => Promise<string>;
  synthesize?: (text: string) => { pcm: Int16Array; rate: number };
  onEvent?: (e: LocalCallEvent) => void;
}
export type LocalCallEvent =
  | { type: 'ready'; ttsSampleRate: number }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'thinking' }
  | { type: 'speaking'; on: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'end' };

export class LocalCallSession {
  constructor(opts: { callId: string; botId: string; deps?: LocalCallDeps });
  /** 16 kHz mono PCM16, any chunk size; VAD runs on 32 ms windows (512 samples). */
  accept(chunk: Int16Array): void;
  setMuted(on: boolean): void;
  close(): void;
}
export function createLocalCall(callId: string, botId: string): LocalCallSession;
export function takeLocalCall(callId: string): LocalCallSession | undefined;
export function attachLocalCallRelay(server: import('node:http').Server): void;
```

- `attachLocalCallRelay` mirrors `attachVncRelay` in `vnc.ts`: `WebSocketServer({ noServer: true })`,
  `server.on('upgrade')`, path `^/api/voice/local/call/([^/]+)$`, auth from the cookie header or
  `?token=` (same helpers `userFromCookieHeader` / `userFromToken`), 401 via a raw socket write when
  unauthenticated, `takeLocalCall` for an unknown call id. The **parent** adds the one
  `attachLocalCallRelay(server)` line to `index.ts` after `attachVncRelay` — do not edit `index.ts`.
- Default relay (production path): `appendRow(bot.id, 'message', {type:'message', role:'user', text, from:{kind:'voice', id:callId, name:'Voice call'}})`,
  then `enqueue(bot.id, { type: 'user', text: <the same '[Voice call: …] …' prompt voice.ts builds> })`,
  then poll `rows` every 150 ms (max 120 s) for a new `kind='message'`, `role='assistant'`,
  `!streaming` row with a non-empty `body.text`; return it. Return '' on timeout (the session then
  sends `{type:'error'}` and ends).
- `VOICE_CALL_RELAY=echo` makes the default relay return the user's text uppercased, so an end-to-end
  socket test runs with no agent and no provider key. That env switch exists for tests/diagnostics
  only and must be documented in a comment.
- Reply → TTS: split on sentence boundaries (`/(?<=[.!?])\s+/`), cap each sentence at 240 chars,
  synthesize sequentially with `maxNumSentences: 1`, and emit audio as soon as each sentence is ready
  (100 ms PCM frames, 2205 samples at 22 050 Hz). `speaking:true` before the first frame,
  `speaking:false` when the queue drains.
- Barge-in: if VAD reports speech while `speaking`, emit `speaking:false`, drop the remaining
  sentences, and keep the new utterance's transcript flowing. No queued audio may play after it.
- Mute drops input before VAD; it never stops the reply that is playing.

### Browser: `apps/web/src/voice/local-call.ts`

- `startLocalCall(botId)` → `POST /api/voice/local/session` → open
  `ws(s)://<host>/api/voice/local/call/<callId>` (cookies are sent automatically).
- Capture with the existing `MicCapture` (it actually yields **40 ms Int16 frames at 24 kHz**, not the
  20 ms Float32 the first draft of this doc claimed), convert to Float32, resample to 16 kHz, convert to
  PCM16, send binary frames. Muted → send nothing.
- Incoming binary → `PcmPlayer.push(pcm, ttsSampleRate)`; JSON → the existing `useVoice` zustand store
  (`transcript` grows captions, `thinking`/`speaking`/`listening` flags, `done`, `error`, `end`).
- `apps/web/src/voice/call.ts` dispatches: `localStatus()` reports `available` → `startLocalCall`,
  otherwise today's `VoiceCall` unchanged. `endCall()` must close whichever one is live.
- The resampler must be a pure exported function (`resampleTo16k(samples, rate)`) with a unit test in
  `apps/web/src/lib/voice-resample.test.ts` (length, rate identity at 16 kHz, a 48 kHz sine keeps its
  amplitude, DC preserved).

### Phase 2 verification (parent)

```bash
# unit + socket tests, real models
VOICE_MODELS_DIR=$HOME/.hermes/cache/voice-models pnpm --filter @orbit/server test
# live: boot a scratch server with VOICE_CALL_RELAY=echo, stream en-command.wav over a real socket,
# assert transcript + non-silent PCM back at 22050 Hz
```

## Phase 2 as built — measured, and what changed

Commit `0122046` plus the phase-2 work. Numbers below are from the parent's own runs on this Mac, not
from the agents' reports.

| What | Measured |
| --- | --- |
| Live socket gate (`en-command.wav` streamed as 20 ms frames, echo relay) | partials within ~1.05 s of the first frame, final transcript complete, 21–23 binary frames (2.0–2.3 s at 22 050 Hz, peak 0.64–0.70), `done` after `speaking:false` |
| Returned call audio re-transcribed through `/local/stt` | "…ON THE KITCHEN LIGHTS AND TELL ME THE WEATHER" — the reply really is speech |
| Server suite | 148 tests, 148 pass, stable across three consecutive runs |
| Web suite | 22 `tsx --test` + 59 vitest, all pass |
| UI (built bundle, real server) | `On-device · Ready`, Preview fires only `/api/voice/local/preview`; fresh install shows `Not downloaded (0 of 263 MB)` + a Download button that fetched all 250 files to `Ready` in ~20 s |

Two tuning decisions made at the gate, both after measurements:

- **Endpoint backstop 500 ms** (`END_SILENCE_MS`, was 1200): with 1.2 s the caller waited ~1.2 s of
  silence plus the VAD's own 350 ms before a turn closed. At 500 ms an utterance fed 0.9 s of trailing
  silence endpoints with a complete transcript, so this is the better conversational trade.
- **Barge-in accuracy is asserted on real speech, not on the synthetic clip.** The `say`-generated
  command clip sits exactly on this model's decision boundary: 0.3 s of lead padding transcribes it as
  "SWITCH ON THE KITCHEN…", 0.5 s as "SWITCH ON THE KIDS…". Gating on that would make the suite depend
  on how a TTS voice imitates a person, so the interrupted utterance in `voice-local-session.test.ts`
  is the LibriSpeech clip (similarity 0.946 measured) and the synthetic clip keeps its 0.9 gate in the
  batch path, where the padding is fixed and it measures 1.000.

Not exercised, and why: the production relay (`enqueue` → managed gateway → assistant row) needs a real
Hermes gateway. Everything up to it is covered by the echo relay plus a simulated agent turn, and the
`/local/session` → WS → TTS path is proven end to end here.
