import test from "node:test";
import assert from "node:assert/strict";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import Turn from "../../src/core/Turn.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("loop transitions are guarded and terminal state is immutable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "work");
        const lifecycle = new LoopLifecycle(db);

        assert.equal(await lifecycle.wake(loopId), false, "an active loop cannot be woken");
        assert.equal(await lifecycle.park(loopId), true);
        assert.equal(await lifecycle.park(loopId), false, "a parked loop cannot be parked twice");
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
        assert.equal(await lifecycle.park(loopId), false);
        assert.equal(await lifecycle.wake(loopId), false);
        assert.equal(await lifecycle.status(loopId), 200);
        assert.deepEqual(await lifecycle.result(loopId), deliverable);
    } finally {
        await db.close();
    }
});

test("structured cancellation atomically claims the unresolved descendant tree", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cancel-tree-${crypto.randomUUID()}`);
        const root = await insertWorker(db, workspaceId, null, "root");
        const rootLoop = await insertLoop(db, root, 1, "root");
        const child = await insertWorker(db, workspaceId, root, "child");
        const childLoop = await insertLoop(db, child, 1, "child");
        const grandchild = await insertWorker(db, workspaceId, child, "grandchild");
        const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild");
        const sibling = await insertWorker(db, workspaceId, null, "sibling");
        const siblingLoop = await insertLoop(db, sibling, 1, "sibling");

        const cancelled = await new LoopLifecycle(db).cancelTree(root, "scope abandoned", false);

        assert.deepEqual(cancelled.workerIds, [grandchild, child], "descendants are returned deepest-first for process-local reap");
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
            assert.equal(loop.result.problem?.instance, `loop:///${loop.loopId}`);
            assert.equal(loop.result.problem?.detail, "The worker scope was cancelled: scope abandoned.");
            assert.equal(loop.result.problem?.reason, "scope abandoned");
            assert.equal(loop.result.problem?.stage, "loop");
            assert.equal(loop.result.problem?.retryable, false);
        }
        // {§worker-cancel-trigger} — the worker row carries the cancellation that retired its loops;
        // an untouched worker carries none.
        const cancellation = async (id: number): Promise<unknown> =>
            JSON.parse((await db.test_get_worker_cancellation.get<{ cancellation: string | null }>({ id }))?.cancellation ?? "null");
        assert.equal((await cancellation(child) as { problem: { reason: string } }).problem.reason, "scope abandoned");
        assert.equal((await cancellation(grandchild) as { status: number }).status, 499);
        assert.equal(await cancellation(sibling), null);
        assert.equal(await cancellation(root), null, "includeRoot=false leaves the root's cancellation unwritten");
    } finally {
        await db.close();
    }
});

test("an uncommon terminal status remains exact in the result while the scheduler stores its terminal class", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-projection-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "work");
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
        assert.equal(exact?.problem?.instance, `loop:///${loopId}`);
        assert.deepEqual(await lifecycle.result(loopId), exact);
    } finally {
        await db.close();
    }
});

test("202 remains a parked lifecycle state and cannot be stored as a terminal result", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-park-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "work");
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

test("{§worker-wait-timing}: due times are durable and stale wait generations cannot resume another wait", async (t) => {
    t.mock.method(Date, "now", () => 10_000);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "durable-wait");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "original task");
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.park(loopId, { timeoutMs: 300, pollMs: 100 }), true);
        const [wait] = await new LoopLifecycle(db).parked(workerId);
        assert.deepEqual(wait, {
            id: loopId, wait_revision: 1, wait_deadline_at: 10_300,
            wait_poll_interval: 100, wait_poll_at: 10_100,
        });
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_099 }), false);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_100 }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_300 }), false, "duplicate wake is inert");
        const claimed = await db.drain_claim_next_loop.get<{ id: number; prompt: string }>({ worker_id: workerId, now: Date.now() });
        assert.equal(claimed?.id, loopId);
        assert.equal(claimed?.prompt, "original task", "a wake is not another prompt or task");
        assert.equal(await lifecycle.park(loopId, { timeoutMs: 500, pollMs: 0 }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 99_999 }), false, "an old timer cannot wake a new wait");
        assert.equal((await lifecycle.parked(workerId))[0]?.wait_poll_at, null, "zero disables polling");
        await lifecycle.cancelTree(workerId, "cancel timed work", true);
        assert.equal(await lifecycle.wake(loopId, { revision: 2, dueAt: 99_999 }), false, "cancellation wins over every late timer");
        assert.equal(await lifecycle.status(loopId), 499);
    } finally { await db.close(); }
});

test("{§loop-wake-identity}: multiple parked loops retain independent event observation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "independent-wakes");
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const first = await insertLoop(db, parent, 1);
        const second = await insertLoop(db, parent, 2);
        const child = await insertWorker(db, workspaceId, parent, "child");
        const childLoop = await insertLoop(db, child, 1);
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.park(first, { timeoutMs: 60_000 });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false);
        await lifecycle.finish(childLoop, { status: 200, content: "child finished" });
        // Completion lands while second is active, before its parked transition.
        await lifecycle.park(second, { timeoutMs: 60_000 });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), true);
        assert.equal(await lifecycle.wake(second, { eventOnly: true }), true, "the first loop cannot consume the second's wake");
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false);
        assert.equal(await lifecycle.wake(second, { eventOnly: true }), false);
        await db.engine_reclaim_queued_loop.run({ loop_id: first });
        const next = await Turn.open(db, { loopId: first, producer: "model", kind: "inference" });
        await Turn.complete(db, next.id, 202);
        await lifecycle.park(first, { timeoutMs: 120_000 });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false,
            "a delayed duplicate completion cannot wake a later program that already observed it");
    } finally { await db.close(); }
});

for (const disposition of ["park", "finish", "cancel", "exception"] as const) {
    test(`{§loop-execution-allowance}: ${disposition} saves consumption and retires its timer`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
        let clock = 1000;
        t.mock.method(performance, "now", () => clock);
        const db = await openMigrated();
        const lifecycle = new LoopLifecycle(db);
        let loopId: number | undefined;
        try {
            const workspaceId = await insertWorkspace(db, `execution-${disposition}`);
            const workerId = await insertWorker(db, workspaceId);
            loopId = await insertLoop(db, workerId, 1);
            let expired = false;
            assert.equal(await lifecycle.startExecution(loopId, 60000, () => { expired = true; }), true);
            clock += 40000;
            t.mock.timers.tick(40000);
            if (disposition === "park") await lifecycle.park(loopId, { timeoutMs: 60000 });
            else if (disposition === "finish") await lifecycle.finish(loopId, { status: 200 });
            else if (disposition === "cancel") await lifecycle.cancelTree(workerId, "cancel task", true);
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

test("{§loop-execution-allowance}: execution time is monotonic and invalid transitions cannot disable its timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    let clock = 1000;
    t.mock.method(performance, "now", () => clock);
    const db = await openMigrated();
    const lifecycle = new LoopLifecycle(db);
    let loopId: number | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "monotonic-execution");
        const workerId = await insertWorker(db, workspaceId);
        loopId = await insertLoop(db, workerId, 1);
        const id = loopId;
        let expired = false;
        assert.equal(await lifecycle.startExecution(id, 60000, () => { expired = true; }), true);
        await assert.rejects(() => lifecycle.finish(id, { status: 202 }), /202 is the parked lifecycle state/);
        t.mock.timers.setTime(Date.now() - 86_400_000);
        clock += 40000;
        t.mock.timers.tick(40000);
        assert.equal(expired, false);
        await lifecycle.park(id, { timeoutMs: 60000 });
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
