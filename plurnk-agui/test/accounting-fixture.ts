import type { ProviderAccounting, ProviderCost, ProviderUsage } from "@plurnk/plurnk-contracts";
import type { TerminatedNotification } from "../src/types.ts";

type LoopUsageFixture = {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cost?: ProviderCost;
    accounting?: ProviderAccounting;
    contextTokens?: number | null;
    promptBudget?: number | null;
    meta?: Record<string, unknown>;
};

export const loopUsage = (fixture: LoopUsageFixture = {}): TerminatedNotification["usage"] => {
    const inputTokens = fixture.inputTokens ?? 0;
    const outputTokens = fixture.outputTokens ?? 0;
    const reasoningTokens = fixture.reasoningTokens ?? 0;
    const cacheReadTokens = fixture.cacheReadTokens ?? 0;
    const usage: ProviderUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputTokenDetails: {
            noCacheTokens: inputTokens - cacheReadTokens,
            cacheReadTokens,
            cacheWriteTokens: 0,
        },
        outputTokenDetails: {
            textTokens: outputTokens - reasoningTokens,
            reasoningTokens,
        },
    };
    const cost = fixture.cost ?? {
        kind: "estimated",
        amount: { amount: "0", currency: "USD" },
        source: "AG-UI test fixture",
    };
    const issued = fixture.accounting === undefined
        && (fixture.inputTokens !== undefined
            || fixture.outputTokens !== undefined
            || fixture.reasoningTokens !== undefined
            || fixture.cacheReadTokens !== undefined
            || fixture.cost !== undefined);
    const accounting = fixture.accounting ?? (issued
        ? {
            requests: [{
                provider: "provider:test",
                model: "test",
                outcome: "response",
                usage,
                cost,
            }],
            usage,
            costUsd: cost.kind === "unknown"
                ? null
                : cost.amount.currency === "USD"
                    ? cost.amount.amount
                    : cost.kind === "charged"
                        ? cost.usdEquivalent ?? null
                        : null,
        }
        : {
            requests: [],
            usage,
            costUsd: "0",
        });
    return {
        accounting,
        contextTokens: fixture.contextTokens ?? fixture.inputTokens ?? null,
        promptBudget: fixture.promptBudget ?? null,
        meta: fixture.meta ?? {},
    };
};
