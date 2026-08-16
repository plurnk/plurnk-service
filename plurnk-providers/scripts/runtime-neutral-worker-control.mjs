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
    },
    cost: {
        kind: "estimated",
        amount: { amount: "0", currency: "USD" },
        source: "Worker control",
    },
    failure: {
        name: "ProviderError",
        source: "provider:worker-control",
        kind: "rate_limit",
        status: 429,
        accounting: [{
            provider: "provider:worker-control",
            model: "worker-model",
            outcome: "response",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost: { kind: "unknown", reason: "Worker control has no charge evidence." },
        }],
        capacity: {
            decision: "admit",
            contextWindow: 4_096,
            maxInputTokens: null,
            maxOutputTokens: 1_024,
            outputBudget: 1_024,
            reasoningBudget: null,
            inputCapacity: 3_072,
            prompt: { kind: "exact", tokens: 2, source: "worker-control" },
        },
        problem: {
            type: "https://problems.plurnk.dev/provider/worker-control/rate-limit",
            title: "Rate limit",
            status: 429,
            detail: "Worker control failure.",
            providerKind: "rate_limit",
            stage: "provider-request",
            retryable: true,
        },
    },
};

export const exerciseRuntimeNeutralWorker = async ({ absWorkingDir, conditions = [] }) => {
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
                    provider: "provider:worker-control",
                    model: "worker-model",
                    outcome: "response",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    cost: { kind: "unknown", reason: "Worker control has no charge evidence." },
                }];
                const capacity = {
                    decision: "admit",
                    contextWindow: 4_096,
                    maxInputTokens: null,
                    maxOutputTokens: 1_024,
                    outputBudget: 1_024,
                    reasoningBudget: null,
                    inputCapacity: 3_072,
                    prompt: { kind: "exact", tokens: 2, source: "worker-control" },
                };
                const failure = new ProviderError(
                    "worker-control",
                    "rate_limit",
                    "Worker control failure.",
                    { status: 429, accounting, capacity },
                );

                export const evidence = {
                    accounting: aggregateProviderAccounting([]),
                    cost: estimateProviderCost(
                        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        { input: 0, output: 0 },
                        "Worker control",
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
            sourcefile: "runtime-neutral-worker.mjs",
        },
        bundle: true,
        conditions,
        format: "esm",
        logLevel: "silent",
        platform: "browser",
        write: false,
    });
    const [output] = result.outputFiles;
    if (output === undefined) throw new Error("Worker bundle produced no JavaScript output");
    const href = `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`;
    const { evidence } = await import(href);
    if (!isDeepStrictEqual(evidence, expected)) {
        throw new Error(`Worker provider evidence diverged: ${JSON.stringify(evidence)}`);
    }
    return evidence;
};
