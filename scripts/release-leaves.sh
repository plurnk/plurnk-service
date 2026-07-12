#!/usr/bin/env bash
# Post-platform-publish leaf adopt + publish (MIGRATION step 8c). Run AFTER every
# monorepo workspace is live on npm. Per outside leaf: fresh resolve against the
# 1.0.0 platform, full suite, publish. Fail-hard: stops on the first red leaf.
# Usage: scripts/release-leaves.sh   (npm prompts for OTP per publish)
set -euo pipefail
META="$(cd "$(dirname "$0")/../.." && pwd)"

for dir in "$META"/plurnk-mimetypes-* "$META"/plurnk-providers-* "$META"/plurnk-execs-wasm; do
  [ -f "$dir/package.json" ] || continue
  name=$(node -p "require('$dir/package.json').name")
  echo "== $name"
  ( cd "$dir"
    rm -rf node_modules package-lock.json
    npm install --no-audit --no-fund
    npm test
    npm publish )
done
echo "DONE — all leaves adopted and published"
