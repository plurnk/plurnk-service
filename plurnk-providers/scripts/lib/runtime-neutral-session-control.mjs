import { build } from "esbuild";
import { isDeepStrictEqual } from "node:util";

const expected = {
    accounting: {
        requests: [],
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokenDetails: {
                noCacheTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        },
        costUsd: "0",
        knownCostUsd: "0",
        knownUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        },
    },
    cost: {
        kind: "estimated",
        amount: { amount: "0", currency: "USD" },
        source: "Session control",
    },
    failure: {
        name: "ProviderError",
        source: "provider:session-control",
        kind: "rate_limit",
        status: 429,
        accounting: [{
            provider: "provider:session-control",
            model: "session-model",
            outcome: "response",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost: { kind: "unknown", reason: "Session control has no charge evidence." },
        }],
        capacity: {
            decision: "admit",
            contextWindow: 4_096,
            maxInputTokens: null,
            maxOutputTokens: 1_024,
            outputBudget: 1_024,
            reasoningBudget: null,
            inputCapacity: 3_072,
            prompt: { kind: "exact", tokens: 2, source: "session-control" },
        },
        problem: {
            type: "https://problems.plurnk.xyz/provider/session-control/rate-limit",
            title: "Rate limit",
            status: 429,
            detail: "Session control failure.",
            providerKind: "rate_limit",
            stage: "provider-request",
            retryable: true,
        },
    },
};

export const exerciseRuntimeNeutralSession = async ({ absWorkingDir, conditions = [] }) => {
    const result = await build({
        absWorkingDir,
        stdin: {
            contents: `
                import {
                    aggregateProviderAccounting,
                    estimateProviderCost,
                } from "@plurnk/plurnk-providers/accounting";
                import { ProviderError } from "@plurnk/plurnk-providers/errors";

                const accounting = [{
                    provider: "provider:session-control",
                    model: "session-model",
                    outcome: "response",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    cost: { kind: "unknown", reason: "Session control has no charge evidence." },
                }];
                const capacity = {
                    decision: "admit",
                    contextWindow: 4_096,
                    maxInputTokens: null,
                    maxOutputTokens: 1_024,
                    outputBudget: 1_024,
                    reasoningBudget: null,
                    inputCapacity: 3_072,
                    prompt: { kind: "exact", tokens: 2, source: "session-control" },
                };
                const failure = new ProviderError(
                    "session-control",
                    "rate_limit",
                    "Session control failure.",
                    { status: 429, accounting, capacity },
                );

                export const evidence = {
                    accounting: aggregateProviderAccounting([]),
                    cost: estimateProviderCost(
                        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        { input: 0, output: 0 },
                        "Session control",
                    ),
                    failure: {
                        name: failure.name,
                        source: failure.source,
                        kind: failure.kind,
                        status: failure.status,
                        accounting: failure.accounting,
                        capacity: failure.capacity,
                        problem: failure.problem,
                    },
                };
            `,
            resolveDir: absWorkingDir,
            sourcefile: "runtime-neutral-session.mjs",
        },
        bundle: true,
        conditions,
        format: "esm",
        logLevel: "silent",
        platform: "browser",
        write: false,
    });
    const [output] = result.outputFiles;
    if (output === undefined) throw new Error("Session bundle produced no JavaScript output");
    const href = `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`;
    const { evidence } = await import(href);
    if (!isDeepStrictEqual(evidence, expected)) {
        throw new Error(`Session provider evidence diverged: ${JSON.stringify(evidence)}`);
    }
    return evidence;
};
