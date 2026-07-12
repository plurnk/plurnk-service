#!/usr/bin/env bash
# Compile the standalone GBNF validator oracle: build/llama-gbnf.
#
# Links the verbatim llama.cpp sources in llama/src + the no-model harness in
# llama/tests against the hand-written shims in llama/shim that stand in for the
# full llama.cpp/ggml stack on the null-vocab validator path. The vendored sources
# are never edited (AGENTS.md Charter §6); all adaptation lives in llama/shim.
#
# Assumes a standard Ubuntu build-essential POSIX toolchain (AGENTS.md Charter §8).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/llama/src"
SHIM="$ROOT/llama/shim"
TESTS="$ROOT/llama/tests"
OUT="$ROOT/build"

[ -f "$SRC/llama-grammar.cpp" ] || {
  echo "buildLlama: llama/src is missing — run \`npm run build:fetchLlamaGrammar\` first." >&2
  exit 1
}

CXX="${CXX:-g++}"
mkdir -p "$OUT"

# Shim include dir first so its llama.h / llama-impl.h / llama-vocab.h / llama-sampler.h
# resolve ahead of anything else; llama/src for the engine's own headers.
"$CXX" -std=c++17 -O2 -Wall -Wno-unused-parameter -Wno-unused-function \
  -I "$SHIM" -I "$SRC" \
  "$SRC/llama-grammar.cpp" \
  "$SRC/unicode.cpp" \
  "$SRC/unicode-data.cpp" \
  "$TESTS/test-gbnf-validator.cpp" \
  -o "$OUT/llama-gbnf"

echo "buildLlama: -> build/llama-gbnf" >&2
