#pragma once
// Minimal ggml shim for the standalone GBNF validator. Provides only the two
// macros llama-grammar.cpp uses (GGML_ASSERT, GGML_ABORT). Hand-written
// adaptation — NOT a verbatim upstream copy (see llama/PROVENANCE.md).
#include <cstdio>
#include <cstdlib>

#define GGML_ASSERT(x)                                                            \
    do {                                                                          \
        if (!(x)) {                                                               \
            fprintf(stderr, "GGML_ASSERT failed: %s (%s:%d)\n", #x, __FILE__, __LINE__); \
            abort();                                                              \
        }                                                                         \
    } while (0)

#define GGML_ABORT(...)                                                           \
    do {                                                                          \
        fprintf(stderr, "GGML_ABORT (%s:%d): ", __FILE__, __LINE__);             \
        fprintf(stderr, __VA_ARGS__);                                             \
        fprintf(stderr, "\n");                                                    \
        abort();                                                                  \
    } while (0)

#define GGML_UNUSED(x) (void)(x)
