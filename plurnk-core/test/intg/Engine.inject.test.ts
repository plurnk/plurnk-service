// Engine.inject — direct surface tests. Deterministic state setup; no
// daemon, no Mock provider timing races. Verifies the rummy-parallel
// inject mechanics: writes distinct prompt:///<loop>/<N> frames owner-keyed
// ({§prompt-self-only}) and returns null when no loop is active.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

test("engine.inject: writes the loop's next prompt FRAME (prompt:///<loop>/<N>, the per-loop ordinal), owner-keyed", async () => {
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

        const result = await engine.inject(workerId, "follow-up");
        assert.ok(result, "engine.inject returned a result");
        assert.equal(result.loopId, loopId);
        assert.equal(result.turnSeq, 2, "the LANDING turn is 2 (turn 1 already exists) — delivery timing, not the key");

        // The frame keys on the per-loop ORDINAL ({§prompt-loop-containment}): this fixture holds
        // no prior frames, so the inject is frame 1 — /1/1 — regardless of the landing turn.
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "prompt", pathname: "/1/1",
        });
        assert.ok(entry, "prompt frame exists at prompt:///1/1, owned by the worker");
        const body = await db.test_get_channel.get<{ content: string }>({
            entry_id: entry.id, name: "body",
        });
        assert.equal(body?.content, "follow-up");
    } finally { await db.close(); }
});

test("rapid injects are BOTH contained — distinct frames, nothing superseded (owner: a loop holds every prompt sent before it concludes)", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-containment");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "initial");
        await insertTurn(db, loopId, 1, 102);

        const r1 = await engine.inject(workerId, "first follow-up");
        const r2 = await engine.inject(workerId, "second follow-up");
        assert.ok(r1 && r2, "both injects landed in the ACTIVE loop — no new loop while one is live");

        const f1 = await db.test_get_entry_by_path.get<{ id: number }>({ workspace_id: workspaceId, scheme: "prompt", pathname: "/1/1" });
        const f2 = await db.test_get_entry_by_path.get<{ id: number }>({ workspace_id: workspaceId, scheme: "prompt", pathname: "/1/2" });
        assert.ok(f1 && f2, "two frames at consecutive ordinals — the ordinal key cannot collide");
        const b1 = await db.test_get_channel.get<{ content: string }>({ entry_id: f1!.id, name: "body" });
        const b2 = await db.test_get_channel.get<{ content: string }>({ entry_id: f2!.id, name: "body" });
        assert.equal(b1?.content, "first follow-up", "the earlier prompt is CONTAINED, never superseded");
        assert.equal(b2?.content, "second follow-up");
    } finally { await db.close(); }
});

test("engine.inject: returns null when no loop is currently active (status=102)", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-no-active");
        const workerId = await insertWorker(db, workspaceId);
        // No loops at all in this worker.
        const result = await engine.inject(workerId, "orphan prompt");
        assert.equal(result, null, "no active loop → null (caller falls back to enqueue path)");

        // Also returns null when a loop exists but it's terminal.
        const closedLoop = await insertLoop(db, workerId, 1, "done");
        await db.test_set_loop_status.run({
            id: closedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        const result2 = await engine.inject(workerId, "still orphan");
        assert.equal(result2, null, "loop at status=200 doesn't count as active");
    } finally { await db.close(); }
});
