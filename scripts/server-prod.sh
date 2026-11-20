#!/usr/bin/env bash
# The full production build this repo ships: packages, web bundle, then the compiled server that
# serves both the API and that bundle.
#
#   bash scripts/server-prod.sh
#
# Data and ports come from the environment: PORT (default 8787), DB_PATH. Reading
# the root .env is the server's own behaviour (`node --env-file=../../.env`), so keys set there
# apply here too.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

echo "▸ building packages, web and server (turbo)"
pnpm run build

echo "▸ starting the compiled server on :${PORT:-8787}"
exec pnpm --filter @orbit/server run start
