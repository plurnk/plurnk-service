// Tokenizer strategies shared by every provider's countTokens(). Centralizes
// the gpt-tokenizer / llama-tokenizer-js deps (each sibling pulled them in
// separately) and the per-publisher dispatch maps that openrouter and
// cloudflare had independently re-invented.
//
// countTokens is synchronous by contract (SPEC §2), so only client-side
// tokenizers qualify. "heuristic" (chars/4) is the safe default for any
// upstream whose tokenizer we can't run locally.

import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import llamaTokenizer from "llama-tokenizer-js";

export type TokenizerFamily = "heuristic" | "cl100k" | "llama";

export type CountTokens = (text: string) => number;

const heuristic: CountTokens = (text) => (text.length === 0 ? 0 : Math.ceil(text.length / 4));
const cl100k: CountTokens = (text) => (text.length === 0 ? 0 : encodeCl100k(text).length);
const llama: CountTokens = (text) => (text.length === 0 ? 0 : llamaTokenizer.encode(text).length);

const STRATEGIES: Readonly<Record<TokenizerFamily, CountTokens>> = Object.freeze({ heuristic, cl100k, llama });

export const tokenizerFor = (family: TokenizerFamily): CountTokens => STRATEGIES[family];

// Parse an operator-declared tokenizer override (e.g. OPENAI_TOKENIZER).
// Accepts a legacy "cl100k_base" spelling for back-compat with the openai
// sibling's existing env contract.
export const parseTokenizerFamily = (raw: string | undefined, fallback: TokenizerFamily, envName: string, label: string): TokenizerFamily => {
    if (raw === undefined || raw.length === 0) return fallback;
    if (raw === "cl100k_base") return "cl100k";
    if (raw === "heuristic" || raw === "cl100k" || raw === "llama") return raw;
    throw new Error(`${label} provider: ${envName} must be one of "heuristic", "cl100k", "llama" (got "${raw}")`);
};

// Dispatch a tokenizer family from a model id's publisher segment. Relay
// providers (openrouter, cloudflare) route across many upstream families, so
// the family is read from the id prefix. `index` selects which "/"-segment
// holds the publisher (0 for "anthropic/claude…", 1 for "@cf/meta/llama…").
export const tokenizerByPublisher = (
    model: string,
    table: ReadonlyMap<string, TokenizerFamily>,
    index = 0,
): TokenizerFamily => {
    const publisher = model.split("/")[index];
    return publisher !== undefined ? table.get(publisher) ?? "heuristic" : "heuristic";
};
