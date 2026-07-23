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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/llama"

source "$ROOT/scripts/llama-pin.sh"

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

SHA="$LLAMA_SHA"
BASE="https://raw.githubusercontent.com/$LLAMA_REPO/$SHA"
PROV="$DEST/PROVENANCE.md"

mkdir -p "$DEST"
{
  echo "# llama/ provenance"
  echo
  echo "Verbatim copies of the llama.cpp GBNF oracle sources. **Do not edit by hand** —"
  echo "regenerate with \`npm run build:fetchLlamaGrammar\`. Adaptation toward llama-gbnf.c"
  echo "happens in the build:llama step and is diffable against these originals."
  echo
  echo "- repo: https://github.com/$LLAMA_REPO"
  echo "- pinned commit: \`$SHA\`"
  echo "- update check: \`npm run oracle:check\`"
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

echo "fetchLlamaGrammar: ${#FILES[@]} files from $LLAMA_REPO@${SHA:0:12} -> llama/" >&2
