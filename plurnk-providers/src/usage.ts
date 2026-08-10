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

// Some providers return distinct reasoning text while reporting one combined
// output count. Attribute that count without disturbing an upstream split.
export const attributeUnitemizedReasoning = (
    usage: ProviderUsage,
    reasoningText: string,
    contentText: string,
): ProviderUsage => {
    if (usage.reasoning !== 0 || usage.completion === 0 || reasoningText.length === 0) return usage;
    const reasoning = contentText.length === 0
        ? usage.completion
        : Math.round(usage.completion * reasoningText.length / (reasoningText.length + contentText.length));
    return {
        ...usage,
        completion: usage.completion - reasoning,
        reasoning,
    };
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
    }
    const total = reportedTotal > 0 ? reportedTotal : prompt + completion + reasoning;
    const usage = { prompt, completion, reasoning, cached, total };
    // Fireworks folds reasoning INTO completion_tokens and itemizes no
    // reasoning_tokens. A reported total establishes that completion is an
    // upstream quantity rather than a locally synthesized fallback.
    return reasoningDetail === undefined && reportedTotal > 0
        ? attributeUnitemizedReasoning(usage, reasoningText, contentText)
        : usage;
};

// Conventional provider pricing: USD per million tokens, matching Models.dev.
export type TokenRates = { input: number; output: number; cached: number };

const decimalParts = (value: number): { coefficient: bigint; scale: number } => {
    if (!Number.isFinite(value) || value < 0) {
        throw new TypeError("token rates must be finite non-negative numbers");
    }
    const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
    if (match === null) throw new TypeError(`cannot represent token rate ${value} as a decimal`);
    const fraction = match[2] ?? "";
    const exponent = Number(match[3] ?? "0");
    const scale = fraction.length - exponent;
    const coefficient = BigInt(`${match[1]}${fraction}`);
    return scale < 0
        ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
        : { coefficient, scale };
};

const decimalString = (coefficient: bigint, scale: number): string => {
    const digits = String(coefficient).padStart(scale + 1, "0");
    if (scale === 0) return digits;
    const integer = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, "");
    return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

// Models.dev rates are decimal USD-per-million values. Calculate their
// projection as decimal arithmetic so ProviderCost preserves the table and
// exact response counts without binary floating-point artifacts.
export const calculateCostUsdDecimal = (usage: ProviderUsage, rates: TokenRates): string => {
    const parts = [rates.input, rates.cached, rates.output].map(decimalParts);
    const rateScale = Math.max(...parts.map(({ scale }) => scale));
    const [input, cached, output] = parts.map(({ coefficient, scale }) =>
        coefficient * 10n ** BigInt(rateScale - scale));
    const nonCachedPrompt = Math.max(0, usage.prompt - usage.cached);
    const outputTokens = usage.completion + usage.reasoning;
    const coefficient = BigInt(nonCachedPrompt) * input!
        + BigInt(usage.cached) * cached!
        + BigInt(outputTokens) * output!;
    return decimalString(coefficient, rateScale + 6);
};

// The one cost formula every provider uses: non-cached prompt at the input
// rate, cached prompt at the cache rate, and billable output (completion +
// reasoning) at the output rate.
export const calculateCostUsd = (usage: ProviderUsage, rates: TokenRates): number => {
    return Number(calculateCostUsdDecimal(usage, rates));
};
