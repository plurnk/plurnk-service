// The observational boundary's span topology through the REAL loop path
// ({§observability-boundary}). A Mock provider without pre-supplied ops drives
// the production parse path, so a single turn produces the full chain:
// loop.run → loop.turn → provider.generate → contracts.parse → op.dispatch.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { mountMemoryTracing } from "./_observe-memory.ts";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

const settleExports = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

test("observe: a real loop emits the loop → turn → provider → parse → dispatch topology", async () => {
    const memory = await mountMemoryTracing();
    try {
        const provider = new Mock({
            contextWindow: 8192,
            responses: [{
                assistant: {
                    // ops deliberately absent: the engine must parse this content.
                    content: "<|PLAN>curate:<PLAN|>\n<|SEND[200]>observed.<SEND|>",
                    reasoning: null,
                },
            }],
        });
        await withDaemon(provider, async (db, daemon) => {
            const ws = await connect({ daemon });
            const created = (await rpcCall(ws, 1, "workspace.create", {
                name: "observe-topology", projectRoot: null,
            })).result as { id: number };
            assert.ok(Number.isInteger(created.id));
            const term = await runLoopToTerminal(ws, 2, {
                prompt: "Explain the loop topology.",
                flags: { auto: true },
            }, { timeoutMs: 60_000 });
            assert.equal(term.finalStatus, 200);
        });
        await settleExports();

        const spans = memory.spans();
        const childrenByParent = new Map<string | undefined, ReadableSpan[]>();
        for (const s of spans) {
            const parent = s.parentSpanContext?.spanId;
            const list = childrenByParent.get(parent) ?? [];
            list.push(s);
            childrenByParent.set(parent, list);
        }

        const loop = spans.find((s) => s.name === "loop.run");
        assert.ok(loop !== undefined, `loop.run span exists; got names: ${spans.map((s) => s.name).join(", ")}`);
        assert.ok(Number.isInteger(loop.attributes["loop.id"]), "loop.run carries the loop id");
        assert.ok(Number.isInteger(loop.attributes["status"]), "loop.run records its terminal status");

        const turns = (childrenByParent.get(loop.spanContext().spanId) ?? []).filter((s) => s.name === "loop.turn");
        assert.equal(turns.length, 1, "one loop.run nests exactly one loop.turn for a single-turn loop");
        const turn = turns[0];
        assert.ok(Number.isInteger(turn.attributes["loop.id"]));
        assert.ok(Number.isInteger(turn.attributes["turn.id"]));

        const turnChildren = childrenByParent.get(turn.spanContext().spanId) ?? [];
        const generate = turnChildren.find((s) => s.name === "provider.generate");
        assert.ok(generate !== undefined, "the turn nests the provider call");
        assert.ok(typeof generate.attributes.model === "string" && generate.attributes.model.length > 0);
        assert.ok(Number.isInteger(generate.attributes.attempt), "the provider span carries the emission attempt");

        // The parse is synchronous and ends before model dispatch. Turn-0
        // environmental FINDs and the model's PLAN/SEND therefore sit beside
        // it as siblings under the turn.
        const parse = turnChildren.find((s) => s.name === "contracts.parse");
        assert.ok(parse !== undefined, "the turn nests the parse because the mock supplied no ops");
        assert.ok((parse.attributes.statements as number) >= 2, "parse records the emitted statement count");

        const dispatches = turnChildren.filter((s) => s.name === "op.dispatch");
        const ops = dispatches.map((s) => s.attributes.op);
        assert.equal(ops.filter((op) => op === "PLAN").length, 1, "the parsed PLAN dispatches under the turn");
        assert.equal(ops.filter((op) => op === "SEND").length, 1, "the parsed SEND dispatches under the turn");
        assert.ok(
            ops.filter((op) => op !== "PLAN" && op !== "SEND").every((op) => op === "FIND"),
            `turn-0 environmental dispatches are catalog FINDs; got ${ops.join(", ")}`,
        );
        for (const d of dispatches) {
            assert.ok(Number.isInteger(d.attributes.status), "every dispatched op records its result status");
        }
    } finally {
        await memory.shutdown();
    }
});
