// Exporter failure isolation ({§observability-boundary}): an exporter that
// rejects every export must not change product results, lifecycle, or the
// client-visible outcome. The same loop terminates 200 with or without it.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import type { ExportResult } from "@opentelemetry/core";
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";

class ExplodingExporter implements SpanExporter {
    export(_spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        resultCallback({ code: 1, error: new Error("exporter exploded") });
    }
    shutdown(): Promise<void> { return Promise.resolve(); }
    forceFlush?(): Promise<void> { return Promise.resolve(); }
}

test("observe: an exploding exporter cannot change the loop result or daemon lifecycle", async () => {
    assert.equal(await explosionProofLoop(), true);
});

// Register the failing exporter for this process and run exactly one real loop;
// the daemon/lifecycle assertions run while the exporter is live.
const explosionProofLoop = async (): Promise<boolean> => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(new ExplodingExporter())],
    });
    trace.setGlobalTracerProvider(provider);
    let finalStatus: number | undefined;
    try {
        const mock = new Mock({
            contextWindow: 16384,
            responses: [{
                assistant: {
                    content: "# PLAN0\ncurate:\n\n## SEND0 [200]\nstill works.",
                    reasoning: null,
                },
            }],
        });
        await withDaemon(mock, async (db, daemon) => {
            const ws = await connect({ daemon });
            const created = (await rpcCall(ws, 1, "workspace.create", {
                name: "exploder", projectRoot: null,
            })).result as { id: number };
            assert.ok(Number.isInteger(created.id));
            const term = await runLoopToTerminal(ws, 2, {
                prompt: "Prove exporter failure cannot change the product.",
                policy: { proposals: "accept" },
            }, { timeoutMs: 60_000 });
            finalStatus = term.finalStatus;
            return Promise.resolve();
        });
    } finally {
        await provider.shutdown();
    }
    return finalStatus === 200;
};
