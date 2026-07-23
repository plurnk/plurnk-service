#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/llama-pin.sh"

JSON="$(curl -fsSL "https://api.github.com/repos/$LLAMA_REPO/commits/$LLAMA_REF")"
HEAD_SHA="$(printf '%s' "$JSON" | grep -m1 '"sha"' | cut -d'"' -f4)"
[ -n "$HEAD_SHA" ] || { echo "could not resolve $LLAMA_REPO@$LLAMA_REF" >&2; exit 1; }

if [ "$HEAD_SHA" = "$LLAMA_SHA" ]; then
    echo "llama.cpp oracle pin is current: $LLAMA_SHA"
    exit 0
fi

echo "llama.cpp oracle update available"
echo "  pinned: $LLAMA_SHA"
echo "  latest: $HEAD_SHA"
exit 1
