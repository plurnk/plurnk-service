// #521 — the query GATE that routes a parked exec to backoff vs blind: a NULL min-poll is ambiguous
// (no stream, or a live stream with no explicit `<,P>`). drain_worker_open_stream_count disambiguates
// — count>0 + null min = the backoff case; count 0 = nothing to poll.
import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, seedEntryWithChannel } from "./_helpers.ts";

test("[§exec-poll] an OPEN unpolled exec stream reads as count>0 + null min-poll — the backoff case, not blind", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `poll-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/1", channel: "stdout", content: "" });
        // A live exec stream with NO explicit <,P> (poll_seconds NULL).
        await (db.test_insert_open_subscription as PrepMethod).run({ worker_id: workerId, entry_id: entryId, poll_seconds: null });

        const minPoll = await (db.drain_worker_min_poll as PrepMethod).get<{ poll_seconds: number | null }>({ worker_id: workerId });
        assert.equal(minPoll?.poll_seconds ?? null, null, "no explicit cadence → null min-poll (ambiguous alone)");
        const count = await (db.drain_worker_open_stream_count as PrepMethod).get<{ n: number }>({ worker_id: workerId });
        assert.equal(count?.n, 1, "one OPEN stream → count>0: the backoff applies, not a blind park");
    } finally { await db.close(); }
});

test("[§exec-poll] no open stream → count 0: nothing to poll (a child-join park is woken by its terminal)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `poll-none-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const count = await (db.drain_worker_open_stream_count as PrepMethod).get<{ n: number }>({ worker_id: workerId });
        assert.equal(count?.n, 0, "no subscription → count 0 → the backoff never fires");
    } finally { await db.close(); }
});
