// Usage normalization + cost — the shared token-accounting model.
//
// Providers report token usage in two incompatible ways:
//   - OpenAI-style: reasoning is a SUBSET of completion_tokens, surfaced via
//     completion_tokens_details.reasoning_tokens; total = prompt + completion.
//   - Gemini-style: reasoning is OMITTED from completion_tokens and only
//     recoverable as total - prompt - completion (no details field at all).
// normalizeUsage collapses both into one invariant (see ProviderUsage):
//   total = prompt + completion + reasoning;  cached ⊆ prompt;
//   completion EXCLUDES reasoning;  billable output = completion + reasoning.

import type { ProviderUsage } from "./types.ts";

// Raw OpenAI-compatible usage block — the superset of fields providers emit.
export type RawUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
};

export const normalizeUsage = (raw: RawUsage | null | undefined): ProviderUsage => {
    const prompt = raw?.prompt_tokens ?? 0;
    const completionRaw = raw?.completion_tokens ?? 0;
    const reportedTotal = raw?.total_tokens ?? 0;
    // OpenAI nests cached under prompt_tokens_details; others put it top-level.
    const cached = raw?.prompt_tokens_details?.cached_tokens ?? raw?.cached_tokens ?? 0;
    const reasoningDetail = raw?.completion_tokens_details?.reasoning_tokens;

    let completion: number;
    let reasoning: number;
    if (reasoningDetail !== undefined) {
        reasoning = reasoningDetail;
        // reasoning_tokens is reported two incompatible ways when detailed. OpenAI
        // o-series folds it INTO completion_tokens (subset: total = prompt + completion,
        // so completion must have reasoning subtracted out). xAI/Grok reports it
        // ADDITIVE to a visible-only completion_tokens (total = prompt + completion +
        // reasoning), where subtracting wrongly zeroes the visible output (#28). Tell
        // them apart by the total identity; with no total reported, fall back on the
        // impossible-subset signal — reasoning can't exceed the completion it's a
        // subset of.
        const additive = reportedTotal > 0
            ? reportedTotal === prompt + completionRaw + reasoningDetail
            : completionRaw < reasoningDetail;
        completion = additive ? completionRaw : Math.max(0, completionRaw - reasoningDetail);
    } else {
        // Gemini-style (or no reasoning): tokens beyond prompt+completion are
        // reasoning. Only trust the gap when a total was actually reported.
        reasoning = reportedTotal > 0 ? Math.max(0, reportedTotal - prompt - completionRaw) : 0;
        completion = completionRaw;
    }
    const total = reportedTotal > 0 ? reportedTotal : prompt + completion + reasoning;
    return { prompt, completion, reasoning, cached, total };
};

// Per-token rates in pico-USD (1e-12 USD).
export type TokenRates = { input: number; output: number; cached: number };

// The one cost formula every provider uses: non-cached prompt at the input
// rate, cached prompt at the cache rate, and billable output (completion +
// reasoning) at the output rate.
export const computeCost = (usage: ProviderUsage, rates: TokenRates): number => {
    const nonCachedPrompt = Math.max(0, usage.prompt - usage.cached);
    const output = usage.completion + usage.reasoning;
    return Math.round(nonCachedPrompt * rates.input + usage.cached * rates.cached + output * rates.output);
};
