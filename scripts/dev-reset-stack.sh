#!/usr/bin/env bash
# Reset the dev stacks to a clean slate, then make sure everything a clean desktop, web and mobile
# dev run needs is on disk.
#
#   bash scripts/dev-reset-stack.sh
#
# What it wipes (this is destructive, and it is the point):
#   - every process still using Orbit data: dev servers from this checkout, the Orbit window
#     (dev or installed — they share one profile), and the bots' Hermes gateways, which the
#     server starts detached and which otherwise keep recreating data/engines after you delete it
#   - the local dev data the server dev run uses (DB_PATH, ENGINES_DIR, COMPUTER_HOME_DIR in .env)
#   - the desktop app's native-stack data (orbit.db, engines/ and computer-homes/ in its profile folder)
#   - the Docker stack's containers and data volume, and any bot containers left behind
#
# What it ensures afterwards: .env, dependencies, the shared packages' builds, both Docker images,
# the web and desktop builds, the desktop's packaging resources, the mobile VNC viewer asset, and a
# workspace-wide typecheck.
#
# Kept in a script rather than inline in launch.json: it has destructive steps and does real work
# in several stages, and it should be readable and reviewable.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
. scripts/lib/platform.sh

USER_DATA="${ORBIT_USER_DATA_DIR:-$(orbit_user_data_default)}"
STACK="${ORBIT_STACK_DIR:-$USER_DATA/stack}"
APP_IMAGE="ghcr.io/raybello/orbit/app:edge"
BOT_IMAGE="orbit/computer:local"
VOLUME="${ORBIT_VOLUME:-orbit_orbit-data}"
fail() { echo "  ✗ $*" >&2; exit 1; }
warn() { echo "  ! $*" >&2; }

echo "▸ checkout:  $ROOT"
echo "▸ stack dir: $STACK"
echo "▸ profile:   $USER_DATA"

# Wait up to ~5s for a set of pids to exit, then force what is left (scripts/lib/platform.sh).
reap() { orbit_reap "$1"; }

# 1 ---------------------------------------------------------------- stop everything using the data
echo "▸ 1/7 stopping Orbit processes"

# Dev servers started from this checkout: the dev-server wrapper (it stops its own bot engines on
# SIGTERM) and a bare `tsx watch src/index.ts` from older runs.
DEV_RE='scripts/dev-server\.mjs|tsx watch .*src/index\.ts|tsx/dist/cli\.mjs watch .*src/index\.ts'
dev_pids=""
if [ "$ORBIT_OS" = win ]; then
  # No lsof to read a process's cwd: a dev run from this checkout names the checkout on its command
  # line (the wrapper's script path, tsx's --env-file), so match on that instead.
  ROOT_RE=$(cygpath -m "$ROOT" | sed 's/[.]/\\./g')
  dev_pids=$(orbit_pids "$ROOT_RE.*($DEV_RE)|($DEV_RE).*$ROOT_RE")
else
  for p in $(orbit_pids "$DEV_RE"); do
    cwd=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    case "$cwd" in "$ROOT"/*) dev_pids="$dev_pids $p" ;; esac
  done
fi
if [ -n "${dev_pids// /}" ]; then
  echo "  stopping the server dev run (pid $dev_pids)"
  orbit_kill "$dev_pids"
  reap "$dev_pids"
fi

# The Orbit window — dev Electron or the installed app. Both use the profile folder wiped below,
# and the native stack's server runs as their child.
win_pids=$(orbit_pids "$(orbit_window_pattern)")
if [ -n "${win_pids// /}" ]; then
  echo "  closing the Orbit window (pid $win_pids)"
  orbit_kill "$win_pids"
  reap "$win_pids"
fi
# A native-stack server left behind by a crashed window.
BUNDLES="$USER_DATA/server-bundles/"
[ "$ORBIT_OS" = win ] && BUNDLES="$(cygpath -m "$USER_DATA")/server-bundles/"
native_pids=$(orbit_pids "$BUNDLES")
if [ -n "${native_pids// /}" ]; then
  echo "  stopping native-stack processes (pid $native_pids)"
  orbit_kill "$native_pids"
  reap "$native_pids"
fi

# Every bot gateway Orbit started, wherever its home is (this checkout, the native profile, an old
# worktree). The primary agent (~/.hermes) is not one of them and keeps running.
node scripts/stop-bot-engines.mjs --all || warn "could not stop every bot engine"

# 2 ---------------------------------------------------------------- local data
echo "▸ 2/7 deleting local dev data and the desktop's native-stack data"
[ -f .env ] || { [ -f .env.example ] && cp .env.example .env && echo "  .env was missing — copied from .env.example (fill in the keys)"; }

# The paths the server dev run uses, resolved the way apps/server/src/env.ts does (relative values
# are relative to apps/server, its working directory).
read_paths() {
  node --input-type=module -e '
    import fs from "node:fs"; import path from "node:path"; import { parseEnv } from "node:util";
    const root = process.argv[1]; const server = path.join(root, "apps/server");
    let env = {}; try { env = parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8")); } catch {}
    const pick = (k, dflt) => { const v = process.env[k] || env[k]; return v ? path.resolve(server, v) : path.join(root, dflt); };
    console.log(pick("DB_PATH", "data/grokbot.db"));
    console.log(pick("ENGINES_DIR", "data/engines"));
    console.log(pick("COMPUTER_HOME_DIR", "data/computers"));
  ' "$ROOT"
}
# Only ever delete inside this checkout or the Orbit profile folder, whatever .env says.
safe_rm() {
  local target="$1"
  [ -e "$target" ] || return 0
  case "$target" in
    "$ROOT"/*|"$USER_DATA"/*) rm -rf "$target" && echo "  removed $target" ;;
    *) warn "not deleting $target: it is outside $ROOT and $USER_DATA" ;;
  esac
}
paths=$(read_paths) || fail "could not read the data paths from .env"
DB_FILE=$(printf '%s\n' "$paths" | sed -n 1p)
ENGINES=$(printf '%s\n' "$paths" | sed -n 2p)
COMPUTERS=$(printf '%s\n' "$paths" | sed -n 3p)
for f in "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm" "$DB_FILE-journal"; do safe_rm "$f"; done
safe_rm "$ENGINES"
safe_rm "$COMPUTERS"
for f in orbit.db orbit.db-wal orbit.db-shm orbit.db-journal engines computer-homes; do safe_rm "$USER_DATA/$f"; done

# Nothing may recreate it now; if something does, say who instead of leaving it a mystery.
sleep 2
if [ -e "$ENGINES" ]; then
  warn "$ENGINES came back — still writing to it:"
  if command -v lsof >/dev/null 2>&1; then
    lsof +D "$ENGINES" 2>/dev/null | awk 'NR>1 {print "    pid " $2 " " $1}' | sort -u >&2
  else
    warn "  (no lsof here: look for hermes gateway processes in Task Manager)"
  fi
fi

# 3 ---------------------------------------------------------------- docker stack
echo "▸ 3/7 Docker stack"
if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running — start it and run this again"
fi
if [ -f "$STACK/docker-compose.yml" ]; then
  echo "  stopping the stack and deleting its data volume"
  docker compose -f "$STACK/docker-compose.yml" --env-file "$STACK/.env" \
    down --remove-orphans --volumes || fail "could not stop the stack"
else
  echo "  no staged stack yet — nothing to stop"
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
# Remove orbit images: the tagged app and bot images, any untagged variants of those repos,
# and fully dangling (<none>:<none>) layers left behind by builds or pulls.
APP_REPO="${APP_IMAGE%%:*}"   # ghcr.io/raybello/orbit/app
BOT_REPO="${BOT_IMAGE%%:*}"   # orbit/computer
orbit_images=$(docker images -q "$APP_REPO" 2>/dev/null; docker images -q "$BOT_REPO" 2>/dev/null)
dangling=$(docker images -qf dangling=true 2>/dev/null)
all_images=$(printf '%s\n%s\n' "$orbit_images" "$dangling" | sort -u | grep -v '^$')
if [ -n "$all_images" ]; then
  # shellcheck disable=SC2086
  docker rmi -f $all_images >/dev/null 2>&1 \
    && echo "  removed orbit images (app, bot, untagged variants, dangling layers)"
else
  echo "  no orbit images to remove"
fi

# 4 ---------------------------------------------------------------- workspace
echo "▸ 4/7 workspace: dependencies, shared packages, Hermes"
pnpm install --frozen-lockfile || fail "pnpm install failed"
# The server and web dev runs import @orbit/* from dist/, which only `pnpm dev` at the root builds.
pnpm run build:packages >/dev/null || fail "building packages/* failed"
echo "  ✓ packages built"
HERMES_BIN_VALUE=$(sed -n 's/^HERMES_BIN=\([^ #]*\).*/\1/p' .env | tail -1)
if command -v "${HERMES_BIN_VALUE:-hermes}" >/dev/null 2>&1; then
  echo "  ✓ Hermes: $(command -v "${HERMES_BIN_VALUE:-hermes}")"
else
  warn "Hermes (${HERMES_BIN_VALUE:-hermes}) is not on PATH: bots beyond the first will not start in the server dev run"
fi

# 5 ---------------------------------------------------------------- app image
echo "▸ 5/7 app image ($APP_IMAGE)"
if docker image inspect "$APP_IMAGE" >/dev/null 2>&1; then
  echo "  ✓ present locally"
else
  echo "  … missing — pulling from ghcr"
  if ! docker pull "$APP_IMAGE"; then
    echo "  pull failed (not published, offline, or private) — building from this checkout"
    docker build -f apps/server/Dockerfile -t "$APP_IMAGE" . || fail "image build failed"
  fi
fi

# 6 ---------------------------------------------------------------- bot desktop image
# Local-only: it is built from apps/server/docker/computer and never published, so a pull is pointless.
echo "▸ 6/7 bot desktop image ($BOT_IMAGE)"
if docker image inspect "$BOT_IMAGE" >/dev/null 2>&1; then
  echo "  ✓ present locally"
else
  echo "  … missing — building (about five minutes the first time)"
  docker build -t "$BOT_IMAGE" apps/server/docker/computer || fail "bot desktop image build failed"
fi

# 7 ---------------------------------------------------------------- builds + validation
echo "▸ 7/7 builds and checks"
# Rebuilt every time: a stale dist is exactly what a reset is meant to rule out.
pnpm --filter @orbit/web build >/dev/null || fail "web build failed"
echo "  ✓ web build"
pnpm --filter @orbit/desktop build >/dev/null || fail "desktop build failed"
echo "  ✓ desktop build"
pnpm --filter @orbit/desktop run check-resources || fail "packaging resources are incomplete"
if [ ! -f apps/mobile/assets/vnc-viewer/index.html ]; then
  echo "  mobile VNC viewer missing — building it"
  pnpm --filter @orbit/mobile run vnc-viewer || fail "mobile VNC viewer build failed"
fi
echo "  ✓ mobile assets"
pnpm run typecheck >/dev/null || fail "typecheck failed — run «pnpm typecheck» to see why"
echo "  ✓ typecheck (server, web, desktop, mobile, packages)"
if [ -f "$STACK/docker-compose.yml" ]; then
  docker compose -f "$STACK/docker-compose.yml" --env-file "$STACK/.env" config -q \
    && echo "  ✓ compose config valid" || fail "staged compose file is invalid"
else
  echo "  (compose file is staged by the desktop app on its next launch)"
fi

echo
echo "✓ clean slate: no Orbit processes or bot engines, no local or stack data; images, builds and deps in place."
echo "  Next: «orbit: desktop dev — rebuild loop», or «orbit: server dev» + «orbit: web dev», or «orbit: mobile dev»."
