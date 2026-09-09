import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import LoopDriver from "../../src/core/LoopDriver.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import WorkerCap from "../../src/core/worker-cap.ts";
import Daemon from "../../src/server/Daemon.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import { makeMockResponse, waitForDb, withDaemon } from "./_rpc.ts";

for (const op of ["WORK", "FORK"]) {
    test(`{§worker-lifecycle-no-resurrection}: ${op} cannot admit a child after its source task is cancelled`, async (t) => {
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse(`\`\`\`${op} (worker://late-child)
Do the delegated task.
\`\`\`
\`\`\`TASK
[{"content":"Wait for the child.","status":"waiting"}]
\`\`\``),
            makeMockResponse("```TASK <60,0>\n[{\"content\":\"Child task is still running.\",\"status\":\"waiting\"}]\n```"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-late-${op}` });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const finished = Promise.withResolvers<void>();
            const deny = WorkerCap.deny;
            const run = LoopDriver.prototype.runLoop;
            t.mock.method(WorkerCap, "deny", async (...args: Parameters<typeof deny>) => {
                entered.resolve();
                await release.promise;
                return deny(...args);
            });
            t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
                try { return await run.apply(this, args); }
                finally { if (args[0].workerId === workerId) finished.resolve(); }
            });
            try {
                const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "Delegate this task.", policy: { proposals: "accept" } });
                await entered.promise;
                await daemon.cancelWorker({ workspaceId, workerId });
                assert.equal((await db.test_get_loop_status.get({ id: accepted.loopId }))?.status, 499);
                release.resolve();
                await finished.promise;
                const workers = await db.test_workers_by_workspace.all<{ id: number }>({ workspace_id: workspaceId });
                const tasks = (await Promise.all(workers.map(({ id }) =>
                    db.test_loop_queue_by_worker.all<{ status: number }>({ worker_id: id })))).flat();
                assert.equal(tasks.some(({ status }) => [100, 102, 202].includes(status)), false,
                    "no late runnable child escapes the cancelled parent task");
                assert.equal(provider.received.length, 1, "cancellation prevented child inference");
                const receipt = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: accepted.loopId }))
                    .find((row) => row.op === op);
                assert.equal(receipt?.status_rx, 409, "the stopped delivery has an explicit refusal receipt");
                assert.equal(JSON.parse(receipt!.rx).problem.type, "https://problems.plurnk.xyz/daemon/admission/source-not-running");
            } finally {
                release.resolve();
                await daemon.cancelWorker({ workspaceId, workerId });
            }
        });
    });
}

test("{§worker-lifecycle-no-resurrection}: scope cancellation retires unread arrivals on a completed task across restart", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("```SEND\nFinished the original request.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
        makeMockResponse("```SEND\nIndependent new request completed.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-prompt-promotion" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const concluding = Promise.withResolvers<void>();
        const conclude = Promise.withResolvers<void>();
        const promoting = Promise.withResolvers<void>();
        const promote = Promise.withResolvers<void>();
        const reconciled = Promise.withResolvers<void>();
        const finish = LoopLifecycle.prototype.finish;
        const reconcile = DrainSupervisor.prototype.reconcileOrphanedPrompts;
        let taskLoopId: number | undefined;
        let firstConclusion = true;
        let firstPromotion = true;
        t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
            if (args[0] === taskLoopId && args[1].status === 200 && firstConclusion) {
                firstConclusion = false;
                concluding.resolve();
                await conclude.promise;
            }
            return finish.apply(this, args);
        });
        t.mock.method(DrainSupervisor.prototype, "reconcileOrphanedPrompts", async function (this: DrainSupervisor, ...args: Parameters<typeof reconcile>) {
            if (!firstPromotion) return reconcile.apply(this, args);
            firstPromotion = false;
            promoting.resolve();
            await promote.promise;
            try { return await reconcile.apply(this, args); }
            finally { reconciled.resolve(); }
        });
        try {
            const task = await daemon.runLoop({ workspaceId, workerId, prompt: "Finish the original request." });
            taskLoopId = task.loopId;
            await concluding.promise;
            const arrival = await daemon.runLoop({ workspaceId, workerId, prompt: "A now-cancelled follow-up request." });
            assert.equal(arrival.loopId, task.loopId);
            assert.equal(arrival.action, "injected_next_turn");
            conclude.resolve();
            await promoting.promise;
            assert.equal((await db.test_get_loop_status.get({ id: task.loopId }))?.status, 200);
            await daemon.cancelWorker({ workspaceId, workerId });
            promote.resolve();
            await reconciled.promise;
            assert.equal((await db.test_get_loop_status.get({ id: task.loopId }))?.status, 200,
                "cancellation does not rewrite a completed result");
            assert.equal((await db.test_loop_queue_by_worker.all<{ status: number }>({ worker_id: workerId }))
                .some(({ status }) => [100, 102, 202].includes(status)), false, "cancelled unread work was not promoted");
            assert.deepEqual(await db.recovery_orphan_prompt_sources.all({}), [], "boot cannot resurrect the cancelled arrival");
            assert.equal((await db.test_prompt_paths_by_owner.all({ owner_id: workerId })).length, 2,
                "both original prompt frames remain available as evidence");
            await daemon.stop();
            const restarted = new Daemon({ db, provider });
            await restarted.start();
            try {
                const fresh = await restarted.runLoop({ workspaceId, workerId, prompt: "This is an independent new request." });
                await waitForDb(async () => (await db.test_get_loop_status.get({ id: fresh.loopId }))?.status, (status) => status === 200);
                assert.notEqual(fresh.loopId, task.loopId);
                assert.equal(provider.received.length, 2, "only the explicit new request ran after restart");
            } finally { await restarted.stop(); }
        } finally {
            conclude.resolve();
            promote.resolve();
        }
    });
});

for (const recipientState of ["idle", "parked"]) {
    test(`{§worker-lifecycle-no-resurrection}: cancelled SEND cannot deliver to a ${recipientState} recipient`, async (t) => {
        const wait = makeMockResponse("```TASK <60,0>\n[{\"content\":\"Waiting for a message.\",\"status\":\"waiting\"}]\n```");
        const provider = new Mock({ contextWindow: 100000, responses: [
            ...(recipientState === "parked" ? [wait] : []),
            makeMockResponse("```SEND (worker://recipient)\nThis message must not escape cancellation.\n```\n```SEND\nSent.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
            wait,
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-send-${recipientState}` });
            const sourceWorkerId = await daemon.ensureModelWorker(workspaceId);
            const { workerId } = await daemon.createConversationWorker({ workspaceId, name: "recipient" });
            if (recipientState === "parked") {
                const task = await daemon.runLoop({ workspaceId, workerId, prompt: "Await instructions." });
                await waitForDb(async () => (await db.test_get_loop_status.get({ id: task.loopId }))?.status, (status) => status === 202);
            }
            const promptsBefore = await db.test_prompt_paths_by_owner.all({ owner_id: workerId });
            const loopsBefore = await db.test_loop_queue_by_worker.all({ worker_id: workerId });
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const finished = Promise.withResolvers<void>();
            const inject = Daemon.prototype.inject;
            const run = LoopDriver.prototype.runLoop;
            t.mock.method(Daemon.prototype, "inject", async function (this: Daemon, args: Parameters<typeof inject>[0]) {
                if (args.workerId === workerId) {
                    entered.resolve();
                    await release.promise;
                }
                return inject.call(this, args);
            });
            t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
                try { return await run.apply(this, args); }
                finally { if (args[0].workerId === sourceWorkerId) finished.resolve(); }
            });
            try {
                const task = await daemon.runLoop({ workspaceId, workerId: sourceWorkerId, prompt: "Send instructions to recipient." });
                await entered.promise;
                await daemon.cancelWorker({ workspaceId, workerId: sourceWorkerId });
                assert.equal((await db.test_get_loop_status.get({ id: task.loopId }))?.status, 499);
                release.resolve();
                await finished.promise;
                assert.deepEqual(await db.test_prompt_paths_by_owner.all({ owner_id: workerId }), promptsBefore,
                    "the cancelled source did not append a prompt to the recipient");
                assert.deepEqual(await db.test_loop_queue_by_worker.all({ worker_id: workerId }), loopsBefore,
                    "the cancelled source did not start or wake recipient work");
                const receipt = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: task.loopId }))
                    .find((row) => row.op === "SEND" && row.status_rx === 409);
                assert.ok(receipt, "the stopped message has an explicit refusal receipt");
                assert.equal(JSON.parse(receipt.rx).problem.type, "https://problems.plurnk.xyz/daemon/admission/source-not-running");
            } finally {
                release.resolve();
                await daemon.cancelWorker({ workspaceId, workerId: sourceWorkerId });
                await daemon.cancelWorker({ workspaceId, workerId });
            }
        });
    });
}
