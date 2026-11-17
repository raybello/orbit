#!/usr/bin/env bash
# The source-built stack with GPU voice: api + sandbox-supervisor + the audio.cpp sidecar
# (OWSM ASR, LFM3-Audio TTS, SoulX-FlashHead avatar) and its Caddy HTTPS front door.
#
#   bash scripts/gpu-voice-stack.sh            # build + up (detached), then wait for health
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

case "${1:-up}" in
  down) exec "${COMPOSE[@]}" --profile gpu down ;;
  logs) exec "${COMPOSE[@]}" --profile gpu logs -f audiocpp ;;
  up) ;;
  *) echo "usage: bash scripts/gpu-voice-stack.sh [up|down|logs]" >&2; exit 2 ;;
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
