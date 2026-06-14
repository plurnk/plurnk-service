// #194 / §connection-lifecycle / §machine-processes — the client writes to its own run, end-to-end.
//
// A client `op.*` lands in the connection's CLIENT run; `loop.run` runs the model
// in its OWN run; the packet renders the model's run, so no client-origin row ever
// reaches the model's conversation — invisibility by run, no origin filter. This
// proves the server wiring (op.* → client run, loop.run → model run) that the
// engine-level §actor-boundary-isolation guarantee rests on.
//
// The converse direction (#214): a conversation client READS the model run by id —
// loop.run returns its modelRunId and log.read({ runId }) targets it, ownership-gated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";
import { insertSession, insertRun } from "./_helpers.ts";

test("a client op.* never enters the model's packet — the client writes to its own run (#194)", async () => {
    // The model just terminates; we only care where the client op landed.
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "client-isolation" });
            // A client op — lands in the connection's client run.
            await rpcCall(ws, 2, "op.edit", { target: "known:///secret", content: "client-only" });
            // The model runs — in its OWN run.
            const run = await rpcCall(ws, 3, "loop.run", { prompt: "go" });
            const loopId = (run.result as { loopId: number }).loopId;

            const modelRun = await (db.test_get_run_id_by_loop as PrepMethod).get<{ run_id: number }>({ loop_id: loopId });
            assert.ok(modelRun !== undefined, "the model loop has a run");

            // The model's packet is rendered from the model's run alone.
            const modelLog = await (db.engine_render_log as PrepMethod).all<{ origin: string; pathname: string }>({ run_id: modelRun!.run_id });
            assert.ok(modelLog.length > 0, "the model's packet carries its own log");
            assert.ok(
                modelLog.every((r) => r.origin !== "client"),
                "no client-origin op reaches the model's packet — the client wrote to its own run, not the model's",
            );

            // And the client still sees its own op: log.read reads the connection's
            // (client) run, where the op.edit lives.
            const own = await rpcCall(ws, 4, "log.read");
            const entries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(entries.some((e) => e.op === "EDIT" && e.origin === "client"), "the client reads its own op from its own run");
        } finally { ws.close(); }
    });
});

test("[§machine-processes-model-run-readable] a connection reads the model run by id — loop.run returns modelRunId, log.read targets it, ownership-gated", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "model-run-readable" });
            const clientRunId = (created.result as { runId: number }).runId;
            // A client op lands in the connection's own (client) run.
            await rpcCall(ws, 2, "op.edit", { target: "known:///note", content: "client-only" });
            // Drive the model — its conversation lives in its OWN run, whose id loop.run returns.
            const run = await rpcCall(ws, 3, "loop.run", { prompt: "go" });
            const { loopId, modelRunId } = run.result as { loopId: number; modelRunId: number };
            assert.equal(typeof modelRunId, "number", "loop.run returns the model run's id");
            assert.notEqual(modelRunId, clientRunId, "the model run is distinct from the connection's client run");
            const byLoop = await (db.test_get_run_id_by_loop as PrepMethod).get<{ run_id: number }>({ loop_id: loopId });
            assert.equal(byLoop!.run_id, modelRunId, "the returned modelRunId is the run the loop actually ran in");

            // Default log.read (no runId) → the connection's own (client) run: the op.edit.
            const own = await rpcCall(ws, 4, "log.read");
            const ownEntries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(ownEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "default log.read reads the connection's own run");

            // log.read({ runId }) → the MODEL run's log: readable by id (unaddressable before #214),
            // and a DISTINCT run — the client's op is absent from it.
            const conv = await rpcCall(ws, 5, "log.read", { runId: modelRunId });
            const convEntries = (conv.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(convEntries.length > 0, "the model run's log is readable by id");
            assert.ok(!convEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "the model run is a distinct run — the client's op is absent from it");

            // Ownership: a run in a DIFFERENT session is refused from this connection.
            const foreignSession = await insertSession(db, `foreign-${crypto.randomUUID()}`);
            const foreignRun = await insertRun(db, foreignSession);
            const denied = await rpcCall(ws, 6, "log.read", { runId: foreignRun });
            assert.ok(denied.error, "reading a run outside the session is refused");
            assert.match(denied.error!.message, /not in this session/, "the refusal names the ownership violation");
        } finally { ws.close(); }
    });
});

test("[§machine-processes-run-origin] session.runs tags each run with its actor — the model run is found by origin, not name", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "run-origin" });
            const clientRunId = (created.result as { runId: number }).runId;
            await rpcCall(ws, 2, "op.edit", { target: "known:///note", content: "x" });
            const run = await rpcCall(ws, 3, "loop.run", { prompt: "go" });
            const { modelRunId } = run.result as { modelRunId: number };

            const listed = (await rpcCall(ws, 4, "session.runs")).result as { runs: Array<{ id: number; origin: string }> };
            const model = listed.runs.find((r) => r.id === modelRunId);
            const client = listed.runs.find((r) => r.id === clientRunId);
            assert.equal(model?.origin, "model", "the model run is tagged origin=model");
            assert.equal(client?.origin, "client", "the connection's own run is tagged origin=client");
            // The conversation client picks the model run by actor — no name parsing.
            assert.deepEqual(listed.runs.filter((r) => r.origin === "model").map((r) => r.id), [modelRunId], "exactly one model run, found by origin");
        } finally { ws.close(); }
    });
});
