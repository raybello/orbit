#!/usr/bin/env bash
# Build (and try) the Linux AppImage from a Windows checkout, inside WSL.
#
#   bash scripts/linux-installer-wsl.sh          # build: apps/desktop/out/wsl-linux/Orbit-<v>.AppImage
#   bash scripts/linux-installer-wsl.sh run      # build if missing, then launch it under WSLg
#   bash scripts/linux-installer-wsl.sh smoke    # build, then run `pnpm smoke` (server API) on Linux
#   bash scripts/linux-installer-wsl.sh test     # every package's unit tests, on Linux
#
# electron-builder cannot make an AppImage on Windows, and a Windows node_modules is the wrong
# platform for Linux, so the working tree (uncommitted changes included, node_modules and build
# output excluded) is mirrored into the WSL home and built there with its own install. The Docker
# engine is Docker Desktop's, shared with Windows, so images built on either side are visible to
# the Linux app (ORBIT_IMAGE_TAG picks a local tag).
#
# Env: WSL_DISTRO (default Ubuntu), WSL_DIR (default ~/orbit-linux inside WSL).
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-build}"
DISTRO="${WSL_DISTRO:-Ubuntu}"
DEST="${WSL_DIR:-$(MSYS_NO_PATHCONV=1 wsl.exe -d "${WSL_DISTRO:-Ubuntu}" -- bash -c 'printf %s "$HOME"')/orbit-linux}"
command -v wsl >/dev/null 2>&1 || command -v wsl.exe >/dev/null 2>&1 || { echo "✗ needs WSL (run from Windows)" >&2; exit 1; }
WIN_REPO="$(pwd -W 2>/dev/null || pwd)"
SRC="$(wsl.exe -d "$DISTRO" -- wslpath -a "$WIN_REPO" | tr -d '\r')"
VERSION=$(node -p "require('./apps/desktop/package.json').version")
OUT_WIN="apps/desktop/out/wsl-linux"

# The work happens in scripts/lib/wsl-linux-build.sh, run by path inside WSL: a script passed
# through wsl.exe's Windows command line loses its quoting.
in_wsl_script() { MSYS_NO_PATHCONV=1 wsl.exe -d "$DISTRO" -- bash "$SRC/scripts/lib/wsl-linux-build.sh" "$SRC" "$DEST" "$1"; }

build() {
  in_wsl_script build
  ls -la "$OUT_WIN"
}

case "$MODE" in
  build) build ;;
  run)
    [ -f "$OUT_WIN/Orbit-$VERSION.AppImage" ] || build
    echo "▸ launching Orbit-$VERSION.AppImage under WSLg (ORBIT_IMAGE_TAG=${ORBIT_IMAGE_TAG:-release})"
    MSYS_NO_PATHCONV=1 wsl.exe -d "$DISTRO" -- env ORBIT_IMAGE_TAG="${ORBIT_IMAGE_TAG:-}"       bash -c 'cp "$1" /tmp/Orbit.AppImage && chmod +x /tmp/Orbit.AppImage && exec /tmp/Orbit.AppImage --appimage-extract-and-run --no-sandbox' _ "$SRC/$OUT_WIN/Orbit-$VERSION.AppImage"
    ;;
  smoke) in_wsl_script smoke ;;
  test) in_wsl_script test ;;
  *) echo "usage: bash scripts/linux-installer-wsl.sh [build|run|smoke|test]" >&2; exit 2 ;;
esac
