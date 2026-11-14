#!/usr/bin/env bash
# Reset the desktop dev stack to a clean slate, then make sure everything it needs is on disk.
#
#   bash scripts/dev-reset-stack.sh
#
# Stops the stack the desktop app manages, deletes its data volume (bots, sessions, screens) and any
# bot containers a crashed run left behind, then verifies — and fetches or builds — the two images
# the stack needs, the web build, and the compose file itself.
#
# Kept in a script rather than inline in launch.json: it has a destructive step and does real work
# in several stages, and it should be readable and reviewable.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

STACK="${ORBIT_STACK_DIR:-$HOME/Library/Application Support/Orbit/stack}"
APP_IMAGE="ghcr.io/raybello/orbit/app:edge"
BOT_IMAGE="orbit/computer:local"
VOLUME="${ORBIT_VOLUME:-orbit_orbit-data}"
fail() { echo "  ✗ $*" >&2; exit 1; }

echo "▸ stack dir: $STACK"

# 1 ---------------------------------------------------------------- stop + wipe
if [ -f "$STACK/docker-compose.yml" ]; then
  echo "▸ 1/4 stopping the stack and deleting its data volume"
  docker compose -f "$STACK/docker-compose.yml" --env-file "$STACK/.env" \
    down --remove-orphans --volumes || fail "could not stop the stack (is Docker running?)"
else
  echo "▸ 1/4 no staged stack yet — nothing to stop"
fi
# `down --volumes` can return before Docker has actually released the volume (colima is the usual
# culprit). Recreating it in that same moment is what makes the next `up` fail with
# "failed to mkdir .../hermes: file exists", so wait for the name to disappear.
for _ in $(seq 1 20); do
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || break
  sleep 0.5
done
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "  volume $VOLUME survived the down — removing it"
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
fi
# Bot containers carry their own label and survive `compose down`, which only knows the stack services.
orphans=$(docker ps -aq --filter label=orbit.botId 2>/dev/null)
if [ -n "$orphans" ]; then
  # shellcheck disable=SC2086
  docker rm -f $orphans >/dev/null && echo "  removed $(printf '%s\n' "$orphans" | wc -l | tr -d ' ') bot container(s)"
fi

# 2 ---------------------------------------------------------------- app image
echo "▸ 2/4 app image ($APP_IMAGE)"
if docker image inspect "$APP_IMAGE" >/dev/null 2>&1; then
  echo "  ✓ present locally"
else
  echo "  … missing — pulling from ghcr"
  if ! docker pull "$APP_IMAGE"; then
    echo "  pull failed (not published, offline, or private) — building from this checkout"
    docker build -f apps/server/Dockerfile -t "$APP_IMAGE" . || fail "image build failed"
  fi
fi

# 3 ---------------------------------------------------------------- bot desktop image
# Local-only: it is built from apps/server/docker/computer and never published, so a pull is pointless.
echo "▸ 3/4 bot desktop image ($BOT_IMAGE)"
if docker image inspect "$BOT_IMAGE" >/dev/null 2>&1; then
  echo "  ✓ present locally"
else
  echo "  … missing — building (about five minutes the first time)"
  docker build -t "$BOT_IMAGE" apps/server/docker/computer || fail "bot desktop image build failed"
fi

# 4 ---------------------------------------------------------------- validate
echo "▸ 4/4 validating resources"
if [ ! -d apps/web/dist ]; then
  echo "  web/dist missing — building it"
  pnpm --filter @orbit/web build || fail "web build failed"
fi
if [ ! -f apps/desktop/dist/main.js ]; then
  echo "  desktop/dist missing — building it"
  pnpm --filter @orbit/desktop build || fail "desktop build failed"
fi
pnpm --filter @orbit/desktop run check-resources || fail "packaging resources are incomplete"
if [ -f "$STACK/docker-compose.yml" ]; then
  docker compose -f "$STACK/docker-compose.yml" --env-file "$STACK/.env" config -q \
    && echo "  ✓ compose config valid" || fail "staged compose file is invalid"
else
  echo "  (compose file is staged by the desktop app on its next launch)"
fi

echo
echo "✓ clean slate: no stack containers, no stack data, both images present."
echo "  Next: run «orbit: desktop dev — rebuild loop» to build, start and launch."
