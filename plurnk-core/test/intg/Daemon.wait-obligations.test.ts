// {§loop-wake-identity} — parked loops of one worker keep their identity under arrivals and
// cancellation; the waits park on live work the fixture holds.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Dispatcher from "../../src/core/Dispatcher.ts";
import Engine from "../../src/core/Engine.ts";
import { withDaemon, makeMockResponse, waitForDb } from "./_rpc.ts";

test("{§loop-wake-identity}: a message's reported and actual receiving loop agree with several parked loops", async (t) => {
    // The waits park on live work the fixture holds; the message is what wakes one of them.
    t.mock.method(Dispatcher.prototype, "hasLiveWork", async () => true);
    const provider = new Mock({
        contextWindow: 65536,
        responses: [
            makeMockResponse("```WAIT\nFirst task waits.\n```"),
            makeMockResponse("```WAIT\nSecond task waits.\n```"),
            makeMockResponse("```SEND\nEnd the receiving task.\n```\n```FAIL\n```"),
        ],
    });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "two-parked-recipients" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        try {
            const common = {
                workspaceId, workerId,
                providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                reasoningPolicy: "adaptive" as const, systemPrompt: "test system",
            };
            const accepted = await Promise.all([
                daemon.inject({ ...common, prompt: "First task." }),
                daemon.inject({ ...common, prompt: "Second task." }),
            ]);
            const ids = new Set(accepted.map(({ loopId }) => loopId));
            await waitForDb(
                async () => (await db.test_loop_queue_by_worker.all<{ id: number; status: number }>({ worker_id: workerId }))
                    .filter(({ id }) => ids.has(id)),
                (loops) => loops.length === 2 && loops.every(({ status }) => status === 202),
            );
            const delivered = await daemon.runLoop({ workspaceId, workerId, prompt: "A new message." });
            assert.equal(delivered.loopId, accepted[0]?.loopId, "return and wake the same oldest unfinished loop that owns the message");
            const received = await waitForDb(
                () => db.test_get_loop_status.get<{ status: number }>({ id: delivered.loopId }),
                (row) => row?.status === 499,
            );
            assert.equal(received?.status, 499);
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: accepted[1]!.loopId }))?.status, 202,
                "a message does not resume an unrelated wait");
        } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
    });
});

test("{§worker-lifecycle-no-resurrection}: a concurrent cancellation leaves no runnable orphan message", async (t) => {
    t.mock.method(Dispatcher.prototype, "hasLiveWork", async () => true);
    const provider = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse("```WAIT\nWait.\n```"),
        makeMockResponse("```SEND\nMust not execute the cancelled follow-up.\n```\n```DONE\n```"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-admission-race" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "Original task." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const inject = Engine.prototype.injectIntoLoop;
        t.mock.method(Engine.prototype, "injectIntoLoop", async function (this: Engine, ...args: Parameters<typeof inject>) {
            entered.resolve();
            await release.promise;
            return inject.apply(this, args);
        });
        const injection = daemon.runLoop({ workspaceId, workerId, prompt: "Follow-up before cancellation." });
        await entered.promise;
        const cancellation = daemon.cancelWorker({ workspaceId, workerId });
        try {
            await lifecycle.status(accepted.loopId);
            release.resolve();
            await Promise.all([injection, cancellation]);
            assert.equal(await lifecycle.status(accepted.loopId), 499);
            const loops = await db.test_loop_queue_by_worker.all<{ prompt: string; status: number }>({ worker_id: workerId });
            assert.equal(loops.some(({ prompt, status }) => prompt === "Follow-up before cancellation." && status < 200), false,
                "a concurrent cancel cannot strand a fresh follow-up outside its scope");
            assert.equal(provider.received.length, 1, "the cancelled message was not dispatched");
        } finally {
            release.resolve();
            await daemon.cancelWorker({ workspaceId, workerId });
        }
    });
});
