import type { ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { validateProviderRequestAccounting } from "@plurnk/plurnk-providers";

// The normalized SQLite projection of one settled physical request. Engine,
// recovery, and forensic readers share this single codec so the durable ledger
// cannot acquire consumer-specific interpretations.
export type ProviderRequestStorageRow = {
    provider: string;
    model: string;
    outcome: "response" | "error";
    status: number | null;
    usage_input: number | null;
    usage_output: number | null;
    usage_total: number | null;
    usage_input_no_cache: number | null;
    usage_input_cache_read: number | null;
    usage_input_cache_write: number | null;
    usage_output_text: number | null;
    usage_output_reasoning: number | null;
    cost_kind: "charged" | "estimated" | "unknown";
    cost_amount: string | null;
    cost_currency: string | null;
    cost_usd_equivalent: string | null;
    cost_source: string | null;
    cost_reason: string | null;
};

export const providerRequestFromStorageRow = (
    row: ProviderRequestStorageRow,
): ProviderRequestAccounting => {
    const inputTokenDetails = row.usage_input_no_cache === null
        && row.usage_input_cache_read === null
        && row.usage_input_cache_write === null
        ? undefined
        : {
            ...(row.usage_input_no_cache === null ? {} : { noCacheTokens: row.usage_input_no_cache }),
            ...(row.usage_input_cache_read === null ? {} : { cacheReadTokens: row.usage_input_cache_read }),
            ...(row.usage_input_cache_write === null ? {} : { cacheWriteTokens: row.usage_input_cache_write }),
        };
    const outputTokenDetails = row.usage_output_text === null
        && row.usage_output_reasoning === null
        ? undefined
        : {
            ...(row.usage_output_text === null ? {} : { textTokens: row.usage_output_text }),
            ...(row.usage_output_reasoning === null ? {} : { reasoningTokens: row.usage_output_reasoning }),
        };
    const usage = row.usage_input === null && row.usage_output === null && row.usage_total === null
        && inputTokenDetails === undefined && outputTokenDetails === undefined
        ? undefined
        : {
            ...(row.usage_input === null ? {} : { inputTokens: row.usage_input }),
            ...(row.usage_output === null ? {} : { outputTokens: row.usage_output }),
            ...(row.usage_total === null ? {} : { totalTokens: row.usage_total }),
            ...(inputTokenDetails === undefined ? {} : { inputTokenDetails }),
            ...(outputTokenDetails === undefined ? {} : { outputTokenDetails }),
        };
    const cost = row.cost_kind === "unknown"
        ? { kind: row.cost_kind, reason: row.cost_reason! } as const
        : row.cost_kind === "charged"
            ? {
                kind: row.cost_kind,
                amount: { amount: row.cost_amount!, currency: row.cost_currency! },
                ...(row.cost_usd_equivalent === null ? {} : { usdEquivalent: row.cost_usd_equivalent }),
                source: row.cost_source!,
            } as const
            : {
                kind: row.cost_kind,
                amount: { amount: row.cost_amount!, currency: row.cost_currency! },
                source: row.cost_source!,
            } as const;
    return validateProviderRequestAccounting({
        provider: row.provider,
        model: row.model,
        outcome: row.outcome,
        ...(row.status === null ? {} : { status: row.status }),
        ...(usage === undefined ? {} : { usage }),
        cost,
    });
};

export const providerRequestSettlementParams = (
    id: number,
    value: ProviderRequestAccounting,
): Record<string, string | number | null> => {
    const request = validateProviderRequestAccounting(value);
    const usage = request.usage;
    const cost = request.cost;
    return {
        id,
        outcome: request.outcome,
        status: request.status ?? null,
        usage_input: usage?.inputTokens ?? null,
        usage_output: usage?.outputTokens ?? null,
        usage_total: usage?.totalTokens ?? null,
        usage_input_no_cache: usage?.inputTokenDetails?.noCacheTokens ?? null,
        usage_input_cache_read: usage?.inputTokenDetails?.cacheReadTokens ?? null,
        usage_input_cache_write: usage?.inputTokenDetails?.cacheWriteTokens ?? null,
        usage_output_text: usage?.outputTokenDetails?.textTokens ?? null,
        usage_output_reasoning: usage?.outputTokenDetails?.reasoningTokens ?? null,
        cost_kind: cost.kind,
        cost_amount: cost.kind === "unknown" ? null : cost.amount.amount,
        cost_currency: cost.kind === "unknown" ? null : cost.amount.currency,
        cost_usd_equivalent: cost.kind === "charged" ? cost.usdEquivalent ?? null : null,
        cost_source: cost.kind === "unknown" ? null : cost.source,
        cost_reason: cost.kind === "unknown" ? cost.reason : null,
    };
};
