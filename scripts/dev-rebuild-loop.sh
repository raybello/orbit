#!/usr/bin/env bash
# The rebuild loop: your working tree into the image, the stack recreated from it, then Electron.
#
#   bash scripts/dev-rebuild-loop.sh
#   ORBIT_NO_LAUNCH=1 bash scripts/dev-rebuild-loop.sh    # do everything but open the window
#
# The window renders whatever the server serves, and the server's web build and API are baked into
# the image — so a web/server change needs an image rebuild, not just an Electron restart.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

STACK="${ORBIT_STACK_DIR:-$HOME/Library/Application Support/Orbit/stack}"
APP_IMAGE="ghcr.io/raybello/orbit/app:edge"

echo "▸ 1/3 building $APP_IMAGE from this tree"
# CACHE_BUST busts the source-copy + build layers on every run so the web and
# server are always rebuilt from the current working tree.  pnpm install stays
# cached (the ARG appears after it in the Dockerfile).
docker build -f apps/server/Dockerfile -t "$APP_IMAGE" \
  --build-arg "CACHE_BUST=$(date +%s)" .

# A first run has no staged stack yet: launching the app is what stages the compose file and
# generates its secrets, so hand over to it instead of failing on a missing -f.
if [ ! -f "$STACK/docker-compose.yml" ]; then
  echo "▸ no staged stack yet — handing over to the app so it can stage one"
  if [ "${ORBIT_NO_LAUNCH:-}" = "1" ]; then
    echo "  (ORBIT_NO_LAUNCH=1 — stopping here)"
    exit 0
  fi
  exec pnpm --filter @orbit/desktop run dev
fi

echo "▸ 2/3 recreating the stack"
VOLUME="${ORBIT_VOLUME:-orbit_orbit-data}"
compose_up() {
  docker compose -f "$STACK/docker-compose.yml" --env-file "$STACK/.env" \
    up -d --remove-orphans --force-recreate 2>&1
}
if out=$(compose_up); then
  printf '%s\n' "$out" | tail -6
else
  printf '%s\n' "$out" | tail -6
  # A volume recreated too soon after `down --volumes` leaves a stale mountpoint and Docker reports
  # "failed to mkdir .../hermes: file exists". Clearing the volume and trying once more fixes it;
  # anything else is a real failure.
  if printf '%s' "$out" | grep -qE 'failed to mkdir|file exists'; then
    echo "▸ stale stack volume blocked the mountpoint — clearing $VOLUME and retrying once"
    docker compose -f "$STACK/docker-compose.yml" --env-file "$STACK/.env" down --volumes >/dev/null 2>&1 || true
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    if ! out2=$(compose_up); then
      printf '%s\n' "$out2" | tail -8
      echo "✗ the stack still will not start — see the compose output above" >&2
      exit 1
    fi
    printf '%s\n' "$out2" | tail -6
  else
    echo "✗ compose up failed — see the output above" >&2
    exit 1
  fi
fi

PORT=$(sed -n 's/^ORBIT_WEB_PORT=//p' "$STACK/.env" | head -1)
PORT=${PORT:-8787}
printf '▸ waiting for http://127.0.0.1:%s ' "$PORT"
for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  printf '.'; sleep 1
done
echo

# The window renders the web bundle baked into the image, so "rebuilt but the UI looks old"
# always means the container is not running the bundle this build produced. Prove it here
# instead of leaving it to the eye: compare the bundle the stack serves with the one inside
# the freshly tagged image.
echo "▸ checking the stack serves this build"
SERVED_CSS=$(curl -sf "http://127.0.0.1:$PORT/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.css' | head -1 | xargs -n1 basename)
IMAGE_CSS=$(docker run --rm --entrypoint sh "$APP_IMAGE" \
  -c 'ls /app/apps/web/dist/assets/ 2>/dev/null | grep "\.css$" | head -1' 2>/dev/null | head -1 | xargs -n1 basename || true)
if [ -n "$IMAGE_CSS" ] && [ "$SERVED_CSS" != "$IMAGE_CSS" ]; then
  echo "✗ the stack is serving ${SERVED_CSS:-nothing} but $APP_IMAGE built $IMAGE_CSS" >&2
  echo "  the container is running an older image — recreate it: docker compose -f \"$STACK/docker-compose.yml\" --env-file \"$STACK/.env\" up -d --force-recreate" >&2
  exit 1
fi
echo "  ✓ $SERVED_CSS"

echo "▸ 3/3 electron"
if [ "${ORBIT_NO_LAUNCH:-}" = "1" ]; then
  echo "  (ORBIT_NO_LAUNCH=1 — not opening the window)"
  exit 0
fi
# The app quits silently when another instance holds the single-instance lock, which would
# leave the *old* window (and its cached bundle) on screen: the rebuilt UI would never appear.
STALE=$(pgrep -f 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' || true)
if [ -n "$STALE" ]; then
  echo "  closing the running Orbit window first (pid $(printf '%s' "$STALE" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill $STALE 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' >/dev/null || break
    sleep 0.2
  done
fi
exec pnpm --filter @orbit/desktop run dev
