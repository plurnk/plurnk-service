import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { withDaemon, waitForDb } from "./_rpc.ts";
import { holdChild } from "./_db.ts";
import { answer, makeMockResponse } from "./_mock.ts";
import { OperationFailureError } from "../../src/core/results.ts";

test("{§loop-addressed-admission}: explicit delivery wakes its addressed parked Loop, not the oldest", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: Array.from({ length: 3 }, () => makeMockResponse("````WAIT\n````")) });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "loop-address" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        await holdChild(db, workspaceId, workerId);
        const common = { workspaceId, workerId, providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            effort: "adaptive" as const, systemPrompt: "test system" };
        const [first, second] = await Promise.all([
            daemon.inject({ ...common, prompt: "first" }), daemon.inject({ ...common, prompt: "second" }),
        ]);
        try {
            await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId }),
                (loops) => loops.length === 2 && loops.every(({ status }) => status === 202));
            const accepted = await daemon.runLoop({ workspaceId, workerId, loopId: second!.loopId, prompt: "addressed arrival" });
            assert.equal(accepted.loopId, second!.loopId);
            assert.equal(accepted.action, "injected_next_turn");
            await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId }),
                (loops) => provider.received.length === 3 && loops.every(({ status }) => status === 202));
            assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId })).find(({ id }) => id === first!.loopId)?.status, 202);
            const messages = await daemon.readMessages({ workspaceId, workerId, loopId: second!.loopId });
            assert.ok(messages.some(({ body }) => body === "addressed arrival"));
        } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
    });
});

test("{§loop-addressed-admission}: terminal, foreign and missing recipients create no replacement work", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [answer("finished"), makeMockResponse("````WAIT\n````")] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "loop-address-refusal" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const other = await daemon.createConversationWorker({ workspaceId });
        const terminal = await daemon.runLoop({ workspaceId, workerId, prompt: "finish" });
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId }), (loops) => loops[0]?.status === 200);
        await holdChild(db, workspaceId, other.workerId);
        const foreign = await daemon.runLoop({ workspaceId, workerId: other.workerId, prompt: "wait" });
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: other.workerId }), (loops) => loops[0]?.status === 202);
        const before = await daemon.listWorkerLoops({ workspaceId, workerId });
        for (const loopId of [terminal.loopId, foreign.loopId, 999_999]) {
            await assert.rejects(daemon.runLoop({ workspaceId, workerId, loopId, prompt: "must not be admitted" }),
                (error: unknown) => error instanceof OperationFailureError && error.result.status === 409
                    && error.result.problem.type === "https://problems.plurnk.xyz/daemon/admission/loop-not-open");
        }
        assert.deepEqual(await daemon.listWorkerLoops({ workspaceId, workerId }), before);
        assert.equal(provider.received.length, 2);
        assert.equal((await daemon.readMessages({ workspaceId, workerId })).some(({ body }) => body === "must not be admitted"), false);
    });
});
