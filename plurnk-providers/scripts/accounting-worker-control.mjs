import { build } from "esbuild";

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
};

export const exerciseAccountingWorker = async ({ absWorkingDir, conditions = [] }) => {
    const result = await build({
        absWorkingDir,
        stdin: {
            contents: `
                import {
                    aggregateProviderAccounting,
                    estimateProviderCost,
                } from "@plurnk/plurnk-providers/accounting";

                export const evidence = {
                    accounting: aggregateProviderAccounting([]),
                    cost: estimateProviderCost(
                        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        { input: 0, output: 0 },
                        "Worker control",
                    ),
                };
            `,
            resolveDir: absWorkingDir,
            sourcefile: "accounting-worker.mjs",
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
    if (JSON.stringify(evidence) !== JSON.stringify(expected)) {
        throw new Error(`Worker accounting evidence diverged: ${JSON.stringify(evidence)}`);
    }
    return evidence;
};
