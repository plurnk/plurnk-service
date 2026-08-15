// Provider usage normalization. The public shape follows {§provider-usage}:
// input/output totals own their optional cache/reasoning details, absence is
// unknown, and no token category is inferred from text length.

import type { ProviderUsage } from "./types.ts";

export type RawUsage = {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_read_tokens?: number;
        cache_write_tokens?: number;
    };
    input_tokens_details?: {
        cached_tokens?: number;
        cache_read_tokens?: number;
        cache_write_tokens?: number;
    };
    completion_tokens_details?: { reasoning_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
    reasoning_tokens?: number;
};

const knownTokens = (value: unknown, name: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    return value as number;
};

const nonEmptyDetails = <T extends Record<string, number | undefined>>(details: T): T | undefined => {
    const entries = Object.entries(details).filter((entry): entry is [string, number] =>
        entry[1] !== undefined);
    return entries.length === 0 ? undefined : Object.fromEntries(entries) as T;
};

export const validateProviderUsage = (usage: ProviderUsage): ProviderUsage => {
    const input = knownTokens(usage.inputTokens, "provider usage.inputTokens");
    const output = knownTokens(usage.outputTokens, "provider usage.outputTokens");
    const total = knownTokens(usage.totalTokens, "provider usage.totalTokens");
    const inputDetails = usage.inputTokenDetails;
    const outputDetails = usage.outputTokenDetails;

    if (input === undefined && output === undefined && total === undefined
        && inputDetails === undefined && outputDetails === undefined) {
        throw new TypeError("provider usage must contain at least one known quantity");
    }
    if (input !== undefined && output !== undefined && total !== undefined
        && total !== input + output) {
        throw new TypeError("provider usage.totalTokens must equal inputTokens + outputTokens");
    }

    if (inputDetails !== undefined) {
        const values = [
            knownTokens(inputDetails.noCacheTokens, "provider usage.inputTokenDetails.noCacheTokens"),
            knownTokens(inputDetails.cacheReadTokens, "provider usage.inputTokenDetails.cacheReadTokens"),
            knownTokens(inputDetails.cacheWriteTokens, "provider usage.inputTokenDetails.cacheWriteTokens"),
        ];
        if (values.every((value) => value === undefined)) {
            throw new TypeError("provider usage.inputTokenDetails must contain a known quantity");
        }
        const known = values.filter((value): value is number => value !== undefined);
        if (input !== undefined && known.some((value) => value > input)) {
            throw new TypeError("provider input-token detail must not exceed inputTokens");
        }
        if (input !== undefined && values.every((value) => value !== undefined)
            && known.reduce((sum, value) => sum + value, 0) !== input) {
            throw new TypeError("complete provider input-token details must sum to inputTokens");
        }
    }

    if (outputDetails !== undefined) {
        const values = [
            knownTokens(outputDetails.textTokens, "provider usage.outputTokenDetails.textTokens"),
            knownTokens(outputDetails.reasoningTokens, "provider usage.outputTokenDetails.reasoningTokens"),
        ];
        if (values.every((value) => value === undefined)) {
            throw new TypeError("provider usage.outputTokenDetails must contain a known quantity");
        }
        const known = values.filter((value): value is number => value !== undefined);
        if (output !== undefined && known.some((value) => value > output)) {
            throw new TypeError("provider output-token detail must not exceed outputTokens");
        }
        if (output !== undefined && values.every((value) => value !== undefined)
            && known.reduce((sum, value) => sum + value, 0) !== output) {
            throw new TypeError("complete provider output-token details must sum to outputTokens");
        }
    }
    return usage;
};

export const normalizeUsage = (raw: RawUsage | null | undefined): ProviderUsage | undefined => {
    if (raw === null || raw === undefined) return undefined;

    const inputTokens = knownTokens(
        raw.input_tokens ?? raw.prompt_tokens,
        "provider usage input tokens",
    );
    const rawOutputTokens = knownTokens(
        raw.output_tokens ?? raw.completion_tokens,
        "provider usage output tokens",
    );
    const reportedTotal = knownTokens(raw.total_tokens, "provider usage total tokens");
    const reasoningTokens = knownTokens(
        raw.output_tokens_details?.reasoning_tokens
            ?? raw.completion_tokens_details?.reasoning_tokens
            ?? raw.reasoning_tokens,
        "provider usage reasoning tokens",
    );

    let outputTokens = rawOutputTokens;
    let textTokens: number | undefined;
    let normalizedReasoning = reasoningTokens;
    if (inputTokens !== undefined && rawOutputTokens !== undefined && reportedTotal !== undefined) {
        if (reportedTotal === inputTokens + rawOutputTokens) {
            outputTokens = rawOutputTokens;
            if (reasoningTokens !== undefined) textTokens = rawOutputTokens - reasoningTokens;
        } else if (reasoningTokens !== undefined
            && reportedTotal === inputTokens + rawOutputTokens + reasoningTokens) {
            outputTokens = rawOutputTokens + reasoningTokens;
            textTokens = rawOutputTokens;
        } else if (reportedTotal >= inputTokens + rawOutputTokens) {
            outputTokens = reportedTotal - inputTokens;
            normalizedReasoning = outputTokens - rawOutputTokens;
            textTokens = rawOutputTokens;
        } else {
            throw new TypeError("provider usage total is inconsistent with input and output tokens");
        }
    } else if (rawOutputTokens !== undefined && reasoningTokens !== undefined) {
        if (reasoningTokens > rawOutputTokens) {
            outputTokens = rawOutputTokens + reasoningTokens;
            textTokens = rawOutputTokens;
        } else {
            textTokens = rawOutputTokens - reasoningTokens;
        }
    } else if (outputTokens === undefined && inputTokens !== undefined && reportedTotal !== undefined) {
        if (reportedTotal < inputTokens) {
            throw new TypeError("provider usage total must not be less than input tokens");
        }
        outputTokens = reportedTotal - inputTokens;
    }

    const totalTokens = reportedTotal
        ?? (inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined);
    const cacheReadTokens = knownTokens(
        raw.input_tokens_details?.cache_read_tokens
            ?? raw.input_tokens_details?.cached_tokens
            ?? raw.prompt_tokens_details?.cache_read_tokens
            ?? raw.prompt_tokens_details?.cached_tokens
            ?? raw.cache_read_input_tokens
            ?? raw.prompt_cache_hit_tokens
            ?? raw.cached_tokens,
        "provider usage cache-read tokens",
    );
    const cacheWriteTokens = knownTokens(
        raw.input_tokens_details?.cache_write_tokens
            ?? raw.prompt_tokens_details?.cache_write_tokens
            ?? raw.cache_creation_input_tokens,
        "provider usage cache-write tokens",
    );
    const explicitNoCacheTokens = knownTokens(
        raw.prompt_cache_miss_tokens,
        "provider usage non-cache tokens",
    );
    const noCacheTokens = explicitNoCacheTokens
        ?? (inputTokens !== undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined
            ? inputTokens - cacheReadTokens - cacheWriteTokens
            : undefined);

    const usage: ProviderUsage = {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(nonEmptyDetails({ noCacheTokens, cacheReadTokens, cacheWriteTokens }) === undefined
            ? {}
            : { inputTokenDetails: nonEmptyDetails({ noCacheTokens, cacheReadTokens, cacheWriteTokens })! }),
        ...(nonEmptyDetails({ textTokens, reasoningTokens: normalizedReasoning }) === undefined
            ? {}
            : { outputTokenDetails: nonEmptyDetails({ textTokens, reasoningTokens: normalizedReasoning })! }),
    };
    if (Object.keys(usage).length === 0) return undefined;
    return validateProviderUsage(usage);
};

// Models.dev rates are USD per million tokens. Optional cache rates inherit the
// input rate, so a missing usage detail matters only when its rate differs.
export type TokenRates = {
    input: number;
    output: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
};

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

export const canonicalDecimal = (coefficient: bigint, scale: number): string => {
    const digits = String(coefficient).padStart(scale + 1, "0");
    if (scale === 0) return digits;
    const integer = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, "");
    return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

export const calculateCostUsdDecimal = (
    usage: ProviderUsage,
    rates: TokenRates,
): string | null => {
    validateProviderUsage(usage);
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null;

    const cacheReadRate = rates.cacheRead ?? rates.input;
    const cacheWriteRate = rates.cacheWrite ?? rates.input;
    const reasoningRate = rates.reasoning ?? rates.output;
    const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
    const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
    const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
    if (cacheReadRate !== rates.input && cacheReadTokens === undefined) return null;
    if (cacheWriteRate !== rates.input && cacheWriteTokens === undefined) return null;
    if (reasoningRate !== rates.output && reasoningTokens === undefined) return null;

    const parts = [rates.input, rates.output, reasoningRate, cacheReadRate, cacheWriteRate].map(decimalParts);
    const rateScale = Math.max(...parts.map(({ scale }) => scale));
    const [input, output, reasoning, cacheRead, cacheWrite] = parts.map(({ coefficient, scale }) =>
        coefficient * 10n ** BigInt(rateScale - scale));
    const coefficient = BigInt(usage.inputTokens) * input!
        + BigInt(usage.outputTokens) * output!
        + BigInt(reasoningTokens ?? 0) * (reasoning! - output!)
        + BigInt(cacheReadTokens ?? 0) * (cacheRead! - input!)
        + BigInt(cacheWriteTokens ?? 0) * (cacheWrite! - input!);
    if (coefficient < 0n) throw new TypeError("provider token-rate details produced a negative estimate");
    return canonicalDecimal(coefficient, rateScale + 6);
};
