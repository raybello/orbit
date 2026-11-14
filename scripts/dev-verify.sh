#!/usr/bin/env bash
# Prove the running stack serves YOUR build. Run it after any restart.
#
#   bash scripts/dev-verify.sh
#
# The two nav-rail numbers must agree: `served` is what the window will render, `in image` is what
# is baked into the container. If they differ you are looking at a stale image, not at new code.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

STACK="${ORBIT_STACK_DIR:-$HOME/Library/Application Support/Orbit/stack}"
PORT=$(sed -n 's/^ORBIT_WEB_PORT=//p' "$STACK/.env" 2>/dev/null | head -1)
PORT=${PORT:-8787}
TOKEN=$(sed -n 's/^STACK_TOKEN=//p' "$STACK/.env" 2>/dev/null | head -1)
if [ -z "$TOKEN" ]; then
  TOKEN=$(sed -n 's/^ORBIT_STACK_TOKEN=//p' "$STACK/.env" 2>/dev/null | head -1)
fi
BASE="http://127.0.0.1:$PORT"

echo "stack      $BASE"
echo "health     $(curl -s "$BASE/api/health")"
echo "probe      $(curl -s -H "x-orbit-stack-token: $TOKEN" "$BASE/api/desktop/probe")"

CSS=$(curl -s "$BASE/" | grep -o '/assets/index-[A-Za-z0-9_-]*\.css' | head -1)
if [ -n "$CSS" ]; then
  echo "served css $CSS → nav-rail rules: $(curl -s "$BASE$CSS" | grep -o nav-rail | wc -l | tr -d ' ')"
else
  echo "served css (none — is the web build inside the image? run «orbit: desktop dev — rebuild loop»)"
fi
echo "in image   nav-rail rules: $(docker exec orbit-api-1 sh -lc 'grep -o nav-rail /app/apps/web/dist/assets/*.css | wc -l' 2>/dev/null | tr -d ' ' | head -1)"

echo '--- bots ---'
docker ps --filter label=orbit.botId --format '{{.Names}}  {{.Status}}  {{.Ports}}'
echo '--- containers ---'
docker ps --format '{{.Names}}  {{.Status}}  {{.Ports}}' | grep -i orbit
