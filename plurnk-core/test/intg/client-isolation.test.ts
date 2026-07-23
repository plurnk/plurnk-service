// #194 / §connection-lifecycle / §machine-processes — the client writes to its own worker, end-to-end.
//
// A client `op.*` lands in the connection's CLIENT run; `loop.run` runs the model
// in its OWN run; the packet renders the model's run, so no client-origin row ever
// reaches the model's conversation — invisibility by run, no origin filter. This
// proves the server wiring (op.* → client worker, loop.run → model worker) that the
// engine-level §actor-boundary-isolation guarantee rests on.
//
// The converse direction (#214): a conversation client READS the model worker by id —
// loop.run returns its modelWorkerId and log.read({ workerId }) targets it, ownership-gated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import { insertWorkspace, insertWorker } from "./_helpers.ts";

test("a client op.* never enters the model's packet — the client writes to its own worker (#194)", async () => {
    // The model just terminates; we only care where the client op landed.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "client-isolation" });
            // A client op — lands in the connection's client worker.
            await rpcCall(ws, 2, "op.edit", { target: "worker:///secret", content: "client-only" });
            // The model workers — in its OWN run.
            const run = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const loopId = (run as { loopId: number }).loopId;

            const modelWorker = await (db.test_get_worker_id_by_loop as PrepMethod).get<{ worker_id: number }>({ loop_id: loopId });
            assert.ok(modelWorker !== undefined, "the model loop has a worker");

            // The model's packet is rendered from the model's run alone.
            const modelLog = await (db.engine_render_log as PrepMethod).all<{ origin: string; pathname: string }>({ worker_id: modelWorker!.worker_id });
            assert.ok(modelLog.length > 0, "the model's packet carries its own log");
            assert.ok(
                modelLog.every((r) => r.origin !== "client"),
                "no client-origin op reaches the model's packet — the client wrote to its own worker, not the model's",
            );

            // And the client still sees its own op: log.read reads the connection's
            // (client) run, where the op.edit lives.
            const own = await rpcCall(ws, 4, "log.read");
            const entries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(entries.some((e) => e.op === "EDIT" && e.origin === "client"), "the client reads its own op from its own worker");
        } finally { ws.close(); }
    });
});

test("a connection reads the model worker by id — loop.run returns modelWorkerId, log.read targets it, ownership-gated", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "model-run-readable" });
            const clientWorkerId = (created.result as { workerId: number }).workerId;
            // A client op lands in the connection's own (client) run.
            await rpcCall(ws, 2, "op.edit", { target: "worker:///note", content: "client-only" });
            // Drive the model — its conversation lives in its OWN run, whose id loop.run returns.
            const run = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { loopId, modelWorkerId } = run as { loopId: number; modelWorkerId: number };
            assert.equal(typeof modelWorkerId, "number", "loop.run returns the model worker's id");
            assert.notEqual(modelWorkerId, clientWorkerId, "the model worker is distinct from the connection's client worker");
            const byLoop = await (db.test_get_worker_id_by_loop as PrepMethod).get<{ worker_id: number }>({ loop_id: loopId });
            assert.equal(byLoop!.worker_id, modelWorkerId, "the returned modelWorkerId is the worker the loop actually ran in");

            // Default log.read (no workerId) → the connection's own (client) run: the op.edit.
            const own = await rpcCall(ws, 4, "log.read");
            const ownEntries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(ownEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "default log.read reads the connection's own worker");

            // log.read({ workerId }) → the MODEL worker's log: readable by id (unaddressable before #214),
            // and a DISTINCT run — the client's op is absent from it.
            const conv = await rpcCall(ws, 5, "log.read", { workerId: modelWorkerId });
            const convEntries = (conv.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(convEntries.length > 0, "the model worker's log is readable by id");
            assert.ok(!convEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "the model worker is a distinct run — the client's op is absent from it");

            // Ownership: a worker in a DIFFERENT workspace is refused from this connection.
            const foreignWorkspace = await insertWorkspace(db, `foreign-${crypto.randomUUID()}`);
            const foreignWorker = await insertWorker(db, foreignWorkspace);
            const denied = await rpcCall(ws, 6, "log.read", { workerId: foreignWorker });
            assert.ok(denied.error, "reading a worker outside the workspace is refused");
            assert.match(denied.error!.message, /not in this workspace/, "the refusal names the ownership violation");
        } finally { ws.close(); }
    });
});

test("workspace.workers tags each worker with its actor — the model worker is found by origin, not name", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "run-origin" });
            const clientWorkerId = (created.result as { workerId: number }).workerId;
            await rpcCall(ws, 2, "op.edit", { target: "worker:///note", content: "x" });
            const run = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { modelWorkerId } = run as { modelWorkerId: number };

            const listed = (await rpcCall(ws, 4, "workspace.workers")).result as { workers: Array<{ id: number; origin: string }> };
            const model = listed.workers.find((r) => r.id === modelWorkerId);
            const client = listed.workers.find((r) => r.id === clientWorkerId);
            assert.equal(model?.origin, "model", "the model worker is tagged origin=model");
            assert.equal(client?.origin, "client", "the connection's own worker is tagged origin=client");
            // The conversation client picks the model worker by actor — no name parsing.
            assert.deepEqual(listed.workers.filter((r) => r.origin === "model").map((r) => r.id), [modelWorkerId], "exactly one model worker, found by origin");
        } finally { ws.close(); }
    });
});
