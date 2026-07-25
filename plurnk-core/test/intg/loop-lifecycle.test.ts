import test from "node:test";
import assert from "node:assert/strict";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("loop transitions are guarded and terminal state is immutable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "work");
        const lifecycle = new LoopLifecycle(db);

        assert.equal(await lifecycle.wake(loopId), false, "an active loop cannot be woken");
        assert.equal(await lifecycle.park(loopId, "waiting"), true);
        assert.equal(await lifecycle.park(loopId, "waiting twice"), false, "a parked loop cannot be parked twice");
        assert.equal(await lifecycle.wake(loopId), true);
        assert.equal(await lifecycle.finish(loopId, 200, "done"), true);
        assert.equal(await lifecycle.finish(loopId, 499, "late cancel", "cancel"), false, "a terminal winner cannot be rewritten");
        assert.equal(await lifecycle.park(loopId, "late park"), false);
        assert.equal(await lifecycle.wake(loopId), false);
        assert.equal(await lifecycle.status(loopId), 200);
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
    } finally {
        await db.close();
    }
});
