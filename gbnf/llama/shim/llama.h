#pragma once
// Minimal llama.h shim for the standalone GBNF validator. Provides only the types
// llama-grammar.{h,cpp} reference. Hand-written adaptation — NOT a verbatim
// upstream copy (see llama/PROVENANCE.md).
#include "ggml.h"  // upstream llama.h pulls in ggml.h; consumers expect GGML_* here

#include <cstdint>
#include <cstddef>

typedef int32_t llama_token;

typedef struct llama_token_data {
    llama_token id;
    float       logit;
    float       p;
} llama_token_data;

typedef struct llama_token_data_array {
    llama_token_data * data;
    size_t             size;
    int64_t            selected;
    bool               sorted;
} llama_token_data_array;

struct llama_vocab;
