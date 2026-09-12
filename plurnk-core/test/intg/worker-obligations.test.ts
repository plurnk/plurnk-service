// {§worker-obligations} — what a worker still holds is one durable row: an open stream that is not
// detached, or a child with an unresolved loop. The completion gate, the wait matrix, and the drain
// read the same view; a `<-1>` spawn is nobody's obligation from the row, not from process memory.
import test from "node:test";
import assert from "node:assert/strict";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";

test("{§worker-obligations}: open non-detached streams and live children are obligations; detached streams and settled children are not", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `obligations-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "parent");
        const held = async (): Promise<{ streams: number; workers: number }> =>
            (await db.worker_live_obligations.get<{ streams: number; workers: number }>({ worker_id: workerId }))!;
        assert.deepEqual(await held(), { streams: 0, workers: 0 }, "a fresh worker holds nothing");

        const first = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/1/sh", channel: "stdout", content: "", state: "active" });
        const detached = await db.test_open_subscription_detached.get<{ id: number }>({ worker_id: workerId, entry_id: first, detached: 1 });
        assert.ok(detached);
        assert.deepEqual(await held(), { streams: 0, workers: 0 }, "a `<-1>` stream outlives the loop and is nobody's obligation");
        const second = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/2/sh", channel: "stdout", content: "", state: "active" });
        const attached = await db.test_open_subscription_detached.get<{ id: number }>({ worker_id: workerId, entry_id: second, detached: 0 });
        assert.ok(attached);
        assert.deepEqual(await held(), { streams: 1, workers: 0 }, "an open attached stream is an obligation");
        await db.test_close_subscription.run({ id: attached.id });
        assert.deepEqual(await held(), { streams: 0, workers: 0 }, "a settled stream is not");

        const childId = await insertWorker(db, workspaceId, workerId, "child");
        const childLoop = await insertLoop(db, childId, 1, "work");
        assert.deepEqual(await held(), { streams: 0, workers: 1 }, "a child with an unresolved loop is an obligation");
        await db.test_set_loop_status.run({ id: childLoop, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
        assert.deepEqual(await held(), { streams: 0, workers: 0 }, "a concluded child is not");
    } finally { await db.close(); }
});
