#!/bin/bash
# Start Orbit's audio.cpp sidecar: the Caddy HTTPS front door first (so the WebUI/Orbit HTTPS ports
# answer even while models download), then audiocpp_server once its models are on the volume.
set -euo pipefail

MODELS_DIR=${AUDIOCPP_MODELS_DIR:-/data/audiocpp-models}
STATUS="$MODELS_DIR/.orbit-status.json"
mkdir -p "$MODELS_DIR" "${XDG_DATA_HOME:-/data/audiocpp-caddy}"
rm -f "$MODELS_DIR/.orbit-download.lock"  # a lock left by a container that was killed mid-download

# ---- Caddy: internal-CA TLS for each host in AUDIOCPP_TLS_HOSTS ----
# Browsers only grant microphone access on https:// (or localhost). Add the LAN address you open
# Orbit from, e.g. AUDIOCPP_TLS_HOSTS="localhost 10.0.0.92". The CA lives on the data volume, so the
# certificate warning is accepted once, not after every container recreate.
CADDYFILE=/tmp/Caddyfile
# A browser that opens https://10.0.0.92:8444 sends no SNI (TLS has no SNI for IP addresses), and
# without one Caddy cannot pick a certificate and drops the handshake. default_sni names the
# certificate to use then: the first non-loopback host, which is the LAN address people type.
DEFAULT_SNI=localhost
for h in ${AUDIOCPP_TLS_HOSTS:-localhost 127.0.0.1}; do
  case "$h" in localhost|127.*|::1) ;; *) DEFAULT_SNI="$h"; break ;; esac
done
{
  printf '{\n\tadmin off\n\tskip_install_trust\n\tdefault_sni %s\n}\n\n' "$DEFAULT_SNI"
  sites=""
  for h in ${AUDIOCPP_TLS_HOSTS:-localhost 127.0.0.1}; do sites="$sites${sites:+, }https://$h:8443"; done
  printf '%s {\n\ttls internal\n\treverse_proxy 127.0.0.1:8080 {\n\t\tflush_interval -1\n\t}\n}\n\n' "$sites"
  if [ -n "${ORBIT_HTTPS_UPSTREAM:-}" ]; then
    sites=""
    for h in ${AUDIOCPP_TLS_HOSTS:-localhost 127.0.0.1}; do sites="$sites${sites:+, }https://$h:8444"; done
    printf '%s {\n\ttls internal\n\treverse_proxy %s {\n\t\tflush_interval -1\n\t}\n}\n' "$sites" "$ORBIT_HTTPS_UPSTREAM"
  fi
} > "$CADDYFILE"
if [ "${AUDIOCPP_HTTPS:-1}" != "0" ]; then
  caddy run --config "$CADDYFILE" --adapter caddyfile &
  CADDY_PID=$!
fi

# ---- the server config, with the models root filled in ----
CONFIG=/tmp/server-config.json
# SoulX's VAE: cudnn (default; this image compiles it in) or ggml (the generic path, for a binary
# built without cuDNN). A failed cudnn start falls back to ggml below instead of crash-looping.
AVATAR_VAE=${AUDIOCPP_AVATAR_VAE:-cudnn}
render_config() {
  sed -e "s#{MODELS_DIR}#${MODELS_DIR}#g" -e "s#{AVATAR_VAE}#$1#g" /opt/audiocpp/server-config.json > "$CONFIG"
}
render_config "$AVATAR_VAE"

models_present() {
  grep -o '"path": "[^"]*"' "$CONFIG" | cut -d'"' -f4 | while read -r p; do [ -f "$p" ] || exit 1; done
}

if ! models_present; then
  if [ "${AUDIOCPP_AUTO_DOWNLOAD:-0}" = "1" ]; then
    python3 /opt/audiocpp/download-models.py || true
  elif [ ! -f "$STATUS" ] || ! grep -q '"downloading"' "$STATUS"; then
    printf '{"state":"missing","pct":0,"have":0,"total":0,"file":null}\n' > "$STATUS"
  fi
  # Orbit starts the download with `docker exec … download-models.py`; wait for it to land rather
  # than crash-looping on missing files.
  echo "[audiocpp] models missing in $MODELS_DIR; waiting for download (POST /api/voice/audiocpp/models/download)"
  until models_present; do sleep 5; done
fi

printf '{"state":"ready","pct":100,"have":0,"total":0,"file":null}\n' > "$STATUS"
SERVER_LOG=/tmp/audiocpp_server.log
start_server() {
  echo "[audiocpp] models present; starting audiocpp_server on :8080 (avatar VAE: $1)"
  # tee keeps the log on stdout for `docker logs` and in a file for the cuDNN check below.
  /opt/audiocpp/audiocpp_server --config "$CONFIG" --models-root "$MODELS_DIR" > >(tee "$SERVER_LOG") 2>&1 &
  SERVER_PID=$!
}
start_server "$AVATAR_VAE"

# Loading three models takes a while; if the server dies during it because this binary has no
# cuDNN Conv3D, restart it once on the generic VAE so voice still works (just slower avatar video).
if [ "$AVATAR_VAE" = cudnn ]; then
  for _ in $(seq 1 300); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    curl -fs http://127.0.0.1:8080/health >/dev/null 2>&1 && break
    sleep 1
  done
  if ! kill -0 "$SERVER_PID" 2>/dev/null && grep -qi 'cudnn support is not compiled' "$SERVER_LOG"; then
    echo "[audiocpp] this build has no cuDNN Conv3D; falling back to the generic avatar VAE"
    render_config ggml
    start_server ggml
  fi
fi

# Warm the models in the background: the first request after boot is ~15 s of CUDA/cuDNN setup
# that would otherwise land on someone's first call. AUDIOCPP_WARMUP=0 skips it.
if [ "${AUDIOCPP_WARMUP:-1}" != "0" ]; then
  python3 /opt/audiocpp/warmup.py &
fi

# Whichever process exits first takes the container down, so `restart: unless-stopped` restarts both.
trap 'kill -TERM $SERVER_PID ${CADDY_PID:-} 2>/dev/null || true' TERM INT
code=0
wait -n $SERVER_PID ${CADDY_PID:-} || code=$?
# Tell Orbit why, so the GPU voice settings show the server's own error instead of "not answering".
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  why="$(grep -h 'audiocpp_server failed' "$SERVER_LOG" 2>/dev/null | tail -n1 | sed 's/^audiocpp_server failed: //' | cut -c1-300 | tr -d '"\')"
  [ -n "$why" ] || why="audiocpp_server exited with code $code"
  printf '{"state":"ready","pct":100,"have":0,"total":0,"file":null,"server_error":"%s","updated_at":%s}
' "$why" "$(date +%s000)" > "$STATUS"
fi
kill -TERM $SERVER_PID ${CADDY_PID:-} 2>/dev/null || true
exit $code
