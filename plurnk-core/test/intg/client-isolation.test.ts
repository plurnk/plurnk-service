// {§connection-lifecycle} / {§actor-boundary-isolation} — a person's client operations journal in the
// workspace's runtime worker, end-to-end.
//
// A client `op.*` lands in the runtime worker `_plurnk`; `loop.run` runs the model in its own model
// worker; the packet renders the model worker, so no client-origin row ever reaches the model's log —
// invisibility by worker, no origin filter. This proves the server wiring (op.* → runtime worker,
// loop.run → model worker) that the engine-level {§actor-boundary-isolation} guarantee rests on.
//
// {§machine-processes-model-worker-readable}: a client READS the model worker by id —
// loop.run returns its modelWorkerId and log.read({ workerId }) targets it, ownership-gated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { insertWorkspace, insertWorker } from "./_db.ts";
import SeamSocket from "./_seam.ts";

test("{§machine-processes} a client operation cannot SEND the runtime actor into model inference", async () => {
    const mock = new Mock({
        contextWindow: 8192,
        responses: [makeMockResponse("````SEND [200]\nthis must remain unused\n````", 50)],
    });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "client-runtime-send" });
            const response = await rpcCall(ws, 2, "op.send", {
                recipient: "worker://_plurnk",
                body: "run a model in the runtime actor",
            });
            const problem = rpcProblem(response);
            assert.equal(problem.status, 409);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/worker/model-worker-required");
            assert.equal(mock.remaining, 1, "the refused runtime actor consumes no model response");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} {§actor-boundary-isolation} a client op.* journals in the runtime worker and never enters the model's packet", async () => {
    // The model just terminates; we only care where the client op landed.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "client-isolation" });
            const workspaceId = (created.result as { id: number }).id;
            // A client op — lands in the workspace's runtime worker.
            await rpcCall(ws, 2, "op.edit", { target: "worker:///secret", content: "client-only" });
            // The model works in its own worker.
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const loopId = (result as { loopId: number }).loopId;

            const modelWorker = await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId });
            assert.ok(modelWorker !== undefined, "the model loop has a worker");

            // The model's packet is rendered from the model worker alone.
            const modelLog = await db.engine_render_log.all<{ origin: string; pathname: string }>({ worker_id: modelWorker!.worker_id });
            assert.ok(modelLog.length > 0, "the model's packet carries its own log");
            assert.ok(
                modelLog.every((r) => r.origin !== "client"),
                "no client-origin op reaches the model's packet — the person's operation journals in the runtime worker",
            );

            // The client still sees its own op: log.read reads the runtime worker, where the op.edit lives.
            const own = await rpcCall(ws, 4, "log.read");
            const entries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(entries.some((e) => e.op === "EDIT" && e.origin === "client"), "the client reads its own op from the runtime worker");
            const runtime = await daemon.readWorker({ workspaceId, identity: { name: "_plurnk" } });
            assert.equal(runtime?.origin, "_plurnk");
            assert.notEqual(runtime?.id, modelWorker!.worker_id, "the runtime worker is distinct from the model worker");
        } finally { ws.close(); }
    });
});

test("a connection reads the model worker by id — loop.run returns modelWorkerId, log.read targets it, ownership-gated", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "model-worker-readable" });
            const workspaceId = (created.result as { id: number }).id;
            // A client op lands in the workspace's runtime worker.
            await rpcCall(ws, 2, "op.edit", { target: "worker:///note", content: "client-only" });
            // Drive the model — it works in its own worker, whose id loop.run returns.
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { loopId, modelWorkerId } = result as { loopId: number; modelWorkerId: number };
            assert.equal(typeof modelWorkerId, "number", "loop.run returns the model worker's id");
            assert.notEqual(modelWorkerId, await daemon.ensureRuntimeWorker(workspaceId), "the model worker is distinct from the runtime worker");
            const byLoop = await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId });
            assert.equal(byLoop!.worker_id, modelWorkerId, "the returned modelWorkerId is the worker the loop actually ran in");

            // Default log.read (no workerId) → the runtime worker: the op.edit.
            const own = await rpcCall(ws, 4, "log.read");
            const ownEntries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(ownEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "default log.read reads the runtime worker");

            // log.read({ workerId }) → the MODEL worker's log: readable by id,
            // and a DISTINCT worker — the client's op is absent from it.
            const modelRead = await rpcCall(ws, 5, "log.read", { workerId: modelWorkerId });
            const modelEntries = (modelRead.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(modelEntries.length > 0, "the model worker's log is readable by id");
            assert.ok(!modelEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "the model worker is distinct — the client's op is absent from it");

            // Ownership: a worker in a DIFFERENT workspace is refused from this connection.
            const foreignWorkspace = await insertWorkspace(db, `foreign-${crypto.randomUUID()}`);
            const foreignWorker = await insertWorker(db, foreignWorkspace, null, undefined, "model");
            const denied = await rpcCall(ws, 6, "log.read", { workerId: foreignWorker });
            const problem = rpcProblem(denied);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/worker/workspace-mismatch");
            assert.equal(problem.workerId, foreignWorker);
            assert.equal(problem.actualWorkspaceId, foreignWorkspace);
        } finally { ws.close(); }
    });
});

test("workspace.workers tags each worker with its actor — the model worker is found by origin, not name", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "worker-origin" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///note", content: "x" });
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { modelWorkerId } = result as { modelWorkerId: number };

            const listed = (await rpcCall(ws, 4, "workspace.workers")).result as { workers: Array<{ id: number; name: string; origin: string }> };
            const model = listed.workers.find((r) => r.id === modelWorkerId);
            assert.equal(model?.origin, "model", "the model worker is tagged origin=model");
            assert.equal(model?.name, SeamSocket.worker);
            // A person's operations journal in the runtime worker, the workspace's one `_plurnk` actor.
            assert.deepEqual(listed.workers.filter((r) => r.origin !== "model").map(({ name, origin }) => ({ name, origin })),
                [{ name: "_plurnk", origin: "_plurnk" }], "the only other worker is the runtime actor");
            // A client picks the model worker by actor — no name parsing.
            assert.deepEqual(listed.workers.filter((r) => r.origin === "model").map((r) => r.id), [modelWorkerId], "exactly one model worker, found by origin");
        } finally { ws.close(); }
    });
});
