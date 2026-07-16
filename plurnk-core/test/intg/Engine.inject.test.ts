// Engine.inject — direct surface tests. Deterministic state setup; no
// daemon, no Mock provider timing races. Verifies the rummy-parallel
// inject mechanics: writes plurnk://prompt/<run>/<loop>/<next-turn>, last-wins
// per turn slot, returns null when no loop is currently active.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

test("engine.inject: writes prompt entry at plurnk://prompt/<run>/<loop>/<next-turn>", async () => {
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
        assert.equal(result.turnSeq, 2, "next-turn slot is 2 (turn 1 already exists)");

        // Verify the entry was actually written with the right body.
        const entry = await (db.test_get_entry_by_path as PrepMethod).get<{ id: number }>({
            workspace_id: workspaceId, scheme: "plurnk", pathname: `/prompt/${workerId}/1/2`,
        });
        assert.ok(entry, "prompt entry exists at plurnk://prompt/<run>/<loop>/2");
        const body = await (db.test_get_channel as PrepMethod).get<{ content: string }>({
            entry_id: entry.id, name: "body",
        });
        assert.equal(body?.content, "follow-up");
    } finally { await db.close(); }
});

test("engine.inject: last-wins — two injects targeting the same slot collapse", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-lastwins");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "initial");
        await insertTurn(db, loopId, 1, 102);

        const r1 = await engine.inject(workerId, "first follow-up");
        const r2 = await engine.inject(workerId, "second follow-up");
        assert.equal(r1?.turnSeq, 2);
        assert.equal(r2?.turnSeq, 2, "both target slot 2 (no turn 2 opened yet)");

        const entry = await (db.test_get_entry_by_path as PrepMethod).get<{ id: number }>({
            workspace_id: workspaceId, scheme: "plurnk", pathname: `/prompt/${workerId}/1/2`,
        });
        const body = await (db.test_get_channel as PrepMethod).get<{ content: string }>({
            entry_id: entry!.id, name: "body",
        });
        assert.equal(body?.content, "second follow-up", "last write wins");
    } finally { await db.close(); }
});

test("engine.inject: returns null when no loop is currently active (status=102)", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-no-active");
        const workerId = await insertWorker(db, workspaceId);
        // No loops at all in this run.
        const result = await engine.inject(workerId, "orphan prompt");
        assert.equal(result, null, "no active loop → null (caller falls back to enqueue path)");

        // Also returns null when a loop exists but it's terminal.
        const closedLoop = await insertLoop(db, workerId, 1, "done");
        await (db.test_set_loop_status as PrepMethod).run({ id: closedLoop, status: 200 });
        const result2 = await engine.inject(workerId, "still orphan");
        assert.equal(result2, null, "loop at status=200 doesn't count as active");
    } finally { await db.close(); }
});

test("engine.inject: per-turn foist reads latest prompt body into packet.user.prompt", async () => {
    // The drain_get_latest_prompt_body_for_loop SQL slot is what feeds
    // packet.user.prompt at packet-build time. Inject writes a new entry;
    // the next packet build picks up its content.
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-foist");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "initial");
        await insertTurn(db, loopId, 1, 102);

        await engine.inject(workerId, "the new prompt the model should see");

        // Read the latest prompt body (what #buildRequestPacket would see).
        const row = await (db.drain_get_latest_prompt_body_for_loop as PrepMethod).get<{ content: string }>({
            pattern: `/prompt/${workerId}/1/%`,
        });
        assert.equal(row?.content, "the new prompt the model should see");
    } finally { await db.close(); }
});
