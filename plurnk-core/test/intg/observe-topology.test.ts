// The observational boundary's span topology through the REAL loop path
// ({§observability-boundary}). A Mock provider without pre-supplied ops drives
// the production parse path. One warmed engine cycle may complete the ordinary
// initialization turn before its inference turn; provider and parse belong to
// the inference result identified on the cycle span.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { mountMemoryTracing } from "./_observe-memory.ts";
import { SpanKind } from "@opentelemetry/api";
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
                    content: "# PLAN0\ncurate:\n\n## SEND0 [200]\nobserved.",
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
        assert.equal(turns.length, 1, "one loop iteration retains one warmed engine-cycle span");
        const turn = turns[0];
        assert.equal(turn.attributes["turn.producer"], "model");
        assert.equal(turn.attributes["turn.kind"], "inference");
        assert.ok(Number.isInteger(turn.attributes["loop.id"]));
        assert.ok(Number.isInteger(turn.attributes["turn.id"]));

        const turnChildren = childrenByParent.get(turn.spanContext().spanId) ?? [];
        const generate = turnChildren.find((s) => s.name === "gen_ai.client.request");
        assert.ok(generate !== undefined, "the turn nests the provider call");
        assert.equal(generate.kind, SpanKind.CLIENT, "the GenAI convention span is CLIENT-kind");
        assert.equal(generate.attributes["gen_ai.operation.name"], "chat");
        assert.equal(generate.attributes["gen_ai.system"], "mocktest", "the registered Mock alias projects as the GenAI system");
        assert.ok(typeof generate.attributes.model === "string" && generate.attributes.model.length > 0);
        assert.equal(generate.attributes["gen_ai.request.model"], generate.attributes.model);
        assert.ok(Number.isInteger(generate.attributes.attempt), "the provider span carries the emission attempt");
        assert.deepEqual(
            generate.attributes["gen_ai.response.finish_reasons"],
            ["stop"],
            "the settled span carries the convention finish reason",
        );

        // The parse is synchronous and ends before model dispatch.
        const parse = turnChildren.find((s) => s.name === "contracts.parse");
        assert.ok(parse !== undefined, "the turn nests the parse because the mock supplied no ops");
        assert.ok((parse.attributes.statements as number) >= 2, "parse records the emitted statement count");

        const dispatches = turnChildren.filter((s) => s.name === "op.dispatch");
        const ops = dispatches.map((s) => s.attributes.op);
        assert.equal(ops.filter((op) => op === "PLAN").length, 2, "initialization and inference each dispatch their real PLAN");
        assert.equal(ops.filter((op) => op === "SEND").length, 2, "initialization and inference each dispatch their real SEND");
        assert.ok(
            ops.filter((op) => op !== "PLAN" && op !== "SEND").every((op) => op === "FIND"),
            `the remaining initialization operations are catalog FINDs; got ${ops.join(", ")}`,
        );
        for (const d of dispatches) {
            assert.ok(Number.isInteger(d.attributes.status), "every dispatched op records its result status");
        }
    } finally {
        await memory.shutdown();
    }
});
