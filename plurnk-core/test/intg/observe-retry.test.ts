// Retried child failures must not falsely fail the parent
// ({§observability-boundary}): the engine retries an invalid emission under
// the same turn; the failed first attempt and the successful second both
// appear as provider.generate spans, and the turn and loop end OK.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { mountMemoryTracing } from "./_observe-memory.ts";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

const settleExports = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

test("observe: an invalid first emission retries under the turn without failing the successful parent", async () => {
    const memory = await mountMemoryTracing();
    try {
        const provider = new Mock({
            contextWindow: 8192,
            responses: [
                {
                    assistant: {
                        // Not a legal turn: no PLAN lead and no terminal SEND.
                        content: "this is not a plurnk turn",
                        reasoning: null,
                    },
                },
                {
                    assistant: {
                        content: "# PLAN1\ncurate:\n\n## SEND1 [200]\nrecovered.",
                        reasoning: null,
                    },
                },
            ],
        });
        await withDaemon(provider, async (db, daemon) => {
            const ws = await connect({ daemon });
            const created = (await rpcCall(ws, 1, "workspace.create", {
                name: "observe-retry", projectRoot: null,
            })).result as { id: number };
            assert.ok(Number.isInteger(created.id));
            const term = await runLoopToTerminal(ws, 2, {
                prompt: "Recover from a bad emission.",
                flags: { auto: true },
            }, { timeoutMs: 60_000 });
            assert.equal(term.finalStatus, 200);
        });
        await settleExports();

        const spans = memory.spans();
        const generates = spans.filter((s) => s.name === "provider.generate");
        assert.equal(generates.length, 2, "the invalid attempt and the retry are separate provider spans");
        const attempts = generates.map((s) => s.attributes.attempt).sort();
        assert.deepEqual(attempts, [1, 2]);

        const turn = spans.find((s) => s.name === "loop.turn");
        assert.ok(turn !== undefined);
        assert.equal(turn.status.code, 0, "the turn span stays OK after the retried child failure");
        const loop = spans.find((s) => s.name === "loop.run");
        assert.ok(loop !== undefined);
        assert.equal(loop.status.code, 0, "the loop span stays OK");
        assert.equal(loop.attributes.status, 200, "the loop records its terminal 200");

        const childOf = (parent: ReadableSpan, name: string): ReadableSpan[] =>
            spans.filter((s) => s.parentSpanContext?.spanId === parent.spanContext().spanId && s.name === name);
        assert.equal(childOf(turn, "provider.generate").length, 2, "both attempts nest under the turn");
        assert.ok(
            generates.every((g) => g.parentSpanContext !== undefined),
            "provider spans are never roots",
        );
    } finally {
        await memory.shutdown();
    }
});
