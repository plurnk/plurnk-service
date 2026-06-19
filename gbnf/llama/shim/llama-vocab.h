#pragma once
// Minimal llama-vocab.h shim. The standalone validator always runs with a null
// vocab, so the three methods llama-grammar.cpp references (token-grammar paths)
// are never reached at runtime — they exist only to satisfy the linker and abort
// loudly if ever called. Hand-written adaptation — NOT a verbatim upstream copy
// (see llama/PROVENANCE.md).
#include "llama.h"
#include "ggml.h"
#include <cstdint>
#include <string>

struct llama_vocab {
    int32_t tokenize(const char * /*text*/, int32_t /*text_len*/, llama_token * /*tokens*/,
                     int32_t /*n_tokens_max*/, bool /*add_special*/, bool /*parse_special*/) const {
        GGML_ABORT("llama-gbnf: token grammars unsupported (null-vocab validator)");
        return 0;
    }

    std::string token_to_piece(llama_token /*token*/) const {
        GGML_ABORT("llama-gbnf: token grammars unsupported (null-vocab validator)");
        return {};
    }

    bool is_eog(llama_token /*token*/) const {
        GGML_ABORT("llama-gbnf: token grammars unsupported (null-vocab validator)");
        return false;
    }
};
