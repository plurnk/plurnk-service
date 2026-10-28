import test, { describe } from "node:test";
import assert from "node:assert/strict";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import Turn from "../../src/core/Turn.ts";
import LoopDriver from "../../src/core/LoopDriver.ts";
import SessionCap from "../../src/core/session-cap.ts";
import Daemon from "../../src/server/Daemon.ts";
import Engine from "../../src/core/Engine.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, holdChild } from "./_db.ts";
import { serverProposals } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse, answer } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelSession, admitTogether } from "./_sessions.ts";

describe("loop-lifecycle", () => {
test("{§session-loop-lifecycle} loop transitions are guarded and terminal state is immutable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "work");
        const lifecycle = new LoopLifecycle(db);

        assert.equal(await lifecycle.wake(loopId), false, "an active loop cannot be woken");
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), false, "a parked loop cannot be parked twice");
        assert.equal(await lifecycle.wake(loopId), true);
        const deliverable = { status: 200, content: "done", mimetype: "text/markdown" };
        assert.deepEqual(
            await lifecycle.finish(loopId, deliverable),
            deliverable,
        );
        assert.equal(
            await lifecycle.finish(
                loopId,
                Results.failure("lifecycle:cancel", "loop-cancelled", 499, "late cancel"),
                { terminatedBy: "cancel" },
            ),
            null,
            "a terminal winner cannot be rewritten",
        );
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), false);
        assert.equal(await lifecycle.wake(loopId), false);
        assert.equal(await lifecycle.status(loopId), 200);
        assert.deepEqual(await lifecycle.result(loopId), deliverable);
    } finally {
        await db.close();
    }
});

test("{§operation-results} structured cancellation atomically claims the unresolved descendant tree", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cancel-tree-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const rootLoop = await insertLoop(db, root, 1, "root");
        const child = await insertSession(db, workspaceId, root, "child");
        const childLoop = await insertLoop(db, child, 1, "child");
        const grandchild = await insertSession(db, workspaceId, child, "grandchild");
        const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild");
        const sibling = await insertSession(db, workspaceId, null, "sibling");
        const siblingLoop = await insertLoop(db, sibling, 1, "sibling");

        const cancelled = await new LoopLifecycle(db).cancelTree(root, "scope abandoned", false);

        assert.deepEqual(cancelled.sessionIds, [grandchild, child], "descendants are returned deepest-first for process-local reap");
        assert.deepEqual(new Set(cancelled.loops.map(({ loopId }) => loopId)), new Set([childLoop, grandchildLoop]));
        const status = async (loopId: number): Promise<number | undefined> =>
            (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(await status(rootLoop), 102, "includeRoot=false preserves the already-settling parent");
        assert.equal(await status(childLoop), 499);
        assert.equal(await status(grandchildLoop), 499);
        assert.equal(await status(siblingLoop), 102, "unowned siblings are untouched");
        for (const loop of cancelled.loops) {
            assert.equal(loop.result.status, 499);
            assert.equal(loop.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
            assert.equal(loop.result.problem?.instance, `ops://${loop.sessionId === child ? "child" : "grandchild"}/1`);
            assert.equal(loop.result.problem?.detail, "The session scope was cancelled: scope abandoned."); // {§operation-results}
            assert.equal(loop.result.problem?.reason, "scope abandoned");
            assert.equal(loop.result.problem?.stage, "loop");
            assert.equal(loop.result.problem?.retryable, false);
        }
        // {§session-causal-admission} — the session row carries the cancellation that retired its loops;
        // an untouched session carries none.
        const cancellation = async (id: number): Promise<unknown> =>
            JSON.parse((await db.test_get_session_cancellation.get<{ cancellation: string | null }>({ id }))?.cancellation ?? "null");
        assert.equal((await cancellation(child) as { problem: { reason: string } }).problem.reason, "scope abandoned");
        assert.equal((await cancellation(grandchild) as { status: number }).status, 499);
        assert.equal(await cancellation(sibling), null);
        assert.equal(await cancellation(root), null, "includeRoot=false leaves the root's cancellation unwritten");
    } finally {
        await db.close();
    }
});

test("{§operation-results} {§session-loop-lifecycle} cancelTree never resurrects a prior loop settled with 499 cancel", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cancel-cutoff-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "main");
        const firstLoop = await insertLoop(db, sessionId, 1, "first");
        const lifecycle = new LoopLifecycle(db);

        await lifecycle.finish(
            firstLoop,
            Results.failure("lifecycle:cancel", "loop-cancelled", 499, "The loop was cancelled: daemon_stopping.", {
                reason: "daemon_stopping",
                stage: "loop",
                retryable: false,
            }),
            { terminatedBy: "cancel" },
        );

        const secondLoop = await insertLoop(db, sessionId, 2, "second");
        const cancelled = await lifecycle.cancelTree(sessionId, "Cancelled by ACP client", true);

        assert.deepEqual(
            cancelled.loops.map(({ loopId }) => loopId),
            [secondLoop],
            "only the active loop is returned; prior 499-cancelled loops are never re-emitted",
        );
        assert.equal(
            cancelled.loops[0]?.result.problem?.detail,
            "The session scope was cancelled: Cancelled by ACP client.",
        );
    } finally {
        await db.close();
    }
});

test("{§session-loop-lifecycle} an uncommon terminal status remains exact in the result while the scheduler stores its terminal class", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-projection-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "work");
        const lifecycle = new LoopLifecycle(db);
        const failure = Results.failure(
            "engine:provider",
            "provider-threw",
            502,
            "The provider returned an invalid response.",
        );

        const exact = await lifecycle.finish(loopId, failure);

        assert.equal(await lifecycle.status(loopId), 500, "the scheduler sees one terminal failure class");
        assert.equal(exact?.status, 502, "the product result retains the exact status");
        assert.equal(exact?.problem?.status, 502);
        const name = (await db.session_name_by_id.get<{ name: string }>({ session_id: sessionId }))!.name;
        assert.equal(exact?.problem?.instance, `ops://${name}/1`);
        assert.deepEqual(await lifecycle.result(loopId), exact);
    } finally {
        await db.close();
    }
});

test("{§session-loop-lifecycle} 202 remains a parked lifecycle state and cannot be stored as a terminal result", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-park-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "work");
        const lifecycle = new LoopLifecycle(db);

        await assert.rejects(
            () => lifecycle.finish(loopId, { status: 202 }),
            /202 is the parked lifecycle state/,
        );
        assert.equal(await lifecycle.status(loopId), 102);
        assert.equal(await lifecycle.result(loopId), null);
    } finally {
        await db.close();
    }
});

test("{§session-wait-timing}: the wake time commits with the park and survives a new lifecycle owner", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "atomic-wait-deadline");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect running work");
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.park(loopId, { wakenBy: "obligations", pollAt: 10_600 }), true);
        assert.deepEqual((await new LoopLifecycle(db).parked(sessionId))[0], {
            id: loopId, wait_revision: 1, wait_poll_at: 10_600,
        });
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_599 }), false);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_600 }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_601 }), false);
        assert.equal(await lifecycle.status(loopId), 100, "expiry queues the same loop; it does not conclude it");
        assert.equal(await lifecycle.result(loopId), null);
    } finally { await db.close(); }
});

test("{§session-wait-timing}: durable observation times cannot resume another wait generation", async (t) => {
    t.mock.method(Date, "now", () => 10_000);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "durable-wait");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "original task");
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture", pollAt: 10_100 }), true);
        assert.deepEqual((await lifecycle.parked(sessionId))[0], { id: loopId, wait_revision: 1, wait_poll_at: 10_100 });
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_099 }), false);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_100 }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_300 }), false, "duplicate wake is inert");
        const claimed = await db.drain_claim_next_loop.get<{ id: number; prompt: string }>({ session_id: sessionId });
        assert.equal(claimed?.id, loopId);
        assert.equal(claimed?.prompt, "original task", "a wake is not another prompt or task");
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 99_999 }), false, "an old timer cannot wake a new wait");
        assert.equal((await lifecycle.parked(sessionId))[0]?.wait_poll_at, null, "a new wait starts without an observation time");
        await lifecycle.cancelTree(sessionId, "cancel waiting work", true);
        assert.equal(await lifecycle.wake(loopId, { revision: 2, dueAt: 99_999 }), false, "cancellation wins over every late timer");
        assert.equal(await lifecycle.status(loopId), 499);
    } finally { await db.close(); }
});

test("{§session-wait-timing}: multiple parked loops retain independent event observation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "independent-wakes");
        const parent = await insertSession(db, workspaceId, null, "parent");
        const first = await insertLoop(db, parent, 1);
        const second = await insertLoop(db, parent, 2);
        const child = await insertSession(db, workspaceId, parent, "child");
        const childLoop = await insertLoop(db, child, 1);
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.park(first, { wakenBy: "test-fixture" });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false);
        await lifecycle.finish(childLoop, { status: 200, content: "child finished" });
        // Completion lands while second is active, before its parked transition.
        await lifecycle.park(second, { wakenBy: "test-fixture" });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), true);
        assert.equal(await lifecycle.wake(second, { eventOnly: true }), true, "the first loop cannot consume the second's wake");
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false);
        assert.equal(await lifecycle.wake(second, { eventOnly: true }), false);
        await db.engine_reclaim_queued_loop.run({ loop_id: first });
        const next = await Turn.open(db, { loopId: first, producer: "model", kind: "inference" });
        await Turn.complete(db, next.id, 202);
        await lifecycle.park(first, { wakenBy: "test-fixture" });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false,
            "a delayed duplicate completion cannot wake a later program that already observed it");
    } finally { await db.close(); }
});

for (const disposition of ["park", "finish", "cancel", "exception"] as const) {
    test(`{§session-wait-timing}: ${disposition} saves consumption and retires its timer`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
        let clock = 1000;
        t.mock.method(performance, "now", () => clock);
        const db = await openMigrated();
        const lifecycle = new LoopLifecycle(db);
        let loopId: number | undefined;
        try {
            const workspaceId = await insertWorkspace(db, `execution-${disposition}`);
            const sessionId = await insertSession(db, workspaceId);
            loopId = await insertLoop(db, sessionId, 1);
            let expired = false;
            assert.equal(await lifecycle.startExecution(loopId, 60000, () => { expired = true; }), true);
            clock += 40000;
            t.mock.timers.tick(40000);
            if (disposition === "park") await lifecycle.park(loopId, { wakenBy: "test-fixture" });
            else if (disposition === "finish") await lifecycle.finish(loopId, { status: 200 });
            else if (disposition === "cancel") await lifecycle.cancelTree(sessionId, "cancel task", true);
            else await lifecycle.endExecution(loopId);
            assert.deepEqual(await db.test_get_loop_execution.get({ id: loopId }), {
                execution_budget_ms: 60000, execution_elapsed_ms: 40000,
            }, "consumption is durable at the transition, not waiting for driver teardown");
            clock += 60000;
            t.mock.timers.tick(60000);
            assert.equal(expired, false, "the retired execution timer cannot fire into another lifecycle state");
        } finally {
            if (loopId !== undefined) await lifecycle.endExecution(loopId);
            await db.close();
        }
    });
}

test("{§session-wait-timing}: execution time is monotonic and invalid transitions cannot disable its timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    let clock = 1000;
    t.mock.method(performance, "now", () => clock);
    const db = await openMigrated();
    const lifecycle = new LoopLifecycle(db);
    let loopId: number | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "monotonic-execution");
        const sessionId = await insertSession(db, workspaceId);
        loopId = await insertLoop(db, sessionId, 1);
        const id = loopId;
        let expired = false;
        assert.equal(await lifecycle.startExecution(id, 60000, () => { expired = true; }), true);
        await assert.rejects(() => lifecycle.finish(id, { status: 202 }), /202 is the parked lifecycle state/);
        t.mock.timers.setTime(Date.now() - 86_400_000);
        clock += 40000;
        t.mock.timers.tick(40000);
        assert.equal(expired, false);
        await lifecycle.park(id, { wakenBy: "test-fixture" });
        assert.deepEqual(await db.test_get_loop_execution.get({ id }), {
            execution_budget_ms: 60000, execution_elapsed_ms: 40000,
        }, "a wall-clock correction cannot refund execution");
        await lifecycle.wake(id);
        await db.engine_reclaim_queued_loop.run({ loop_id: id });
        assert.equal(await lifecycle.startExecution(id, 120000, () => { expired = true; }), true);
        clock += 20000;
        t.mock.timers.tick(20000);
        assert.equal(expired, true, "the original allowance still expires after 60s of monotonic execution");
    } finally {
        if (loopId !== undefined) await lifecycle.endExecution(loopId);
        await db.close();
    }
});
});

describe("Daemon.causal-admission", () => {
for (const op of ["WORK", "FORK"]) {
    test(`{§session-causal-admission}: ${op} cannot admit a child after its source task is cancelled`, async (t) => {
    serverProposals(t, "accept");
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse(`\`\`\`\`${op} (session://late-child)
Do the delegated task.
\`\`\`\`
\`\`\`\`WAIT
Wait for the child.
\`\`\`\``),
            makeMockResponse("````WAIT\nChild task is still running.\n````"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-late-${op}` });
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const finished = Promise.withResolvers<void>();
            const deny = SessionCap.deny;
            const run = LoopDriver.prototype.runLoop;
            t.mock.method(SessionCap, "deny", async (...args: Parameters<typeof deny>) => {
                entered.resolve();
                await release.promise;
                return deny(...args);
            });
            t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
                try { return await run.apply(this, args); }
                finally { if (args[0].sessionId === sessionId) finished.resolve(); }
            });
            try {
                const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Delegate this task." });
                await entered.promise;
                await daemon.cancelSession({ workspaceId, sessionId });
                assert.equal((await db.test_get_loop_status.get({ id: accepted.loopId }))?.status, 499);
                release.resolve();
                await finished.promise;
                const sessions = await db.test_sessions_by_workspace.all<{ id: number }>({ workspace_id: workspaceId });
                const tasks = (await Promise.all(sessions.map(({ id }) =>
                    db.test_loop_queue_by_session.all<{ status: number }>({ session_id: id })))).flat();
                assert.equal(tasks.some(({ status }) => [100, 102, 202].includes(status)), false,
                    "no late runnable child escapes the cancelled parent task");
                assert.equal(provider.received.length, 1, "cancellation prevented child inference");
                const receipt = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: accepted.loopId }))
                    .find((row) => row.op === op);
                assert.equal(receipt?.status_rx, 409, "the stopped delivery has an explicit refusal receipt");
                assert.equal(JSON.parse(receipt.rx).problem.type, "https://problems.plurnk.xyz/daemon/admission/source-not-running");
            } finally {
                release.resolve();
                await daemon.cancelSession({ workspaceId, sessionId });
            }
        });
    });
}

test("{§session-causal-admission}: cancellation wins over completion with an unread arrival and survives restart", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````SEND [200]\nFinished the original request.\n````"),
        makeMockResponse("````SEND [200]\nIndependent new request completed.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-prompt-promotion" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const concluding = Promise.withResolvers<void>();
        const conclude = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        const finish = LoopLifecycle.prototype.finish;
        const run = LoopDriver.prototype.runLoop;
        let taskLoopId: number | undefined;
        let firstConclusion = true;
        t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
            if (args[0] === taskLoopId && args[1].status === 200 && firstConclusion) {
                firstConclusion = false;
                concluding.resolve();
                await conclude.promise;
            }
            return finish.apply(this, args);
        });
        t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
            try { return await run.apply(this, args); }
            finally { if (args[0].sessionId === sessionId) finished.resolve(); }
        });
        try {
            const task = await daemon.runLoop({ workspaceId, sessionId, prompt: "Finish the original request." });
            taskLoopId = task.loopId;
            await concluding.promise;
            const arrival = await daemon.runLoop({ workspaceId, sessionId, prompt: "A now-cancelled follow-up request." });
            assert.equal(arrival.loopId, task.loopId);
            assert.equal(arrival.action, "injected_next_turn");
            await daemon.cancelSession({ workspaceId, sessionId });
            conclude.resolve();
            await finished.promise;
            assert.equal((await db.test_get_loop_status.get({ id: task.loopId }))?.status, 499,
                "the pending completion cannot overwrite cancellation");
            assert.equal((await db.test_loop_queue_by_session.all<{ status: number }>({ session_id: sessionId }))
                .some(({ status }) => [100, 102, 202].includes(status)), false, "cancelled unread work was not promoted");
            assert.deepEqual(await db.recovery_orphan_message_sources.all({}), [], "boot cannot resurrect the cancelled arrival");
            assert.equal((await db.test_messages_by_session.all({ session_id: sessionId })).length, 2,
                "both original messages remain available as evidence");
            await daemon.stop();
            const restarted = new Daemon({ db, provider });
            await restarted.start();
            try {
                const fresh = await restarted.runLoop({ workspaceId, sessionId, prompt: "This is an independent new request." });
                await waitForDb(async () => (await db.test_get_loop_status.get({ id: fresh.loopId }))?.status, (status) => status === 200);
                assert.notEqual(fresh.loopId, task.loopId);
                assert.equal(provider.received.length, 2, "only the explicit new request ran after restart");
            } finally { await restarted.stop(); }
        } finally {
            conclude.resolve();
        }
    });
});

for (const recipientState of ["idle", "parked"]) {
    test(`{§session-causal-admission}: cancelled SEND cannot deliver to a ${recipientState} recipient`, async (t) => {
        const wait = makeMockResponse("````WAIT\nWaiting for a message.\n````");
        const provider = new Mock({ contextWindow: 100000, responses: [
            ...(recipientState === "parked" ? [wait] : []),
            makeMockResponse("````SEND (session://recipient)\nThis message must not escape cancellation.\n````\n````SEND\nSent.\n````"),
            wait,
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-send-${recipientState}` });
            const sourceSessionId = await namedModelSession(daemon, workspaceId, "main");
            const { sessionId } = await daemon.createSession({ workspaceId, name: "recipient" });
            await holdChild(db, workspaceId, sessionId);
            if (recipientState === "parked") {
                const task = await daemon.runLoop({ workspaceId, sessionId, prompt: "Await instructions." });
                await waitForDb(async () => (await db.test_get_loop_status.get({ id: task.loopId }))?.status, (status) => status === 202);
            }
            const promptsBefore = await db.test_messages_by_session.all({ session_id: sessionId });
            const loopsBefore = await db.test_loop_queue_by_session.all({ session_id: sessionId });
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const finished = Promise.withResolvers<void>();
            const inject = Daemon.prototype.inject;
            const run = LoopDriver.prototype.runLoop;
            t.mock.method(Daemon.prototype, "inject", async function (this: Daemon, args: Parameters<typeof inject>[0]) {
                if (args.sessionId === sessionId) {
                    entered.resolve();
                    await release.promise;
                }
                return inject.call(this, args);
            });
            t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
                try { return await run.apply(this, args); }
                finally { if (args[0].sessionId === sourceSessionId) finished.resolve(); }
            });
            try {
                const task = await daemon.runLoop({ workspaceId, sessionId: sourceSessionId, prompt: "Send instructions to recipient." });
                await entered.promise;
                await daemon.cancelSession({ workspaceId, sessionId: sourceSessionId });
                assert.equal((await db.test_get_loop_status.get({ id: task.loopId }))?.status, 499);
                release.resolve();
                await finished.promise;
                assert.deepEqual(await db.test_messages_by_session.all({ session_id: sessionId }), promptsBefore,
                    "the cancelled source did not append a prompt to the recipient");
                assert.deepEqual(await db.test_loop_queue_by_session.all({ session_id: sessionId }), loopsBefore,
                    "the cancelled source did not start or wake recipient work");
                const receipt = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: task.loopId }))
                    .find((row) => row.op === "SEND" && row.status_rx === 409);
                assert.ok(receipt, "the stopped message has an explicit refusal receipt");
                assert.equal(JSON.parse(receipt.rx).problem.type, "https://problems.plurnk.xyz/daemon/admission/source-not-running");
            } finally {
                release.resolve();
                await daemon.cancelSession({ workspaceId, sessionId: sourceSessionId });
                await daemon.cancelSession({ workspaceId, sessionId });
            }
        });
    });
}
});

describe("Daemon.loop-address", () => {
test("{§session-wait-timing}: explicit delivery wakes its addressed parked Loop, not the oldest", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: Array.from({ length: 3 }, () => makeMockResponse("````WAIT\n````")) });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "loop-address" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await holdChild(db, workspaceId, sessionId);
        const common = { workspaceId, sessionId, providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            effort: "adaptive" as const, systemPrompt: "test system" };
        const [first, second] = await admitTogether(t, sessionId, [
            () => daemon.inject({ ...common, prompt: "first" }), () => daemon.inject({ ...common, prompt: "second" }),
        ]);
        try {
            await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }),
                (loops) => loops.length === 2 && loops.every(({ status }) => status === 202));
            const accepted = await daemon.runLoop({ workspaceId, sessionId, loopId: second.loopId, prompt: "addressed arrival" });
            assert.equal(accepted.loopId, second.loopId);
            assert.equal(accepted.action, "injected_next_turn");
            await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }),
                (loops) => provider.received.length === 3 && loops.every(({ status }) => status === 202));
            assert.equal((await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === first.loopId)?.status, 202);
            const messages = await daemon.readMessages({ workspaceId, sessionId, loopId: second.loopId });
            assert.ok(messages.some(({ body }) => body === "addressed arrival"));
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});

test("{§session-wait-timing}: terminal, foreign and missing recipients create no replacement work", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [answer("finished"), makeMockResponse("````WAIT\n````")] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "loop-address-refusal" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const other = await daemon.createSession({ workspaceId });
        const terminal = await daemon.runLoop({ workspaceId, sessionId, prompt: "finish" });
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }), (loops) => loops[0]?.status === 200);
        await holdChild(db, workspaceId, other.sessionId);
        const foreign = await daemon.runLoop({ workspaceId, sessionId: other.sessionId, prompt: "wait" });
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId: other.sessionId }), (loops) => loops[0]?.status === 202);
        const before = await daemon.listSessionLoops({ workspaceId, sessionId });
        for (const loopId of [terminal.loopId, foreign.loopId, 999_999]) {
            await assert.rejects(daemon.runLoop({ workspaceId, sessionId, loopId, prompt: "must not be admitted" }),
                (error: unknown) => error instanceof OperationFailureError && error.result.status === 409
                    && error.result.problem.type === "https://problems.plurnk.xyz/daemon/admission/loop-not-open");
        }
        assert.deepEqual(await daemon.listSessionLoops({ workspaceId, sessionId }), before);
        assert.equal(provider.received.length, 2);
        assert.equal((await daemon.readMessages({ workspaceId, sessionId })).some(({ body }) => body === "must not be admitted"), false);
    });
});
});

describe("Daemon.wait-obligations", () => {
// {§session-wait-timing} — parked loops of one session keep their identity under arrivals and
// cancellation; the waits park on live work the fixture holds.
test("{§session-wait-timing}: a message's reported and actual receiving loop agree with several parked loops", async (t) => {
    // The waits park on live work the fixture holds; the message is what wakes one of them.
    const provider = new Mock({
        contextWindow: 65536,
        responses: [
            makeMockResponse("````WAIT\nFirst task waits.\n````"),
            makeMockResponse("````WAIT\nSecond task waits.\n````"),
            makeMockResponse("````NOTE\nThe new message reached the receiving task.\n````\n````WAIT\n````"),
        ],
    });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "two-parked-recipients" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await holdChild(db, workspaceId, sessionId);
        try {
            const common = {
                workspaceId, sessionId,
                providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                effort: "adaptive" as const, systemPrompt: "test system",
            };
            const accepted = await admitTogether(t, sessionId, [
                () => daemon.inject({ ...common, prompt: "First task." }),
                () => daemon.inject({ ...common, prompt: "Second task." }),
            ]);
            const ids = new Set(accepted.map(({ loopId }) => loopId));
            await waitForDb(
                async () => (await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: sessionId }))
                    .filter(({ id }) => ids.has(id)),
                (loops) => loops.length === 2 && loops.every(({ status }) => status === 202),
            );
            const delivered = await daemon.runLoop({ workspaceId, sessionId, prompt: "A new message." });
            assert.equal(delivered.loopId, accepted[0]?.loopId, "return and wake the same oldest unfinished loop that owns the message");
            await waitForDb(() => db.test_log_entries_by_loop.all<{ op: string; tx: string }>({ loop_id: delivered.loopId }),
                (rows) => rows.some(({ op, tx }) => op === "NOTE" && tx.includes("new message reached")));
            assert.equal(provider.received.length, 3);
            assert.ok(JSON.stringify(provider.received[2]).includes("A new message."));
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: accepted[1].loopId }))?.status, 202,
                "a message does not resume an unrelated wait");
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});

test("{§session-causal-admission}: a concurrent cancellation leaves no runnable orphan message", async (t) => {
    const provider = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse("````WAIT\nWait.\n````"),
        makeMockResponse("````SEND [200]\nMust not execute the cancelled follow-up.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-admission-race" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await holdChild(db, workspaceId, sessionId);
        const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Original task." });
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
        const injection = daemon.runLoop({ workspaceId, sessionId, prompt: "Follow-up before cancellation." });
        await entered.promise;
        const cancellation = daemon.cancelSession({ workspaceId, sessionId });
        try {
            await lifecycle.status(accepted.loopId);
            release.resolve();
            await Promise.all([injection, cancellation]);
            assert.equal(await lifecycle.status(accepted.loopId), 499);
            const loops = await db.test_loop_queue_by_session.all<{ prompt: string; status: number }>({ session_id: sessionId });
            assert.equal(loops.some(({ prompt, status }) => prompt === "Follow-up before cancellation." && status < 200), false,
                "a concurrent cancel cannot strand a fresh follow-up outside its scope");
            assert.equal(provider.received.length, 1, "the cancelled message was not dispatched");
        } finally {
            release.resolve();
            await daemon.cancelSession({ workspaceId, sessionId });
        }
    });
});
});

describe("loop-claim-latency", () => {
// {§session-wait-timing} — a loop's first claim is a durable fact, so wake-to-first-turn latency is measurable (#703).
test("{§session-wait-timing}: a queued loop is stamped when first claimed; a running insert at insertion; later claims never move it", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, await insertWorkspace(db, `claim-${crypto.randomUUID()}`));
        const claimed = async (id: number) => (await db.test_get_loop_claimed_at.get<{ claimed_at: string | null }>({ id }))?.claimed_at ?? null;

        const queued = (await db.test_insert_queued_loop.get<{ id: number }>({ session_id: sessionId, sequence: 1, prompt: "later" }))!.id;
        assert.equal(await claimed(queued), null, "a queued loop has not been claimed");
        await db.test_set_loop_status.run({ id: queued, status: 102, terminal_result: null });
        const first = await claimed(queued);
        assert.match(String(first), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/u);
        await db.test_set_loop_status.run({ id: queued, status: 100, terminal_result: null });
        await db.test_set_loop_status.run({ id: queued, status: 102, terminal_result: null });
        assert.equal(await claimed(queued), first, "a re-claim keeps the first claim");

        const running = await insertLoop(db, sessionId, 2, "now");
        assert.notEqual(await claimed(running), null, "a loop inserted running is claimed at insertion");
    } finally { await db.close(); }
});
});
