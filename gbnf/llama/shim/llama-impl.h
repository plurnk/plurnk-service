#pragma once
// Minimal llama-impl.h shim: the logging macros llama-grammar.cpp uses, routed to
// stderr (ERROR) / dropped (DEBUG). Hand-written adaptation — NOT a verbatim
// upstream copy (see llama/PROVENANCE.md).
#include "ggml.h"
#include <cstdio>

#define LLAMA_LOG_ERROR(...) fprintf(stderr, __VA_ARGS__)
#define LLAMA_LOG_DEBUG(...) ((void) 0)
