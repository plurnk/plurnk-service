// {§session-obligations} — what a session still holds is one durable row: an open stream that is not
// detached, or a child with an unresolved loop. The completion gate, the wait matrix, and the drain
// read the same view; a detached spawn is nobody's obligation from the row, not from process memory.
import test from "node:test";
import assert from "node:assert/strict";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";

test("{§session-obligations}: open non-detached streams and live children are obligations; detached streams and settled children are not", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `obligations-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "parent");
        const held = async (): Promise<{ streams: number; sessions: number }> =>
            (await db.session_live_obligations.get<{ streams: number; sessions: number }>({ session_id: sessionId }))!;
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a fresh session holds nothing");

        const first = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/1/sh", channel: "stdout", content: "", state: "active" });
        const detached = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: first, detached: 1 });
        assert.ok(detached);
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a detached stream outlives the loop and is nobody's obligation");
        const second = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/2/sh", channel: "stdout", content: "", state: "active" });
        const attached = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: second, detached: 0 });
        assert.ok(attached);
        assert.deepEqual(await held(), { streams: 1, sessions: 0 }, "an open attached stream is an obligation");
        await db.test_close_subscription.run({ id: attached.id });
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a settled stream is not");

        const childId = await insertSession(db, workspaceId, sessionId, "child");
        const childLoop = await insertLoop(db, childId, 1, "work");
        assert.deepEqual(await held(), { streams: 0, sessions: 1 }, "a child with an unresolved loop is an obligation");
        await db.test_set_loop_status.run({ id: childLoop, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a concluded child is not");
    } finally { await db.close(); }
});
