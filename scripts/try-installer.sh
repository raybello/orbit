#!/usr/bin/env bash
# Run the macOS installer the way a user would, without touching your own Orbit.
#
#   bash scripts/try-installer.sh                 # the DMG from build-installer.sh
#   bash scripts/try-installer.sh path/to/Orbit.dmg
#   SIMULATE_DOWNLOAD=1 bash scripts/try-installer.sh   # also show macOS's first-launch block
#   STACK=docker bash scripts/try-installer.sh    # force the Docker or native stack (default: the app decides)
#   bash scripts/try-installer.sh --clean         # stop and delete the try-out stack and profile
#
# Isolation, because the installed app and the dev loop otherwise share everything:
#   - the app is copied to a scratch folder, never /Applications;
#   - ORBIT_USER_DATA_DIR gives it its own profile (setup, stack folder, secrets);
#   - COMPOSE_PROJECT_NAME=orbit-try gives its stack its own containers and data volume
#     (the compose file names the project `orbit`, which is your dev stack).
# The server image is the release tag matching the app's version; set ORBIT_IMAGE_TAG=edge to
# try an unreleased build against the image `main` publishes.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# The try-out copies Orbit.app out of a DMG and runs Gatekeeper's first launch: macOS only.
if [ "$(uname -s)" != Darwin ]; then
  echo "try-installer.sh drives the macOS DMG. On Windows, build the installer with" >&2
  echo "  bash scripts/build-installer.sh win" >&2
  echo "and run the .exe from apps/desktop/out (ORBIT_USER_DATA_DIR keeps it off your own profile)." >&2
  exit 2
fi

TRY_ROOT="${ORBIT_TRY_DIR:-${TMPDIR:-/tmp}orbit-try}"
PROJECT=orbit-try
export COMPOSE_PROJECT_NAME="$PROJECT"

if [ "${1:-}" = "--clean" ]; then
  echo "▸ stopping the try-out stack and deleting its data"
  pkill -f "$TRY_ROOT/Orbit.app/Contents/MacOS/Orbit" 2>/dev/null || true
  if [ -f "$TRY_ROOT/profile/stack/docker-compose.yml" ]; then
    docker compose -p "$PROJECT" -f "$TRY_ROOT/profile/stack/docker-compose.yml" \
      --env-file "$TRY_ROOT/profile/stack/.env" down --remove-orphans --volumes || true
  fi
  docker volume rm -f "${PROJECT}_orbit-data" >/dev/null 2>&1 || true
  rm -rf "$TRY_ROOT"
  echo "  ✓ removed $TRY_ROOT"
  exit 0
fi

[ "$(uname -s)" = "Darwin" ] || { echo "✗ this tries the macOS installer; run it on a Mac" >&2; exit 1; }

DMG="${1:-}"
if [ -z "$DMG" ]; then
  if [ "$(uname -m)" = "arm64" ]; then
    DMG=$(ls apps/desktop/out/Orbit-*-arm64.dmg 2>/dev/null | head -1 || true)
  else
    DMG=$(ls apps/desktop/out/Orbit-*.dmg 2>/dev/null | grep -v arm64 | head -1 || true)
  fi
fi
[ -n "$DMG" ] && [ -f "$DMG" ] || { echo "✗ no DMG found; run «bash scripts/build-installer.sh mac» first, or pass a path" >&2; exit 1; }

echo "▸ installer: $DMG ($(du -h "$DMG" | cut -f1), sha256 $(shasum -a 256 "$DMG" | cut -c1-16)…)"
pkill -f "$TRY_ROOT/Orbit.app/Contents/MacOS/Orbit" 2>/dev/null || true
mkdir -p "$TRY_ROOT/profile"
rm -rf "$TRY_ROOT/Orbit.app" "$TRY_ROOT/mnt"

COPY="$TRY_ROOT/download.dmg"
cp "$DMG" "$COPY"
if [ "${SIMULATE_DOWNLOAD:-0}" = "1" ]; then
  # What a browser stamps on a download; Gatekeeper then treats the app exactly as a user's copy.
  xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$COPY"
fi

echo "▸ mounting and copying Orbit.app (as dragging it to Applications would)"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$TRY_ROOT/mnt" "$COPY"
ditto "$TRY_ROOT/mnt/Orbit.app" "$TRY_ROOT/Orbit.app"
hdiutil detach "$TRY_ROOT/mnt" -quiet
rm -f "$COPY"
codesign --verify --deep --strict "$TRY_ROOT/Orbit.app" && echo "  ✓ signature verifies"

if [ "${SIMULATE_DOWNLOAD:-0}" = "1" ]; then
  xattr -w com.apple.quarantine "$(xattr -p com.apple.quarantine "$TRY_ROOT/Orbit.app" 2>/dev/null || echo "0083;$(printf %x "$(date +%s)");Safari;")" "$TRY_ROOT/Orbit.app" 2>/dev/null || true
  echo "▸ opening it as a download: expect macOS's \"Orbit.app Not Opened\" dialog (click Done)"
  open "$TRY_ROOT/Orbit.app" || true
  sleep 4
  echo "  clearing the download flag, as the install guide tells users to"
  xattr -dr com.apple.quarantine "$TRY_ROOT/Orbit.app"
fi

echo "▸ launching with its own profile and stack project ($PROJECT)"
echo "  profile: $TRY_ROOT/profile"
echo "  clean up afterwards: bash scripts/try-installer.sh --clean"
export ORBIT_USER_DATA_DIR="$TRY_ROOT/profile"
if [ -n "${STACK:-}" ]; then export ORBIT_FORCE_STACK="$STACK"; echo "  stack forced: $STACK"; fi
exec "$TRY_ROOT/Orbit.app/Contents/MacOS/Orbit"
