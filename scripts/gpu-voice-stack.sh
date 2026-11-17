#!/usr/bin/env bash
# The source-built stack with GPU voice: api + sandbox-supervisor + the audio.cpp sidecar
# (OWSM ASR, LFM3-Audio TTS, SoulX-FlashHead avatar) and its Caddy HTTPS front door.
#
#   bash scripts/gpu-voice-stack.sh            # build + up (detached), then wait for health
#   bash scripts/gpu-voice-stack.sh sidecar    # only the sidecar, for an Orbit running on the host:
#                                              # audio.cpp on 127.0.0.1:8080, HTTPS on :8443/:8444
#   bash scripts/gpu-voice-stack.sh rebuild    # rebuild the sidecar image from scratch (fresh
#                                              # audio.cpp release, base image pulled) and recreate it;
#                                              # models on the volume are kept
#   bash scripts/gpu-voice-stack.sh down       # stop it (data volume kept)
#   bash scripts/gpu-voice-stack.sh logs       # follow the sidecar's logs
#   NATIVE=1 bash scripts/gpu-voice-stack.sh   # no sidecar: point the api at an audiocpp_server
#                                              # already running on this host (:8080)
#
# Needs Docker with the NVIDIA Container Toolkit (Docker Desktop + WSL2 on Windows ships it). Check:
#   docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi
# The ~5 GB of models download on first use: Bot settings → Voice → GPU → Download, or
# AUDIOCPP_AUTO_DOWNLOAD=1 to fetch them at boot. Only one GPU voice server fits on a 16 GB card,
# so stop a native audiocpp_server before starting the sidecar.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

COMPOSE=(docker compose -f infra/compose/docker-compose.yml)
[ -f .env ] && COMPOSE+=(--env-file .env)
# The supervisor and the api share this secret; any value works for a dev stack.
export SANDBOX_SUPERVISOR_TOKEN="${SANDBOX_SUPERVISOR_TOKEN:-$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')}"

HOST_OVERLAY=(-f infra/compose/docker-compose.gpu-host.yml)

# Compile audio.cpp only for this machine's GPU (e.g. 12.0 → 120): minutes instead of most of an hour.
if [ -z "${AUDIOCPP_CUDA_ARCHS:-}" ] && command -v nvidia-smi >/dev/null 2>&1; then
  cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n1 | tr -d ' .')"
  [ -n "$cap" ] && export AUDIOCPP_CUDA_ARCHS="$cap" && echo "▸ building audio.cpp for this GPU only (sm_$cap)"
fi

# Waits for the sidecar's audio.cpp server, or reports that it is waiting for its models.
wait_sidecar() {
  printf '▸ waiting for audio.cpp on http://127.0.0.1:%s ' "${AUDIOCPP_API_PORT:-8080}"
  for _ in $(seq 1 180); do
    if curl -sf "http://127.0.0.1:${AUDIOCPP_API_PORT:-8080}/health" >/dev/null 2>&1; then
      echo; echo "✓ audio.cpp: http://127.0.0.1:${AUDIOCPP_API_PORT:-8080}   WebUI: https://localhost:${AUDIOCPP_HTTPS_PORT:-8443}"
      return 0
    fi
    if "${COMPOSE[@]}" "${HOST_OVERLAY[@]}" --profile gpu logs --no-log-prefix audiocpp 2>/dev/null | grep -q 'waiting for download'; then
      echo; echo "• the sidecar is up but has no models yet: Bot settings → Voice → GPU → Download"
      echo "  (or AUDIOCPP_AUTO_DOWNLOAD=1). It starts audio.cpp by itself once they are in."
      return 0
    fi
    printf '.'; sleep 2
  done
  echo; echo "✗ audio.cpp did not come up; see: bash scripts/gpu-voice-stack.sh logs" >&2
  return 1
}

case "${1:-up}" in
  down) exec "${COMPOSE[@]}" "${HOST_OVERLAY[@]}" --profile gpu down ;;
  logs) exec "${COMPOSE[@]}" "${HOST_OVERLAY[@]}" --profile gpu logs -f audiocpp ;;
  sidecar)
    echo "▸ building and starting only the audio.cpp sidecar (Orbit runs on this host)"
    "${COMPOSE[@]}" "${HOST_OVERLAY[@]}" --profile gpu up -d --build audiocpp
    wait_sidecar
    exit $? ;;
  rebuild)
    echo "▸ rebuilding the audio.cpp sidecar image (no cache, base images pulled)"
    "${COMPOSE[@]}" "${HOST_OVERLAY[@]}" --profile gpu build --no-cache --pull audiocpp
    # Recreate in whichever mode it was running; sidecar-only when nothing else of the stack is up.
    if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx api; then
      "${COMPOSE[@]}" --profile gpu up -d --force-recreate audiocpp
    else
      "${COMPOSE[@]}" "${HOST_OVERLAY[@]}" --profile gpu up -d --force-recreate audiocpp
      wait_sidecar
    fi
    exit $? ;;
  up) ;;
  *) echo "usage: bash scripts/gpu-voice-stack.sh [up|sidecar|rebuild|down|logs]" >&2; exit 2 ;;
esac

if [ "${NATIVE:-}" = "1" ]; then
  export AUDIOCPP_URL="${AUDIOCPP_URL:-http://host.docker.internal:8080}"
  echo "▸ api → native audio.cpp at $AUDIOCPP_URL (no sidecar)"
  "${COMPOSE[@]}" up -d --build api sandbox-supervisor
else
  echo "▸ building and starting api + audiocpp sidecar (--profile gpu)"
  "${COMPOSE[@]}" --profile gpu up -d --build
fi

PORT="${ORBIT_WEB_PORT:-8787}"
printf '▸ waiting for http://127.0.0.1:%s ' "$PORT"
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  printf '.'; sleep 1
done
echo
echo "✓ Orbit:            http://127.0.0.1:$PORT"
[ "${NATIVE:-}" = "1" ] || echo "✓ Orbit over HTTPS: https://localhost:${ORBIT_HTTPS_PORT:-8444}   (audio.cpp WebUI: https://localhost:${AUDIOCPP_HTTPS_PORT:-8443})"
echo "  GPU voice status: curl -s http://127.0.0.1:$PORT/api/voice/audiocpp/status (signed in)"
