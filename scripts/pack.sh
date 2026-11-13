#!/usr/bin/env bash
# Build the app and pack what the computer needs to run it (no secrets, no node_modules).
# Usage: scripts/pack.sh [output.tgz]      DRY_RUN=1 scripts/pack.sh   # list, build nothing
# On the computer: scripts/install-on-computer.sh <the .tgz> does the rest (it is also inside the pack).
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-hq-app.tgz}"

# What the installer needs and nothing more: the workspace manifests (it runs
# `pnpm install --prod --frozen-lockfile` on the computer), the built server and web client, the
# three built workspace packages (their exports point at dist/), the box/ files the server reads
# at runtime, and the parent-relative web path desk.ts reads its avatar art from.
files=(
  package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc .env.example
  apps/server/package.json apps/server/tsconfig.json
  apps/server/dist apps/server/box apps/server/docker
  apps/web/package.json apps/web/dist apps/web/src/avatar/shapes.gen.ts
  packages/contracts packages/logger packages/ui-tokens
  scripts/install-on-computer.sh scripts/add-hq-to-hermes.py scripts/sign-in-link.sh
)

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "(dry run) would build: pnpm build"
  printf '(dry run) would pack into %s: %s\n' "$out" "${files[*]}"
  exit 0
fi

# Rebuild from source: the pack carries dist/, never the TypeScript it came from. turbo builds the
# packages before the apps (dependsOn ^build), which is the order the imports need.
rm -rf apps/server/dist apps/web/dist packages/*/dist
pnpm build

# node_modules is a pnpm store of symlinks into the machine that built it — never pack it; the
# installer installs production dependencies on the computer instead.
tar -czf "$out" --exclude='node_modules' --exclude='*/node_modules' "${files[@]}"
echo "packed $(du -h "$out" | cut -f1) -> $out"
