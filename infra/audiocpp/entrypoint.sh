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
{
  printf '{\n\tadmin off\n\tskip_install_trust\n}\n\n'
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
sed "s#{MODELS_DIR}#${MODELS_DIR}#g" /opt/audiocpp/server-config.json > "$CONFIG"

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
echo "[audiocpp] models present; starting audiocpp_server on :8080"
/opt/audiocpp/audiocpp_server --config "$CONFIG" --models-root "$MODELS_DIR" &
SERVER_PID=$!

# Whichever process exits first takes the container down, so `restart: unless-stopped` restarts both.
trap 'kill -TERM $SERVER_PID ${CADDY_PID:-} 2>/dev/null || true' TERM INT
code=0
wait -n $SERVER_PID ${CADDY_PID:-} || code=$?
kill -TERM $SERVER_PID ${CADDY_PID:-} 2>/dev/null || true
exit $code
