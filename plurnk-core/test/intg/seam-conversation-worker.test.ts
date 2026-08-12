// {§methods-conversation-worker}: a fresh conversation has an empty history over the same world.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, waitFor } from "./_rpc.ts";

test("{§methods-conversation-worker}: fresh named conversation — empty log, runLoop accepts, stable door unaffected", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("## SEND0 [200]\nhello from thread-2", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "threads" });
            const workspaceId = (created.result as { id: number }).id;
            const stable = await daemon.ensureModelWorker(workspaceId);

            // The fresh door: named, empty, model-origin root.
            const conv = await daemon.createConversationWorker({ workspaceId, name: "thread-2" });
            assert.notEqual(conv.workerId, stable, "a fresh conversation, not the default");
            assert.equal(conv.workerName, "thread-2", "the client's name IS the worker name");
            assert.equal((await daemon.readLog({ workspaceId, workerId: conv.workerId })).length, 0, "an EMPTY log — fork copies history, this must not");

            // runLoop accepts it (model-origin), and the full loop settles on that conversation.
            const terminated: Array<{ loopId: number; result: { status: number } }> = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
            });
            const accepted = await daemon.runLoop({ workspaceId, workerId: conv.workerId, prompt: "start thread 2" });
            assert.ok(accepted.loopId > 0, "runLoop accepts the fresh conversation worker");
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId, result }) => loopId === accepted.loopId && result.status === 200),
                { timeoutMs: 8000 },
            );

            // The stable door still finds the original root; later fresh conversations never shadow it.
            assert.equal(await daemon.ensureModelWorker(workspaceId), stable, "ensureModelWorker is unmoved by fresh conversations");

            // Name invariants mirror forkWorker's: reserved + taken are legible refusals.
            await assert.rejects(
                () => daemon.createConversationWorker({ workspaceId, name: "plurnk" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.dev/daemon/worker/name-reserved");
                    assert.equal(error.result.problem.name, "plurnk");
                    assert.equal(error.result.problem.recovery, "Choose another worker name.");
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createConversationWorker({ workspaceId, name: "bad_name" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.dev/daemon/worker/name-invalid");
                    assert.equal(error.result.problem.status, 400);
                    assert.equal(error.result.problem.name, "bad_name");
                    assert.equal(error.result.problem.retryable, false);
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createConversationWorker({ workspaceId, name: "thread-2" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.dev/daemon/worker/name-conflict");
                    assert.equal(error.result.problem.workspaceId, workspaceId);
                    assert.equal(error.result.problem.name, "thread-2");
                    assert.equal(error.result.problem.recovery, "Choose another worker name.");
                    return true;
                },
            );
            // A default name mints distinct model-<N> conversations.
            const anon = await daemon.createConversationWorker({ workspaceId });
            assert.match(anon.workerName, /^model-/, "default name follows the model-worker convention");
        } finally { ws.close(); }
    });
});

test("{§worker-auto-name} #159: concurrent unnamed fresh conversations claim distinct model ordinals", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `threads-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const conversations = await Promise.all(Array.from(
                { length: 8 },
                () => daemon.createConversationWorker({ workspaceId }),
            ));
            const names = conversations.map(({ workerName }) => workerName);

            assert.equal(new Set(names).size, conversations.length, "every fresh conversation remains individually addressable");
            assert.deepEqual(names.toSorted(), Array.from({ length: 8 }, (_, i) => `model-${i + 1}`).toSorted());
        } finally { ws.close(); }
    });
});
