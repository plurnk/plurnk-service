// Engine.inject — direct surface tests. Deterministic state setup; no
// daemon, no Mock provider timing races. Verifies the inject mechanics:
// appends ordered rows to the loop's inbox ({§message-loop-containment})
// and returns null when no loop is active.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

test("{§message-loop-containment} concurrent injections keep arrival order across a new Engine", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ordered-messages");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "initial");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await Promise.all([engine.injectIntoLoop(loopId, "first"), engine.injectIntoLoop(loopId, "second")]);
        await new Engine({ db, schemes: new SchemeRegistry() }).injectIntoLoop(loopId, "third");
        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
        assert.deepEqual(inbox.map(({ body }) => body), ["initial", "first", "second", "third"], "the loop's assignment first, then arrivals in order");
        assert.deepEqual(inbox.map(({ ordinal }) => ordinal), [1, 2, 3, 4], "ordinals are durable across engines");
        assert.ok(inbox.every(({ log_entry_id }) => log_entry_id === null), "nothing is published before a turn boundary");
    } finally { await db.close(); }
});

test("engine.inject: persists a message with its ordinal, open paths, and causal source", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "initial prompt");
        // Loop starts at status=102 (insertLoop default). Insert a turn
        // 1 placeholder so engine.inject's next-turn query returns 2 —
        // matches the realistic mid-loop state.
        await insertTurn(db, loopId, 1, 102);

        const result = await engine.injectIntoLoop(
            loopId,
            "follow-up",
            ["src/context.ts", "README.md"],
            "worker://researcher",
        );
        assert.ok(result, "engine.inject returned a result");
        assert.equal(result.loopId, loopId);
        assert.equal(result.turnSeq, 2, "the LANDING turn is 2 (turn 1 already exists) — delivery timing, not the key");

        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; source: string | null; open_paths: string; log_entry_id: number | null }>;
        assert.equal(inbox.length, 2, "the assignment and the arrival");
        const [, message] = inbox;
        assert.deepEqual(
            { ordinal: message!.ordinal, body: message!.body, source: message!.source, openPaths: JSON.parse(message!.open_paths), published: message!.log_entry_id },
            { ordinal: 2, body: "follow-up", source: "worker://researcher", openPaths: ["src/context.ts", "README.md"], published: null },
            "the message durably owns its selected workspace paths and causal source ({§message-causal-source})",
        );
    } finally { await db.close(); }
});

test("concurrent injects are contained as distinct ordered messages with their own paths", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-containment");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "initial");
        await insertTurn(db, loopId, 1, 102);

        const [r1, r2] = await Promise.all([
            engine.injectIntoLoop(loopId, "first follow-up", ["first.ts"]),
            engine.injectIntoLoop(loopId, "second follow-up", ["second.ts"]),
        ]);
        assert.ok(r1 && r2, "both injects landed in the ACTIVE loop — no new loop while one is live");

        const rows = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ id: number; ordinal: number; body: string; open_paths: string }>;
        assert.deepEqual(rows.map(({ ordinal, body, open_paths }) => ({ ordinal, body, openPaths: JSON.parse(open_paths) })), [
            { ordinal: 1, body: "initial", openPaths: [] },
            { ordinal: 2, body: "first follow-up", openPaths: ["first.ts"] },
            { ordinal: 3, body: "second follow-up", openPaths: ["second.ts"] },
        ], "the earlier message is CONTAINED, never superseded");
        assert.equal(new Set(rows.map(({ id }) => id)).size, 3, "concurrent messages remain independent rows");

        const restarted = new Engine({ db, schemes: new SchemeRegistry() });
        await restarted.injectIntoLoop(loopId, "after restart", ["third.ts"]);
        const after = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; open_paths: string }>;
        assert.deepEqual(after.at(-1), { ...after.at(-1), ordinal: 4, body: "after restart", open_paths: JSON.stringify(["third.ts"]) }, "a new engine continues after the durable historical ordinals");
    } finally { await db.close(); }
});

test("engine.inject: returns null when no loop is currently active (status=102)", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-no-active");
        const workerId = await insertWorker(db, workspaceId);
        // No loops at all in this worker.
        const result = await engine.injectIntoLoop(999_999, "orphan prompt");
        assert.equal(result, null, "no active loop → null (caller falls back to enqueue path)");

        // Also returns null when a loop exists but it's terminal.
        const closedLoop = await insertLoop(db, workerId, 1, "done");
        await db.test_set_loop_status.run({
            id: closedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        const result2 = await engine.injectIntoLoop(closedLoop, "still orphan");
        assert.equal(result2, null, "loop at status=200 doesn't count as active");
    } finally { await db.close(); }
});
