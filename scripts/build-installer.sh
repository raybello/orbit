#!/usr/bin/env bash
# Build the desktop installer for one platform, the same way the release workflow does, but
# without publishing anything.
#
#   bash scripts/build-installer.sh mac            # DMG + zip for this Mac's chip
#   ARCH=all bash scripts/build-installer.sh mac   # Apple silicon and Intel
#   bash scripts/build-installer.sh win            # NSIS .exe (local on Windows, else GitHub Actions)
#   bash scripts/build-installer.sh linux          # AppImage
#
# Output lands in apps/desktop/out (CI builds in apps/desktop/out/ci-<platform>), followed by each
# file's size and SHA-256.
#
# Signing: with no CSC_LINK the macOS app is ad-hoc signed by scripts/after-pack.cjs, exactly like
# an unsigned release. Set CSC_LINK / CSC_KEY_PASSWORD to sign with a Developer ID instead.
#
# The native Mac stack needs resources/server-bundle.json, which only the release workflow
# produces. When a release for this version exists, its manifest is fetched so the local build
# can offer the native stack too; otherwise the build simply has Docker as its only stack.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

PLATFORM="${1:-}"
DESKTOP=apps/desktop
VERSION=$(node -p "require('./$DESKTOP/package.json').version")
REPO="${ORBIT_REPO:-raybello/orbit}"

case "$PLATFORM" in
  mac|win|linux) ;;
  *) echo "usage: bash scripts/build-installer.sh mac|win|linux" >&2; exit 2 ;;
esac

# An empty CSC_LINK is read as a path ("apps/desktop not a file"), so it must be absent.
if [ -z "${CSC_LINK:-}" ]; then
  unset CSC_LINK CSC_KEY_PASSWORD
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

checksums() {
  echo "▸ artifacts"
  local found=0
  for f in "$@"; do
    [ -f "$f" ] || continue
    found=1
    printf '  %-48s %8s  %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
  done
  [ "$found" = 1 ] || { echo "  ✗ no installer was produced" >&2; exit 1; }
}

build_inputs() {
  echo "▸ building shared packages, the web renderer and the desktop bundle"
  pnpm run build:packages
  pnpm --filter @orbit/web run build
  pnpm --filter @orbit/desktop run build

  mkdir -p "$DESKTOP/resources"
  if [ -f "$DESKTOP/resources/server-bundle.json" ]; then
    echo "▸ using the existing $DESKTOP/resources/server-bundle.json"
  elif command -v gh >/dev/null 2>&1 && gh release view "v$VERSION" -R "$REPO" >/dev/null 2>&1; then
    echo "▸ fetching server-bundle.json from release v$VERSION (enables the native Mac stack)"
    gh release download "v$VERSION" -R "$REPO" -p server-bundle.json -D "$DESKTOP/resources" --clobber \
      || echo "  (could not fetch it; the build will only offer the Docker stack)"
  else
    echo "▸ no v$VERSION release to take server-bundle.json from; the build will only offer the Docker stack"
  fi
  pnpm --filter @orbit/desktop run check-resources
}

case "$PLATFORM" in
  mac)
    [ "$(uname -s)" = "Darwin" ] || { echo "✗ macOS installers can only be built on a Mac" >&2; exit 1; }
    case "${ARCH:-host}" in
      host) [ "$(uname -m)" = "arm64" ] && ARCH_FLAGS=(--arm64) || ARCH_FLAGS=(--x64) ;;
      all) ARCH_FLAGS=(--arm64 --x64) ;;
      arm64|x64) ARCH_FLAGS=("--$ARCH") ;;
      *) echo "✗ ARCH must be host, all, arm64 or x64" >&2; exit 2 ;;
    esac
    build_inputs
    rm -rf "$DESKTOP/out"
    echo "▸ electron-builder --mac dmg zip ${ARCH_FLAGS[*]}"
    (cd "$DESKTOP" && npx electron-builder --mac dmg zip "${ARCH_FLAGS[@]}" --publish never)
    APP=$(ls -d "$DESKTOP"/out/mac*/Orbit.app | head -1)
    codesign --verify --deep --strict "$APP" && echo "▸ signature ok ($(codesign -dv "$APP" 2>&1 | sed -n 's/^Signature=//p'))"
    checksums "$DESKTOP"/out/*.dmg "$DESKTOP"/out/*.zip
    echo "  Try it in an isolated profile: bash scripts/try-installer.sh"
    ;;

  linux)
    build_inputs
    rm -rf "$DESKTOP/out"
    (cd "$DESKTOP" && npx electron-builder --linux AppImage --x64 --publish never)
    checksums "$DESKTOP"/out/*.AppImage
    ;;

  win)
    case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LOCAL_WIN=1 ;; *) LOCAL_WIN=0 ;; esac
    if [ "$LOCAL_WIN" = 0 ] && command -v wine >/dev/null 2>&1; then LOCAL_WIN=1; fi
    if [ "$LOCAL_WIN" = 1 ]; then
      build_inputs
      rm -rf "$DESKTOP/out"
      (cd "$DESKTOP" && npx electron-builder --win nsis --x64 --publish never)
      checksums "$DESKTOP"/out/*.exe
      exit 0
    fi

    # No Windows toolchain here (NSIS and the icon/version step need Windows or Wine), so build on
    # GitHub's Windows runner with publishing off and download the result.
    command -v gh >/dev/null 2>&1 || { echo "✗ needs the GitHub CLI (gh) to build on GitHub Actions" >&2; exit 1; }
    REF="${ORBIT_REF:-$(git rev-parse --abbrev-ref HEAD)}"
    if [ "$(git rev-parse "$REF")" != "$(git rev-parse "origin/$REF" 2>/dev/null || echo none)" ]; then
      echo "✗ $REF is not pushed (or differs from origin/$REF); Actions builds what is on GitHub" >&2
      exit 1
    fi
    # A workflow without the PUBLISH switch publishes every run, which would overwrite the live
    # release's installers. Refuse unless the copy on GitHub can build without releasing.
    if ! gh api "repos/$REPO/contents/.github/workflows/desktop-release.yml?ref=$REF" --jq .content 2>/dev/null \
        | base64 --decode 2>/dev/null | grep -q 'PUBLISH:'; then
      echo "✗ the release workflow on $REF publishes every run; push the version with the PUBLISH switch first" >&2
      exit 1
    fi
    echo "▸ no local Windows toolchain: building on GitHub Actions ($REPO @ $REF, publish off)"
    BEFORE=$(gh run list -R "$REPO" -w desktop-release.yml -L 1 --json databaseId --jq '.[0].databaseId // 0')
    gh workflow run desktop-release.yml -R "$REPO" --ref "$REF" -f publish=false
    RUN=""
    for _ in $(seq 1 30); do
      RUN=$(gh run list -R "$REPO" -w desktop-release.yml -e workflow_dispatch -L 1 --json databaseId --jq '.[0].databaseId // 0')
      [ "$RUN" != "0" ] && [ "$RUN" != "$BEFORE" ] && break
      sleep 2
    done
    [ -n "$RUN" ] && [ "$RUN" != "$BEFORE" ] || { echo "✗ the workflow run did not appear" >&2; exit 1; }
    echo "  https://github.com/$REPO/actions/runs/$RUN"
    gh run watch "$RUN" -R "$REPO" --interval 20 || true
    OUT="$DESKTOP/out/ci-win"
    rm -rf "$OUT" && mkdir -p "$OUT"
    gh run download "$RUN" -R "$REPO" -n orbit-desktop-win -D "$OUT" \
      || { echo "✗ the Windows build produced no artifact; see the run log above" >&2; exit 1; }
    checksums "$OUT"/*.exe
    ;;
esac
