#!/usr/bin/env bash
# Cut a release: bump the version, write the changelog, commit, tag, push.
#
#   bash scripts/release.sh minor   # 0.1.2 → 0.2.0
#   bash scripts/release.sh major   # 0.1.2 → 1.0.0
#   bash scripts/release.sh patch   # 0.1.2 → 0.1.3
#
# What it does:
#   1. Bumps the version in every package.json (all packages share one version)
#   2. Prepends the git log since the last tag to CHANGELOG.md
#   3. Commits the bump + changelog as "Release X.Y.Z"
#   4. Tags the commit vX.Y.Z
#   5. Pushes the branch and the tag (triggers desktop-release + publish-images)
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

BUMP="${1:-}"
if [[ "$BUMP" != minor && "$BUMP" != major && "$BUMP" != patch ]]; then
  echo "usage: bash scripts/release.sh minor|major|patch" >&2
  exit 1
fi

# Ensure we are on main and up to date.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != main ]]; then
  echo "error: must be on main (currently on $BRANCH)" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is not clean — commit or stash first" >&2
  exit 1
fi
git fetch --tags --quiet

CURRENT=$(node -p "require('./apps/desktop/package.json').version")
IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"

case "$BUMP" in
  major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
  minor) MIN=$((MIN + 1)); PAT=0 ;;
  patch) PAT=$((PAT + 1)) ;;
esac
NEXT="$MAJ.$MIN.$PAT"
TAG="v$NEXT"

echo "▸ $CURRENT → $NEXT"

# Confirm before touching anything.
read -rp "  Release $TAG and push? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "aborted"; exit 0; }

# 1 ---------------------------------------------------------------- bump versions
PACKAGES=(
  apps/desktop/package.json
  apps/server/package.json
  apps/mobile/package.json
  packages/contracts/package.json
  packages/logger/package.json
  packages/ui-tokens/package.json
)
for pkg in "${PACKAGES[@]}"; do
  if [[ -f "$pkg" ]]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
      p.version = '$NEXT';
      fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
    "
    echo "  bumped $pkg"
  fi
done

# 2 ---------------------------------------------------------------- changelog
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
echo "▸ writing changelog (since ${LAST_TAG:-the beginning})"

{
  echo "## $TAG — $(date +%Y-%m-%d)"
  echo
  if [[ -n "$LAST_TAG" ]]; then
    # One line per commit, skip merge commits, most recent first.
    git log "$LAST_TAG..HEAD" --no-merges --pretty=format:"- %s" | grep -v '^- $' || true
  else
    git log --no-merges --pretty=format:"- %s" | grep -v '^- $' || true
  fi
  echo
  echo
} > /tmp/release-entry.md

if [[ -f CHANGELOG.md ]]; then
  cat /tmp/release-entry.md CHANGELOG.md > /tmp/changelog-new.md
else
  cp /tmp/release-entry.md /tmp/changelog-new.md
fi
mv /tmp/changelog-new.md CHANGELOG.md
echo "  CHANGELOG.md updated"

# 3 ---------------------------------------------------------------- commit + tag
git add "${PACKAGES[@]}" CHANGELOG.md
git commit -m "Release $NEXT"
git tag "$TAG"
echo "▸ tagged $TAG"

# 4 ---------------------------------------------------------------- push
git push origin main
git push origin "$TAG"
echo
echo "✓ $TAG pushed — desktop-release and publish-images are running."
