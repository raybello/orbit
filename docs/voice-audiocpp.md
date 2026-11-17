# GPU voice: audio.cpp

A third voice-call pipeline next to the cloud (xAI realtime) and on-device (sherpa-onnx, CPU) ones.
An [audio.cpp](https://github.com/0xShug0/audio.cpp) server on an NVIDIA GPU does all voice I/O;
Hermes stays the brain.

```
browser mic ──16 kHz PCM16──▶ orbit api ── energy VAD ──▶ OWSM ASR ──▶ transcript
                                                                      │
                                                    Hermes agent (same relay as on-device calls)
                                                                      │ reply text
           ◀── 0x01 audio / 0x02 JPEG frames ── orbit api ◀── speaking-avatar recipe
                                                              (LFM3-Audio TTS piped into SoulX-FlashHead)
```

Per bot: Voice chat → **Voice calls: GPU**, then a voice (38 LFM3 voices), an optional portrait
(any image, cropped to 512×512) and "Show animated avatar during calls". No portrait, or an
audio.cpp server without the avatar model, means an audio-only call.

| Platform | GPU voice |
| --- | --- |
| Windows, Linux + NVIDIA GPU | Opt-in. In the desktop app: Voice chat → **GPU** → **Install** pulls the sidecar image, then **Download** fetches its models. **Remove** takes it away again. Nothing is downloaded until you click. |
| macOS | Not offered. There is no CUDA, and no Apple-silicon build of the sidecar yet. The desktop app sets `AUDIOCPP_URL=off`, the settings hide **GPU**, and a bot that was set to GPU elsewhere takes its calls on-device. |
| Any server | `AUDIOCPP_URL` names an audio.cpp server (native, sidecar or a GPU box on the LAN). `AUDIOCPP_URL=off` turns GPU voice off. |

## Latency

The call is built so the caller hears the answer about one sentence after the model starts writing:

- **Streamed replies.** The agent loop flushes partial text to the reply row every ~120 ms. The call
  polls the row every 60 ms and cuts the text into pieces: the first sentence on its own, then
  sentences grouped to about 90 characters. Each piece goes to TTS/avatar as soon as it exists, and
  the next piece is generated while the previous one plays. The caption grows in place.
- **Endpointing.** 600 ms of silence ends a turn (energy VAD with an adaptive noise floor). The
  browser sends 20 ms mic frames, and the server keeps only 200 ms of trailing silence for OWSM.
- **cuDNN.** The sidecar compiles audio.cpp with cuDNN Conv3D for SoulX's VAE, about 2× faster with
  about 44% less VRAM than the generic VAE. If a binary lacks it, the entrypoint falls back to the
  generic VAE (`AUDIOCPP_AVATAR_VAE=ggml`) instead of crash-looping.
- **Call setup.** The browser requests the GPU session while the microphone permission prompt is
  still open, not after it.
- **Filler.** A model that has said nothing after 1.2 s gets "One moment."; one that has said
  nothing after 90 s gets an apology, and the call stays up.

Measured on an RTX 5070 Ti through a full Orbit call, from the end of the caller's speech:

| Hermes model | Transcript | First reply audio | First avatar video |
| --- | --- | --- | --- |
| Claude Sonnet 4.5 (Anthropic, LM Studio unloaded) | 1.0 s | 2.3 s | 5.0–6.3 s |
| qwen3.5-9b on LM Studio, sharing the GPU | 1.0–1.2 s | 3.6–4.2 s | 14–21 s |

A cloud model is the fast path: the GPU only holds the three voice models (8.4 GB in use, the
Windows desktop included), so an 8 GB card can run it, and SoulX does not compete with an LLM. Voice-call
turns also run at `reasoning_effort: low`, because thinking tokens are silence on a call. Hermes
uses your Claude Code sign-in for Anthropic when no key is set; see the
[setup guide](https://raybello.github.io/orbit/docs/setup.html#model).

## Running it

| Setup | How |
| --- | --- |
| Desktop app (Windows/Linux + NVIDIA) | Voice chat → **GPU** → **Install**, then **Download**. |
| audiocpp_server already running on this machine (e.g. the Windows build) | Nothing: `AUDIOCPP_URL` defaults to `http://127.0.0.1:8080`. In VS Code: «orbit: server + web dev with GPU voice (native audio.cpp)». |
| Orbit dev server on the host + GPU sidecar in Docker | `bash scripts/gpu-voice-stack.sh sidecar`. It publishes audio.cpp on `127.0.0.1:8080`, so the host's Orbit finds it at the default URL. The api reads download progress with `docker exec`, because it can't see the volume. |
| Docker stack + native server on the host | `NATIVE=1 bash scripts/gpu-voice-stack.sh` (api gets `AUDIOCPP_URL=http://host.docker.internal:8080`). |
| Docker stack + GPU sidecar | `bash scripts/gpu-voice-stack.sh` (`docker compose --profile gpu up --build`). Needs the NVIDIA Container Toolkit (Docker Desktop on Windows has it). |
| Rebuild the sidecar | `bash scripts/gpu-voice-stack.sh rebuild` (no cache, base images pulled, models kept). VS Code: «orbit: GPU voice — rebuild the audio.cpp sidecar». |

The sidecar (`infra/audiocpp/`) compiles audio.cpp v0.9.5 from source on
`nvidia/cuda:12.8.1-cudnn-devel`, and runs on `cudnn-runtime`. The build is CUDA + cuDNN Conv3D
and compiles only OWSM, LFM3-Audio and SoulX-FlashHead. It is a deployment build, so the model
specs are compiled in; LiquidAI's LFM3 GGUF doesn't embed one. Build time is governed by
`AUDIOCPP_CUDA_ARCHS`. The published image covers sm_75 to sm_120. `gpu-voice-stack.sh` builds
for your GPU only, which takes about 10 minutes. If audio.cpp exits, the entrypoint records why,
and the GPU voice settings show it (for example "audio.cpp: out of memory").
It also runs **Caddy** with an internal CA. Port **:8443** serves the audio.cpp WebUI and **:8444**
serves Orbit, both over HTTPS. Browsers only allow the microphone on https:// (or localhost), so
this is how a phone or second PC on the LAN gets to talk. Set
`AUDIOCPP_TLS_HOSTS="localhost 10.0.0.92"` and `AUDIOCPP_HTTPS_BIND=0.0.0.0`. The CA lives on the
data volume, so you accept the certificate warning once.

Models (~5.2 GB) are not in the image. Until they are on the `orbit-data` volume the container
serves only Caddy and writes `/data/audiocpp-models/.orbit-status.json`, which the api reads for
"GPU voice loading… N%". Start the download with **Download** in the GPU voice settings
(`POST /api/voice/audiocpp/models/download`, which runs `download-models.py` in the container through the
Docker socket, finding it by the `orbit.role=audiocpp` label), or set `AUDIOCPP_AUTO_DOWNLOAD=1`.
A 16 GB card holds one audio.cpp server with these models, so stop a native one before starting
the sidecar. A local LLM on the same card (LM Studio) needs the rest of it.

## API

`/api/voice/audiocpp/*`: `GET /status`, `POST /session`, `WS /call/:callId`, `POST /preview`,
`POST /models/download`, `GET|POST|DELETE /portrait/:botId`. Bot fields: `voiceProvider: 'audiocpp'`,
`audiocppVoice`, `avatarEnabled`, `hasPortrait` (PATCH `/api/bots/:id` takes the first three).

### Call socket

Client → server: binary PCM16 LE mono 16 kHz; `{type:'mute', on}`, `{type:'end'}`.

Server → client:

| frame | meaning |
| --- | --- |
| `0x01` + PCM16 LE | reply audio at `ttsSampleRate` (24 000) |
| `0x02` + u16 LE index + JPEG | avatar frame `index` of the current chunk |
| `ready{ttsSampleRate, hasAvatar, voice}` | session bound |
| `listening{on}` | VAD opened / closed an utterance |
| `transcript{text, final}` | what OWSM heard |
| `reply{text}` | what the bot is about to say |
| `thinking`, `speaking{on}`, `done` | turn state |
| `avatar{frames, fps, width, height}` | the next 0x01 frame is exactly this chunk's audio; its frames follow |
| `barge-in` | the caller talked over the bot: drop queued audio and video |
| `error{message}`, `end` | |

Audio is the clock. The browser starts a chunk's frames at the AudioContext time its audio starts
playing, so lip sync holds however the GPU's pace varies.

## Answers to the implementation plan's open questions

1. **Avatar endpoint:** there isn't a separate one. SoulX runs through `POST /v1/recipes/run` with
   recipe `speaking-avatar` (models `tts` + `avatar`). Video arrives as `rgb24` artifacts (24 frames
   at 25 fps per chunk); the api encodes each frame to JPEG with sharp.
2. **TTS → avatar streaming:** yes. The recipe pipes TTS PCM into the avatar through a bounded pipe,
   so video starts while speech is still being generated. Measured on an RTX 5070 Ti: first audio and
   video 1.2–1.4 s after the transcript, RTF ≈ 1.1.
3. **cuDNN:** the colab archive does not ship cuDNN; the `cudnn-runtime` base image supplies it.
   The Dockerfile fails the build if `ldd` finds a missing library (libcuda comes from the
   toolkit at run time).
4. **Portrait resize:** sharp, at upload (`fit: cover`, attention crop, EXIF rotation).
5. **Model download:** audio.cpp's own installer endpoints need a `ui_management` build, so the api
   uses `docker exec` through the socket it already mounts, finding the container by label instead
   of the `orbit-audiocpp-1` name. The plan's HuggingFace repos were wrong: OWSM is in
   `audio-cpp/audio.cpp-gguf`, and LFM3 (plus its required `mmproj`) is in
   `LiquidAI/LFM3-Audio-2B-GGUF` at audio.cpp's pinned revision.
6. **First-run UX:** the settings poll `/status` every 5 s while GPU voice is unavailable and show
   the download percentage.

Portraits reach the audio.cpp server through its `POST /v1/ui/upload` (needs `"ui": true`), not a
shared path, so a native Windows server and a remote GPU box work the same as the sidecar. With uploads
off it falls back to the file's path on the shared volume.

## Windows notes

- Docker Desktop reaches the api's Docker client over the `//./pipe/docker_engine` named pipe, so
  the Download button and progress work for an Orbit running natively on Windows too.
- Use Node ≥ 22.12. On 22.11 `better-sqlite3@13`'s prebuilt binary crashes (access violation) when
  the server opens its database, and pnpm skips rolldown's Windows binding, so vite and vitest fail.
- `.vscode/launch.json` works on Windows: `run-script.mjs` runs `bash` as Git Bash (never WSL),
  pnpm shims through cmd.exe, and `python3` as `python`. `scripts/lib/platform.sh` stands in for
  pgrep/lsof and resolves the desktop profile to `%APPDATA%\Orbit`.
