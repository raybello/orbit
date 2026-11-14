#!/usr/bin/env bash
# Vite as the renderer for the fast loop, with /api proxied to the running stack.
#
#   bash scripts/dev-vite.sh
#
# `apps/web/vite.config.ts` proxies /api to GROKBOT_API and defaults to :8787. The desktop stack
# picks its own port (and re-pins it every launch), so :8787 is almost always the wrong guess —
# read the port the stack actually published instead.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

STACK="${ORBIT_STACK_DIR:-$HOME/Library/Application Support/Orbit/stack}"
PORT=$(sed -n 's/^ORBIT_WEB_PORT=//p' "$STACK/.env" 2>/dev/null | head -1)
PORT=${PORT:-8787}

if ! curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "⚠ nothing healthy on http://127.0.0.1:$PORT — start the stack first"
  echo "  («orbit: reset stack» or «orbit: desktop dev — rebuild loop»)"
fi

echo "▸ vite on :5173, /api → http://127.0.0.1:$PORT"
exec env GROKBOT_API="http://127.0.0.1:$PORT" pnpm --filter @orbit/web run dev
