#!/usr/bin/env bash
# Fetch the llama.cpp GBNF oracle sources verbatim into llama/.
#
# Copied, never confabulated (AGENTS.md Charter §6). NO adaptation happens here:
# files land byte-identical to upstream, preserving their src/ and tests/ layout so
# their relative #includes still resolve. The prune/stub toward a self-contained
# llama-gbnf.c is the separate build:llama step, diffable against these originals.
#
# The oracle is the standalone GBNF validator: a .gbnf grammar + a UTF-8 string in,
# accept/reject + error position out, with no model/vocab involved.
set -euo pipefail

REPO="ggml-org/llama.cpp"
REF="master"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/llama"

# Pinned upstream commit. We deliberately track ONE reviewed commit, not the moving
# tip. The drift gate below BREAKS the fetch the moment master advances past this pin
# — a forcing function so *we* review upstream changes and re-pin on purpose, instead
# of silently drifting and letting the mismatch surface in users' llama.cpp installs.
# Bumping it is a conscious step: review the upstream diff, set the new SHA, re-verify.
LLAMA_SHA="0d2d9ccbf6aae92de310712297fd52becc134092"

# Grammar engine + UTF-8 dependency + the no-model validator harness.
FILES=(
  "src/llama-grammar.cpp"
  "src/llama-grammar.h"
  "src/unicode.cpp"
  "src/unicode.h"
  "src/unicode-data.cpp"
  "src/unicode-data.h"
  "tests/test-gbnf-validator.cpp"
)

# Drift gate: read upstream master's current HEAD and fail hard if it has moved past
# our pin. Buffer the JSON first — piping curl straight into `grep -m1` closes the pipe
# early and trips curl's write-failure (exit 23) under `pipefail`.
JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$REF")"
HEAD_SHA="$(printf '%s' "$JSON" | grep -m1 '"sha"' | cut -d'"' -f4)"
[ -n "$HEAD_SHA" ] || { echo "fetchLlamaGrammar: could not resolve $REPO@$REF" >&2; exit 1; }

if [ "$HEAD_SHA" != "$LLAMA_SHA" ]; then
  {
    echo "fetchLlamaGrammar: $REPO@$REF has moved past our pin — drift gate tripped."
    echo "  pinned : $LLAMA_SHA"
    echo "  master : $HEAD_SHA"
    echo "  Review the upstream changes, bump LLAMA_SHA, re-run, and re-verify the oracle."
  } >&2
  exit 1
fi

SHA="$LLAMA_SHA"
BASE="https://raw.githubusercontent.com/$REPO/$SHA"
PROV="$DEST/PROVENANCE.md"

mkdir -p "$DEST"
{
  echo "# llama/ provenance"
  echo
  echo "Verbatim copies of the llama.cpp GBNF oracle sources. **Do not edit by hand** —"
  echo "regenerate with \`npm run build:fetchLlamaGrammar\`. Adaptation toward llama-gbnf.c"
  echo "happens in the build:llama step and is diffable against these originals."
  echo
  echo "- repo: https://github.com/$REPO"
  echo "- pinned commit: \`$SHA\`"
  echo "- drift gate: \`npm run build:fetchLlamaGrammar\` fails when \`$REF\` moves past this pin."
  echo
  echo "| file | sha256 |"
  echo "| --- | --- |"
} > "$PROV"

for f in "${FILES[@]}"; do
  out="$DEST/$f"
  mkdir -p "$(dirname "$out")"
  curl -fsSL "$BASE/$f" -o "$out"
  sum="$(sha256sum "$out" | cut -d' ' -f1)"
  printf '| `%s` | `%s` |\n' "$f" "$sum" >> "$PROV"
  echo "fetchLlamaGrammar: $f" >&2
done

echo "fetchLlamaGrammar: ${#FILES[@]} files from $REPO@${SHA:0:12} -> llama/" >&2
