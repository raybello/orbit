#!/usr/bin/env python3
"""Fetch the three audio.cpp model packages Orbit's GPU voice uses into $AUDIOCPP_MODELS_DIR.

Idempotent: a file already present at its full size is skipped, and a partial download (.part) is
resumed with an HTTP Range request. Progress is written to $AUDIOCPP_MODELS_DIR/.orbit-status.json,
which both the entrypoint (waiting to start the server) and Orbit's api container (same volume,
GET /api/voice/audiocpp/status) read.

Run from Orbit with `docker exec <audiocpp container> python3 /opt/audiocpp/download-models.py`, or at
container start with AUDIOCPP_AUTO_DOWNLOAD=1. Set HF_TOKEN for gated repositories.
"""
import json
import os
import sys
import time
import urllib.request

MODELS_DIR = os.environ.get("AUDIOCPP_MODELS_DIR", "/data/audiocpp-models")
STATUS = os.path.join(MODELS_DIR, ".orbit-status.json")
LOCK = os.path.join(MODELS_DIR, ".orbit-download.lock")
HF = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")

# (HuggingFace repo@revision, file in the repo, path under MODELS_DIR). Repos and revisions are the
# ones audio.cpp's own model_specs/*.json download from (packages owsm_v4_base_102m_q8_0,
# lfm3_audio_2b_q8_0 and soulx_flashhead_lite_q8_0), laid out the way model_manager_v2.py installs them.
FILES = [
    ("audio-cpp/audio.cpp-gguf@main", "OWSM-GGUF/owsm-v4-base-102m-q8_0.gguf", "OWSM-GGUF/owsm-v4-base-102m-q8_0.gguf"),
    ("LiquidAI/LFM3-Audio-2B-GGUF@fcfae9027c00a6f3f872c48a841cfeb77e2b5a1c", "LFM3-Audio-2B-Q8_0.gguf", "LFM3-Audio-2B-GGUF/LFM3-Audio-2B-Q8_0.gguf"),
    ("LiquidAI/LFM3-Audio-2B-GGUF@fcfae9027c00a6f3f872c48a841cfeb77e2b5a1c", "mmproj-LFM3-Audio-2B-Q8_0.gguf", "LFM3-Audio-2B-GGUF/mmproj-LFM3-Audio-2B-Q8_0.gguf"),
    ("audio-cpp/SoulX-FlashHead-GGUF@main", "SoulX-FlashHead-Lite-Q8_0.gguf", "SoulX-FlashHead-GGUF/SoulX-FlashHead-Lite-Q8_0.gguf"),
]


def file_url(repo_rev, name):
    repo, _, rev = repo_rev.partition("@")
    return f"{HF}/{repo}/resolve/{rev or 'main'}/{name}"


def write_status(**fields):
    fields["updated_at"] = int(time.time() * 1000)
    tmp = STATUS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(fields, f)
    os.replace(tmp, STATUS)


def request(url, start=0, method="GET"):
    req = urllib.request.Request(url, method=method)
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if start:
        req.add_header("Range", f"bytes={start}-")
    return urllib.request.urlopen(req, timeout=60)


def remote_size(url):
    with request(url, method="HEAD") as r:
        return int(r.headers.get("Content-Length") or 0)


def all_present():
    return all(os.path.isfile(os.path.join(MODELS_DIR, rel)) for _, _, rel in FILES)


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)
    if all_present():
        write_status(state="ready", pct=100, have=0, total=0, file=None)
        print("all models present")
        return 0

    # One downloader at a time: a second POST /models/download while one runs is a no-op.
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
    except FileExistsError:
        try:
            pid = int(open(LOCK).read().strip() or 0)
            os.kill(pid, 0)
            print("a download is already running")
            return 0
        except (ValueError, ProcessLookupError, PermissionError, OSError):
            os.replace(LOCK, LOCK + ".stale")  # its owner died; take over
            return main()

    try:
        urls = [file_url(repo, name) for repo, name, _ in FILES]
        sizes = []
        for url, (_, _, rel) in zip(urls, FILES):
            dest = os.path.join(MODELS_DIR, rel)
            sizes.append(os.path.getsize(dest) if os.path.isfile(dest) else remote_size(url))
        total = sum(sizes)
        done = 0
        for url, size, (_, name, rel) in zip(urls, sizes, FILES):
            dest = os.path.join(MODELS_DIR, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.isfile(dest):
                done += size
                continue
            part = dest + ".part"
            have = os.path.getsize(part) if os.path.isfile(part) else 0
            if size and have > size:
                os.remove(part)
                have = 0
            last = 0.0
            with request(url, start=have) as r:
                if have and r.status != 206:  # server ignored Range: start over
                    have = 0
                with open(part, "ab" if have else "wb") as out:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
                        have += len(chunk)
                        now = time.time()
                        if now - last > 1:
                            last = now
                            pct = int((done + have) * 100 / total) if total else 0
                            write_status(state="downloading", pct=pct, have=done + have, total=total, file=name)
            if size and have != size:
                raise RuntimeError(f"{name}: got {have} of {size} bytes")
            os.replace(part, dest)
            done += size
            print(f"downloaded {rel}")
        write_status(state="ready", pct=100, have=total, total=total, file=None)
        return 0
    except Exception as e:  # noqa: BLE001 - reported through the status file
        write_status(state="error", pct=0, have=0, total=0, file=None, error=str(e)[:300])
        print(f"download failed: {e}", file=sys.stderr)
        return 1
    finally:
        try:
            os.remove(LOCK)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
