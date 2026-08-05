// Usage normalization + cost — the shared token-accounting model.
//
// Providers report token usage in two incompatible ways:
//   - OpenAI-style: reasoning is a SUBSET of completion_tokens, surfaced via
//     completion_tokens_details.reasoning_tokens; total = prompt + completion.
//   - Gemini-style: reasoning is OMITTED from completion_tokens and only
//     recoverable as total - prompt - completion (no details field at all).
//   - Fireworks-style: reasoning ships as TEXT (reasoning_content) but is folded
//     into completion_tokens with NO reasoning_tokens itemization -- unrecoverable
//     from the numbers alone, so it is re-split from the emitted text lengths.
// normalizeUsage collapses all three into one invariant (see ProviderUsage):
//   total = prompt + completion + reasoning;  cached ⊆ prompt;
//   completion EXCLUDES reasoning;  billable output = completion + reasoning.

import type { ProviderUsage } from "./types.ts";

// Raw OpenAI-compatible usage block — the superset of fields providers emit.
export type RawUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
};

export const normalizeUsage = (raw: RawUsage | null | undefined, reasoningText = "", contentText = ""): ProviderUsage => {
    const prompt = raw?.prompt_tokens ?? 0;
    const completionRaw = raw?.completion_tokens ?? 0;
    const reportedTotal = raw?.total_tokens ?? 0;
    // OpenAI nests cached under prompt_tokens_details; others put it top-level.
    const cached = raw?.prompt_tokens_details?.cached_tokens
        ?? raw?.prompt_cache_hit_tokens
        ?? raw?.cached_tokens
        ?? 0;
    const reasoningDetail = raw?.completion_tokens_details?.reasoning_tokens;

    let completion: number;
    let reasoning: number;
    if (reasoningDetail !== undefined) {
        reasoning = reasoningDetail;
        // reasoning_tokens is reported two incompatible ways when detailed. OpenAI
        // o-series folds it INTO completion_tokens (subset: total = prompt + completion,
        // so completion must have reasoning subtracted out). xAI/Grok reports it
        // ADDITIVE to a visible-only completion_tokens (total = prompt + completion +
        // reasoning), where subtracting wrongly zeroes the visible output. Tell
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
        // Fireworks folds reasoning INTO completion_tokens and itemizes no
        // reasoning_tokens, so a turn that shipped only reasoning reads reasoning=0
        // though 300k chars of it arrived. When reasoning TEXT came back but
        // the reported totals leave no gap, re-split the reported completion by the
        // emitted text proportions. Sum-preserving: billable output
        // (completion+reasoning) and cost are byte-identical; only the
        // visible/reasoning gauge is corrected (pure-reasoning turn -> completion 0).
        if (reasoning === 0 && reasoningText.length > 0 && reportedTotal > 0 && completionRaw > 0) {
            reasoning = Math.round(completionRaw * reasoningText.length / (reasoningText.length + contentText.length));
            completion = completionRaw - reasoning;
        }
    }
    const total = reportedTotal > 0 ? reportedTotal : prompt + completion + reasoning;
    return { prompt, completion, reasoning, cached, total };
};

// Conventional provider pricing: USD per million tokens, matching Models.dev.
export type TokenRates = { input: number; output: number; cached: number };

// The one cost formula every provider uses: non-cached prompt at the input
// rate, cached prompt at the cache rate, and billable output (completion +
// reasoning) at the output rate.
export const calculateCostUsd = (usage: ProviderUsage, rates: TokenRates): number => {
    const nonCachedPrompt = Math.max(0, usage.prompt - usage.cached);
    const output = usage.completion + usage.reasoning;
    return (
        nonCachedPrompt * rates.input
        + usage.cached * rates.cached
        + output * rates.output
    ) / 1_000_000;
};
