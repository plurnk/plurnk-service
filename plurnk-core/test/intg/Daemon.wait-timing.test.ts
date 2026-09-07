import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Engine from "../../src/core/Engine.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import { withDaemon, makeMockResponse, waitForDb } from "./_rpc.ts";

test("{§worker-wait-timing}: a finite WAIT is an obligation without a child or stream", async () => {
    const provider = new Mock({
        contextWindow: 65536,
        responses: [makeMockResponse("### SEND0 (WAIT) <60>\nWait for the next check.")],
    });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "timer-only-wait" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        try {
            const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "Wait, then recheck." });
            const row = await waitForDb(
                () => db.test_get_loop_status.get<{ status: number }>({ id: accepted.loopId }),
                (value) => value !== undefined && value.status !== 100 && value.status !== 102,
            );
            assert.equal(row?.status, 202, "WAIT must remain unfinished rather than reporting success");
            assert.equal(provider.received.length, 1, "no inference occurs before the wait is due");
        } finally {
            await daemon.cancelWorker({ workspaceId, workerId });
        }
    });
});

for (const { scope, delay, maxTurns = 2, status = 200 } of [
    { scope: "<1,0>", delay: 60_000 },
    { scope: "<-1,1>", delay: 60_000 },
    { scope: "<2,1>", delay: 60_000 },
    { scope: "<0>", delay: 1 },
    { scope: "<1>", delay: 60_000, maxTurns: 1, status: 429 },
]) {
    test(`{§worker-wait-timing}: WAIT ${scope} wakes the same task once at its due time`, async (t) => {
        const provider = new Mock({ contextWindow: 65536, responses: [
            makeMockResponse(`### SEND0 (WAIT) ${scope}\nWaiting for the next observation.`),
            makeMockResponse("### SEND0 (TERM)\nThe observation is complete."),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "wait-clock" });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const parked = Promise.withResolvers<void>();
            const finished = Promise.withResolvers<number>();
            const schedule = DrainSupervisor.prototype.scheduleWaitWakes;
            const finish = LoopLifecycle.prototype.finish;
            let targetId: number | undefined;
            t.mock.method(DrainSupervisor.prototype, "scheduleWaitWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
                await schedule.apply(this, args);
                if (args[1] === workerId) parked.resolve();
            });
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
                const result = await finish.apply(this, args);
                if (args[0] === targetId && result !== null) finished.resolve(result.status);
                return result;
            });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
            try {
                const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "Observe once when the wait ends.", maxTurns });
                targetId = accepted.loopId;
                await parked.promise;
                const waiting = await new LoopLifecycle(db).parked(workerId);
                assert.equal(waiting.length, 1);
                assert.equal(waiting[0]?.id, targetId);
                t.mock.timers.tick(delay - 1);
                assert.equal(await new LoopLifecycle(db).status(targetId), 202);
                assert.equal(provider.received.length, 1, "no early model dispatch");
                t.mock.timers.tick(1);
                assert.equal(await finished.promise, status);
                assert.equal(provider.received.length, maxTurns, "the same task resumes without renewing its inference allowance");
                const loops = await db.test_loop_queue_by_worker.all<{ id: number; prompt: string }>({ worker_id: workerId });
                assert.equal(loops.filter(({ prompt }) => prompt === "Observe once when the wait ends.").length, 1,
                    "the clock never re-enqueues the task prompt");
                assert.equal((await new LoopLifecycle(db).parked(workerId)).length, 0);
                t.mock.timers.tick(120_000);
                assert.equal(provider.received.length, maxTurns, "terminalization invalidates all prior timing");
            } finally {
                t.mock.timers.reset();
                await daemon.cancelWorker({ workspaceId, workerId });
            }
        });
    });
}

test("{§loop-wake-identity}: a message's reported and actual receiving loop agree with several parked loops", async () => {
    const provider = new Mock({
        contextWindow: 65536,
        responses: [
            makeMockResponse("### SEND0 (WAIT) <60>\nFirst task waits."),
            makeMockResponse("### SEND0 (WAIT) <60>\nSecond task waits."),
            makeMockResponse("### SEND0 (FAIL)\nEnd the receiving task."),
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
            assert.equal(delivered.loopId, accepted[0]?.loopId, "return and wake the same oldest unfinished loop that owns the prompt");
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
    const provider = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse("### SEND0 (WAIT) <60>\nWait."),
        makeMockResponse("### SEND0 (TERM)\nMust not execute the cancelled follow-up."),
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
