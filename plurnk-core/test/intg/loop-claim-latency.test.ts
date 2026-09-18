// {§loop-claim-latency} — a loop's first claim is a durable fact, so wake-to-first-turn latency is measurable (#703).
import test from "node:test";
import assert from "node:assert/strict";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§loop-claim-latency}: a queued loop is stamped when first claimed; a running insert at insertion; later claims never move it", async () => {
    const db = await openMigrated();
    try {
        const workerId = await insertWorker(db, await insertWorkspace(db, `claim-${crypto.randomUUID()}`));
        const claimed = async (id: number) => (await db.test_get_loop_claimed_at.get<{ claimed_at: string | null }>({ id }))?.claimed_at ?? null;

        const queued = (await db.test_insert_queued_loop.get<{ id: number }>({ worker_id: workerId, sequence: 1, prompt: "later" }))!.id;
        assert.equal(await claimed(queued), null, "a queued loop has not been claimed");
        await db.test_set_loop_status.run({ id: queued, status: 102, terminal_result: null });
        const first = await claimed(queued);
        assert.match(String(first), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/u);
        await db.test_set_loop_status.run({ id: queued, status: 100, terminal_result: null });
        await db.test_set_loop_status.run({ id: queued, status: 102, terminal_result: null });
        assert.equal(await claimed(queued), first, "a re-claim keeps the first claim");

        const running = await insertLoop(db, workerId, 2, "now");
        assert.notEqual(await claimed(running), null, "a loop inserted running is claimed at insertion");
    } finally { await db.close(); }
});
