import type { TokenizeFn } from "./types.ts";

// Conservative fallback token-count heuristic. Uses text.length / 2 (not the
// industry-standard /4) because /4 underestimates and overflows budgets in
// real-world content. Bias to safety: a preview that comes in 30% under
// budget is a non-event; one that comes in over budget breaks a context
// window.
//
// Consumers (notably plurnk-service) inject a real tokenize function sourced
// from the active provider. This default is for standalone use, tests, and
// any path where a real tokenizer isn't available.
export const defaultTokenize: TokenizeFn = async (text) => Math.ceil(text.length / 2);
