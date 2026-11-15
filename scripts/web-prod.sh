#!/usr/bin/env bash
# The web app as it ships: build the bundle, then serve it with `vite preview`.
#
#   bash scripts/web-prod.sh
#
# The bundle is the real production output (hashed assets, no dev server, no HMR). `vite preview`
# proxies /api to GROKBOT_API exactly as the dev server does, so this pairs with «orbit: server
# dev» or a running stack. For the app the server itself serves, use «orbit: server prod».
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

echo "▸ building workspace packages and the web bundle"
pnpm run build:packages
pnpm --filter @orbit/web run build

echo "▸ vite preview on :4173, /api → ${GROKBOT_API:-http://localhost:8787}"
exec pnpm --filter @orbit/web run preview
