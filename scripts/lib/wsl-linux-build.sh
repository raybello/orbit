#!/usr/bin/env bash
# Runs INSIDE WSL for scripts/linux-installer-wsl.sh: mirror a Windows checkout into the Linux home,
# install with Linux-native tools, build the AppImage (or run the server smoke test), copy it back.
#
#   bash wsl-linux-build.sh <src: /mnt/c/.../orbit> <dest: ~/orbit-linux> build|smoke|test
set -euo pipefail
SRC="$1"; DEST="$2"; MODE="${3:-build}"

# Linux tools only: WSL appends the Windows PATH (/mnt/c/...), whose pnpm.exe and node.exe would
# otherwise win and fail on Linux paths. pnpm comes from the distro's corepack, at the version the
# repo pins (packageManager).
PATH="$HOME/.local/bin:$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)"
export PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  corepack enable --install-directory "$HOME/.local/bin"
fi
command -v rsync >/dev/null 2>&1 || { echo "✗ install rsync (sudo apt install rsync)" >&2; exit 1; }

echo "▸ mirroring $SRC → $DEST"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude node_modules --exclude .turbo --exclude dist --exclude out --exclude .git \
  --exclude 'apps/desktop/resources/server-bundle.json' \
  "$SRC/" "$DEST/"
cd "$DEST"
echo "▸ pnpm $(pnpm -v) on node $(node -v)"
pnpm install --frozen-lockfile --config.confirmModulesPurge=false

case "$MODE" in
  build)
    bash scripts/build-installer.sh linux
    mkdir -p "$SRC/apps/desktop/out/wsl-linux"
    cp apps/desktop/out/*.AppImage "$SRC/apps/desktop/out/wsl-linux/"
    ;;
  smoke)
    pnpm run build
    node scripts/smoke-server.mjs
    ;;
  test)
    pnpm run build:packages
    pnpm -r --workspace-concurrency=1 run test
    ;;
esac
