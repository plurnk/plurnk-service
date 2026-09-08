import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import Daemon from "../../src/server/Daemon.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { insertWorker } from "./_helpers.ts";
import { makeMockResponse, waitForDb, withDaemon } from "./_rpc.ts";

test("{§worker-scheduled-send}: directed timing queues a separate task without early inference or blocking a ready arrival", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("```SEND (worker://~) <60>\nCheck for updated revenue figures.\n```\n```DONE\nCheck scheduled.\n```"),
        makeMockResponse("```DONE\nAnswered the independent question.\n```"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-arrival" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        try {
            const before = Date.now();
            const initial = await daemon.runLoop({ workspaceId, workerId, prompt: "Schedule a later check." });
            await waitForDb(() => db.test_get_loop_status.get({ id: initial.loopId }), (row) => row?.status === 200);
            const loops = await daemon.listWorkerLoops({ workspaceId, workerId });
            assert.deepEqual(loops.filter(({ prompt }) => prompt !== "").map(({ prompt }) => prompt),
                ["Schedule a later check.", "Check for updated revenue figures."],
                "only the requested tasks are admitted, alongside ordinary administrative history");
            const scheduled = loops.find(({ prompt }) => prompt === "Check for updated revenue figures.")!;
            assert.ok(scheduled);
            assert.equal(scheduled.prompt, "Check for updated revenue figures.");
            assert.equal(scheduled.status, 100, "future work is queued, not running or WAITing");
            assert.equal(provider.received.length, 1, "scheduling itself consumes no extra inference");
            const receipts = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: initial.loopId });
            const accepted = receipts.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.loopId === scheduled.id);
            assert.ok(accepted, "SEND acknowledges the exact accepted task");
            assert.ok(Date.parse(accepted.scheduledAt) >= before + 3_600_000);
            const immediate = await daemon.runLoop({ workspaceId, workerId, prompt: "Answer an independent question now." });
            await waitForDb(() => db.test_get_loop_status.get({ id: immediate.loopId }), (row) => row?.status === 200);
            assert.equal(provider.received.length, 2, "a future item never blocks unrelated ready work");
            assert.equal((await db.test_get_loop_status.get({ id: scheduled.id }))?.status, 100);
            await daemon.cancelWorker({ workspaceId, workerId });
            assert.equal((await db.test_get_loop_status.get({ id: scheduled.id }))?.status, 499);
        } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
    });
});

for (const scope of ["<-1>", "<0,0>", "<0,-1>", "<0.5>", "<0,1,2>"]) {
    test(`{§worker-scheduled-send}: invalid timing ${scope} refuses only that SEND and admits no task`, async () => {
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse(`\`\`\`SEND (worker://~) ${scope}
Unadmitted scheduled instruction.
\`\`\`
\`\`\`NEXT
Inspect the timing refusal.
\`\`\``),
            makeMockResponse("```DONE\nThe requested timing was invalid.\n```"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "invalid-schedule" });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            try {
                const initial = await daemon.runLoop({ workspaceId, workerId, prompt: "Check invalid timing." });
                await waitForDb(() => db.test_get_loop_status.get({ id: initial.loopId }), (row) => row?.status === 200);
                const receipts = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: initial.loopId });
                const refusal = receipts.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.problem?.type.endsWith("/invalid-schedule"));
                assert.equal(refusal?.status, 400);
                assert.match(refusal.problem.detail, /delay.*interval.*whole minutes/);
                assert.deepEqual((await daemon.listWorkerLoops({ workspaceId, workerId }))
                    .filter(({ prompt }) => prompt !== "").map(({ id }) => id), [initial.loopId]);
                assert.equal(provider.received.length, 2);
            } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
        });
    });
}

function nextTermination(daemon: Daemon, workerId: number): Promise<{ loopId: number; result: { status: number } }> {
    return new Promise((resolve) => {
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            const event = params as { workerId: number; loopId: number; result: { status: number } };
            if (method !== "loop/terminated" || event.workerId !== workerId) return;
            unsubscribe();
            resolve(event);
        });
    });
}

for (const recurring of [false, true]) {
    test(`{§worker-scheduled-send}: ${recurring ? "recurrence" : "one-shot"} survives restart and runs once when due`, async (t) => {
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse("```DONE\nChecked the latest revenue figures.\n```"),
            makeMockResponse("```FAIL\nThe next check failed; stop the assignment.\n```"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-restart" });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const now = Date.now();
            const nextArmed = Promise.withResolvers<void>();
            const schedule = DrainSupervisor.prototype.scheduleWakes;
            t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
                await schedule.apply(this, args);
                if (args[1] !== workerId) return;
                const queued = await db.drain_scheduled_loops.all<{ scheduled_at: number }>({ worker_id: workerId });
                if (queued.some(({ scheduled_at }) => scheduled_at === now + 120_000)) nextArmed.resolve();
            });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
            let restarted: Daemon | undefined;
            try {
                const accepted = await daemon.inject({
                    workspaceId, workerId, prompt: "Check the latest revenue figures.",
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    reasoningPolicy: "adaptive", systemPrompt: "test system",
                    schedule: { delayMs: 60_000, ...(recurring ? { intervalMs: 60_000 } : {}) },
                    turnCeiling: { effective: 1, source: "explicit" },
                });
                assert.equal(accepted.scheduledAt, new Date(now + 60_000).toISOString());
                await daemon.stop();
                restarted = new Daemon({ db, provider });
                const activations: number[] = [];
                restarted.registerModule({ setup: (seam) => {
                    seam.registerWorkerCapabilityProvider("scheduled residency", {
                        activate: async ({ workerId: id }) => { activations.push(id); },
                        deactivate: async () => undefined,
                    });
                } });
                await restarted.start();
                assert.equal(provider.received.length, 0);
                assert.deepEqual(activations, [], "queued future work does not hydrate tools at boot");
                const firstDone = nextTermination(restarted, workerId);
                t.mock.timers.tick(59_999);
                assert.equal(provider.received.length, 0);
                t.mock.timers.tick(1);
                const first = await firstDone;
                assert.equal(first.loopId, accepted.loopId);
                assert.equal(first.result.status, 200);
                assert.equal(provider.received.length, 1);
                assert.deepEqual(activations, [workerId]);
                const loops = await restarted.listWorkerLoops({ workspaceId, workerId });
                const tasks = loops.filter(({ prompt }) => prompt === "Check the latest revenue figures.");
                assert.equal(tasks.length, recurring ? 2 : 1);
                if (recurring) {
                    const next = tasks[1]!;
                    assert.equal(next.status, 100);
                    assert.equal(next.recurrenceId, accepted.loopId);
                    assert.equal(next.intervalMinutes, 1);
                    assert.equal(next.scheduledAt, new Date(now + 120_000).toISOString());
                    await nextArmed.promise;
                    const secondDone = nextTermination(restarted, workerId);
                    t.mock.timers.tick(60_000);
                    const second = await secondDone;
                    assert.equal(second.loopId, next.id);
                    assert.equal(second.result.status, 499);
                    assert.equal(provider.received.length, 2, "the successor receives its own one-turn allowance");
                }
                t.mock.timers.tick(3_600_000);
                assert.equal(provider.received.length, recurring ? 2 : 1, "failure and one-shot success authorize no further inference");
                assert.equal((await restarted.listWorkerLoops({ workspaceId, workerId })).some(({ status }) => [100, 102, 202].includes(status)), false);
            } finally {
                t.mock.timers.reset();
                await restarted?.cancelWorker({ workspaceId, workerId });
                await restarted?.stop();
            }
        });
    });
}

test("{§worker-scheduled-send}: a backwards clock cannot re-delay a resumed occurrence", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("```WAIT <60,0>\nAwait information.\n```"),
        makeMockResponse("```DONE\nThe information arrived.\n```"),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "resumed-schedule-clock" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const now = Date.now();
        const args = { workspaceId, workerId, prompt: "Recurring check.",
            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            reasoningPolicy: "adaptive" as const, systemPrompt: "test system" };
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
        try {
            const initial = await daemon.inject({ ...args, schedule: { delayMs: 0, intervalMs: 60_000 } });
            await initial.drainPromise;
            t.mock.timers.setTime(now - 60_000);
            const resumed = await daemon.inject({ ...args, prompt: "The information is available now." });
            assert.equal(resumed.loopId, initial.loopId);
            assert.ok(resumed.firstLoopPromise, "waking an occurrence already in progress is immediately eligible, regardless of its original due slot");
            const done = await resumed.firstLoopPromise;
            assert.equal(done.result.status, 200);
            await resumed.drainPromise;
            assert.equal(provider.received.length, 2);
            const successor = (await daemon.listWorkerLoops({ workspaceId, workerId })).find(({ recurrenceId, id }) => recurrenceId === initial.loopId && id !== initial.loopId);
            assert.equal(successor?.scheduledAt, new Date(now + 60_000).toISOString(), "the next occurrence keeps the original cadence");
        } finally {
            t.mock.timers.reset();
            await daemon.cancelWorker({ workspaceId, workerId });
        }
    });
});

test("{§worker-scheduled-send}: owner loss fails an active recurrence without replay or a successor", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "interrupted-recurrence" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const accepted = await daemon.inject({
            workspaceId, workerId, prompt: "Do not replay uncertain work.",
            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            reasoningPolicy: "adaptive", systemPrompt: "test system", schedule: { delayMs: 60_000, intervalMs: 60_000 },
        });
        await db.drain_claim_next_loop.get({ worker_id: workerId, now: Date.parse(accepted.scheduledAt!) });
        await daemon.stop();
        const restarted = new Daemon({ db, provider });
        try {
            await restarted.start();
            const tasks = (await restarted.listWorkerLoops({ workspaceId, workerId })).filter(({ prompt }) => prompt === "Do not replay uncertain work.");
            assert.equal(tasks.length, 1);
            assert.equal(tasks[0]?.status, 500);
            assert.match(tasks[0]?.terminalResult?.problem?.detail ?? "", /interrupt|restart|owner/i);
            assert.equal(provider.received.length, 0);
        } finally { await restarted.stop(); }
    });
});

test("{§worker-scheduled-send}: concurrent scheduled arrivals and a successful recurrence allocate distinct ordered tasks", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "concurrent-scheduled-arrivals" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const args = { workspaceId, workerId, prompt: "Recurring instruction.",
            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            reasoningPolicy: "adaptive" as const, systemPrompt: "test system", schedule: { delayMs: 60_000 } };
        try {
            const first = await daemon.inject({ ...args, schedule: { delayMs: 60_000, intervalMs: 60_000 } });
            await db.drain_claim_next_loop.get({ worker_id: workerId, now: Date.parse(first.scheduledAt!) });
            await Promise.all([
                new LoopLifecycle(db).finish(first.loopId, { status: 200, content: "completed" }),
                daemon.inject({ ...args, prompt: "Independent task A." }),
                daemon.inject({ ...args, prompt: "Independent task B." }),
            ]);
            const tasks = await daemon.listWorkerLoops({ workspaceId, workerId });
            assert.deepEqual(tasks.map(({ sequence }) => sequence), [1, 2, 3, 4]);
            assert.deepEqual(tasks.map(({ prompt }) => prompt).sort(), [args.prompt, args.prompt, "Independent task A.", "Independent task B."].sort());
            assert.deepEqual(tasks.map(({ status }) => status), [200, 100, 100, 100]);
            assert.equal(provider.received.length, 0);
        } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
    });
});

test("{§worker-scheduled-send}: parked occurrences do not overlap, and corrections are not replayed into a coalesced successor", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("```WAIT <60,0>\nWaiting for more information.\n```"),
        makeMockResponse("```DONE\nFirst occurrence completed using the correction.\n```"),
        makeMockResponse("```FAIL\nThe later occurrence cannot complete.\n```"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "nonoverlapping-recurrence" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const now = Date.now();
        const parked = Promise.withResolvers<void>();
        const schedule = DrainSupervisor.prototype.scheduleWakes;
        t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
            await schedule.apply(this, args);
            if (args[1] === workerId && (await new LoopLifecycle(db).parked(workerId)).length > 0) parked.resolve();
        });
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
        try {
            const accepted = await daemon.inject({
                workspaceId, workerId, prompt: "Original recurring task.",
                providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                reasoningPolicy: "adaptive", systemPrompt: "test system", schedule: { delayMs: 0, intervalMs: 60_000 },
            });
            await parked.promise;
            t.mock.timers.tick(5 * 60_000);
            assert.equal(provider.received.length, 1, "five missed ticks cannot start another occurrence beside the parked one");
            assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId })).filter(({ prompt }) => prompt === "Original recurring task.").length, 1);
            const finished = Promise.withResolvers<void>();
            const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated" && (params as { result: { status: number } }).result.status === 499) finished.resolve();
            });
            try {
                const corrected = await daemon.runLoop({ workspaceId, workerId, prompt: "A correction for this occurrence only." });
                assert.equal(corrected.loopId, accepted.loopId);
                await finished.promise;
            } finally { unsubscribe(); }
            const tasks = (await daemon.listWorkerLoops({ workspaceId, workerId })).filter(({ prompt }) => prompt === "Original recurring task.");
            assert.deepEqual(tasks.map(({ status }) => status), [200, 499]);
            assert.equal(tasks[1]?.scheduledAt, new Date(now + 5 * 60_000).toISOString(), "overdue ticks become the latest single due slot");
            assert.equal(tasks[1]?.recurrenceId, accepted.loopId);
            assert.equal(provider.received.length, 3, "one resumed occurrence and one coalesced successor, no catch-up backlog");
        } finally {
            t.mock.timers.reset();
            await daemon.cancelWorker({ workspaceId, workerId });
        }
    });
});

for (const ordering of ["cancel-before-success", "success-before-cancel"] as const) {
    test(`{§worker-scheduled-send}: ${ordering} leaves no live successor`, async (t) => {
        const provider = new Mock({ contextWindow: 100000, responses: [makeMockResponse("```DONE\nOccurrence complete.\n```")] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: ordering });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const boundary = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const settled = Promise.withResolvers<void>();
            const finish = LoopLifecycle.prototype.finish;
            let targetId: number | undefined;
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
                if (args[0] !== targetId || args[1].status !== 200) return finish.apply(this, args);
                if (ordering === "cancel-before-success") {
                    boundary.resolve();
                    await release.promise;
                }
                const result = await finish.apply(this, args);
                if (ordering === "success-before-cancel") {
                    boundary.resolve();
                    await release.promise;
                }
                settled.resolve();
                return result;
            });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
            try {
                const accepted = await daemon.inject({
                    workspaceId, workerId, prompt: "Repeat until cancelled.",
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    reasoningPolicy: "adaptive", systemPrompt: "test system", schedule: { delayMs: 60_000, intervalMs: 60_000 },
                });
                targetId = accepted.loopId;
                t.mock.timers.tick(60_000);
                await boundary.promise;
                await daemon.cancelWorker({ workspaceId, workerId });
                release.resolve();
                await settled.promise;
                const tasks = (await daemon.listWorkerLoops({ workspaceId, workerId })).filter(({ prompt }) => prompt === "Repeat until cancelled.");
                assert.deepEqual(tasks.map(({ status }) => status), ordering === "cancel-before-success" ? [499] : [200, 499]);
                t.mock.timers.tick(3_600_000);
                assert.equal(provider.received.length, 1, "no stale callback restarts the cancelled recurrence");
            } finally {
                release.resolve();
                t.mock.timers.reset();
                await daemon.cancelWorker({ workspaceId, workerId });
            }
        });
    });
}

test("{§worker-scheduled-send}: cancellation reports a successor admitted after it began collecting targets", async (t) => {
    await withDaemon(new Mock({ contextWindow: 100000, responses: [] }), async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancellation-successor" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const accepted = await daemon.inject({
            workspaceId, workerId, prompt: "Recurring check.",
            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            reasoningPolicy: "adaptive", systemPrompt: "test system", schedule: { delayMs: 60_000, intervalMs: 60_000 },
        });
        await db.drain_claim_next_loop.get({ worker_id: workerId, now: Date.parse(accepted.scheduledAt!) });
        const lifecycle = new LoopLifecycle(db);
        const cancel = db.lifecycle_cancel_worker_tree;
        let finishDuringCancellation = true;
        t.mock.method(db, "lifecycle_cancel_worker_tree", async (...args: Parameters<typeof cancel>) => {
            if (finishDuringCancellation) {
                finishDuringCancellation = false;
                assert.equal((await lifecycle.finish(accepted.loopId, { status: 200, content: "complete" }))?.status, 200);
            }
            return cancel(...args);
        });
        try {
            const result = await lifecycle.cancelTree(workerId, "stop recurring check", true);
            const tasks = (await daemon.listWorkerLoops({ workspaceId, workerId })).filter(({ prompt }) => prompt === "Recurring check.");
            assert.deepEqual(tasks.map(({ status }) => status), [200, 499]);
            assert.deepEqual(result.loops.map(({ loopId }) => loopId), [tasks[1]!.id], "notify exactly the successor cancelled by this transition, not the already successful task");
            assert.deepEqual((await lifecycle.cancelTree(workerId, "already cancelled", true)).loops, [], "another cancellation cannot announce old cancellations again");
        } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
    });
});

test("{§worker-scheduled-send}: AG-UI reattachment exposes durable timing without launching the queued task", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    await withDaemon(provider, async (_db, daemon) => {
        const name = "scheduled-client";
        const { workspaceId } = await daemon.createWorkspace({ name });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const accepted = await daemon.inject({
            workspaceId, workerId, prompt: "Hourly review.",
            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            reasoningPolicy: "adaptive", systemPrompt: "test system", schedule: { delayMs: 60_000, intervalMs: 60_000 },
        });
        const agui = await AguiModule.init({ host: "127.0.0.1", port: 0 }).start(daemon);
        try {
            for (let connection = 0; connection < 2; connection++) {
                const response = await fetch(`http://127.0.0.1:${agui.address().port}/`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        threadId: name, runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                        forwardedProps: { plurnk: { workspace: name, action: { kind: "worker.model.get" } } },
                    }),
                });
                assert.equal(response.status, 200);
                const events = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
                    .map((frame) => JSON.parse(frame.slice(6)));
                const state = events.find(({ type }) => type === "STATE_SNAPSHOT")?.snapshot.plurnk.status;
                assert.equal(state?.lifecycle, "queued", "a future task is not running and is not a WAIT continuation");
                assert.equal(state?.loopId, accepted.loopId);
                assert.equal(state?.scheduledAt, accepted.scheduledAt);
                assert.equal(state?.intervalMinutes, 1);
                assert.equal(state?.recurrenceId, accepted.loopId);
                assert.equal(state?.packetCount, 0);
                assert.equal(provider.received.length, 0);
                assert.equal(events.at(-1)?.type, "RUN_FINISHED");
            }
        } finally {
            await agui.close();
            await daemon.cancelWorker({ workspaceId, workerId });
        }
    });
});

test("{§worker-scheduled-send}: a scheduled child's future work is visible, prevents TERM, and belongs to parent cancellation", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("```SEND (worker://reviewer) <60,60>\nCheck for updated revenue figures.\n```\n```NEXT\nInspect scheduling.\n```"),
        makeMockResponse("```DONE\nThe ongoing assignment is complete.\n```"),
        makeMockResponse("```WAIT\nWait for the scheduled child.\n```"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-child-obligation" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const childId = await insertWorker(db, workspaceId, workerId, "reviewer", "model");
        await daemon.setWorkerModel({ workspaceId, workerId: childId, selector: "mocktest" });
        try {
            const initial = await daemon.runLoop({ workspaceId, workerId, prompt: "Have reviewer perform an hourly check.", policy: { proposals: "accept" } });
            await waitForDb(() => db.test_get_loop_status.get({ id: initial.loopId }), (row) => row?.status === 202);
            assert.equal(provider.received.length, 3, "only the parent ran; the scheduled child is not due");
            const receipts = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: initial.loopId });
            assert.ok(receipts.some(({ op, rx }) => op === "DONE" && JSON.parse(rx).status === 409), "TERM is refused while the scheduled child remains live");
            const childLoops = await daemon.listWorkerLoops({ workspaceId, workerId: childId });
            const child = childLoops.find(({ prompt }) => prompt === "Check for updated revenue figures.");
            assert.equal(child?.status, 100);
            assert.equal(child?.intervalMinutes, 60);
            assert.ok(child?.scheduledAt);
            const packets = await db.test_list_turns_in_loop.all<{ packet: string | null }>({ loop_id: initial.loopId });
            assert.ok(packets.some(({ packet }) => packet?.includes("every 60 min") && packet.includes("worker://reviewer")), "the parent sees the live child's cadence in its actual packet");
            await daemon.cancelWorker({ workspaceId, workerId });
            assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId: childId })).find(({ id }) => id === child!.id)?.status, 499);
        } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
    });
});
