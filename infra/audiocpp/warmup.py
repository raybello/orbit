#!/usr/bin/env python3
"""Warm the three GPU voice models once audiocpp_server answers, so the first real call is fast.

Measured on an RTX 5070 Ti: the first OWSM request after boot takes ~15 s (CUDA/cuDNN kernel and
plan setup) where a warm one takes ~250 ms; TTS and the avatar have the same first-use cost. The
entrypoint runs this in the background, so nobody's first call pays it. Standard library only.

Each step is best-effort: a failure is printed and the next step still runs.
"""
import json
import os
import struct
import sys
import time
import urllib.request
import uuid
import zlib

BASE = os.environ.get("AUDIOCPP_WARM_URL", "http://127.0.0.1:8080")
ASR = os.environ.get("AUDIOCPP_ASR_MODEL", "chat-recognition")
TTS = os.environ.get("AUDIOCPP_TTS_MODEL", "chat-voice")
AVATAR = os.environ.get("AUDIOCPP_AVATAR_MODEL", "chat-avatar")
VOICE = os.environ.get("AUDIOCPP_WARM_VOICE", "american_english_female")
TMP = os.environ.get("TMPDIR", "/tmp")


def wav(seconds=1.0, rate=16000):
    """A quiet 220 Hz tone: OWSM gets real audio to run, not an empty file."""
    import math
    n = int(seconds * rate)
    pcm = b"".join(struct.pack("<h", int(800 * math.sin(2 * math.pi * 220 * i / rate))) for i in range(n))
    return b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm)) + pcm


def png(size=512):
    """A plain grey face-sized PNG for the avatar's reference image (no imaging library needed)."""
    row = b"\x00" + bytes([128, 128, 128]) * size
    raw = row * size
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def post(path, body, headers, timeout=180):
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        # Drain streams to the end: the work happens while they are read.
        while r.read(65536):
            pass


def step(name, fn):
    t0 = time.time()
    try:
        fn()
        print(f"[audiocpp] warmed {name} in {int((time.time() - t0) * 1000)} ms", flush=True)
    except Exception as e:  # noqa: BLE001 - best effort
        print(f"[audiocpp] warm-up of {name} failed: {e}", flush=True)


def asr():
    boundary = uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{ASR}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="warm.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + wav() + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    post("/v1/audio/transcriptions", b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"})


def tts():
    body = {"model": TTS, "input": "Warming up.", "voice": VOICE, "response_format": "pcm", "stream_format": "sse"}
    post("/v1/audio/speech", json.dumps(body).encode(), {"Content-Type": "application/json", "Accept": "text/event-stream"})


def avatar():
    image = os.path.join(TMP, "orbit-warmup-portrait.png")
    with open(image, "wb") as f:
        f.write(png())
    body = {
        "recipe": "speaking-avatar",
        "stream": True,
        "include_artifacts": False,
        "models": {"tts": TTS, "avatar": AVATAR},
        "request": {"text": "Warming up the avatar.", "voice_id": VOICE, "options": {"avatar.reference_image_file": image}},
    }
    post("/v1/recipes/run", json.dumps(body).encode(), {"Content-Type": "application/json", "Accept": "text/event-stream"}, timeout=300)


def models():
    with urllib.request.urlopen(BASE + "/v1/models", timeout=10) as r:
        return {m.get("id") for m in json.load(r).get("data", [])}


if __name__ == "__main__":
    for _ in range(600):  # the server loads three models first
        try:
            urllib.request.urlopen(BASE + "/health", timeout=2).read()
            break
        except Exception:  # noqa: BLE001
            time.sleep(1)
    else:
        sys.exit(0)
    have = models()
    if ASR in have:
        step("speech recognition", asr)
    if TTS in have:
        step("speech", tts)
    if TTS in have and AVATAR in have:
        step("avatar", avatar)
