// Engine.inject — direct surface tests. Deterministic state setup; no
// daemon, no Mock provider timing races. Verifies the inject mechanics:
// writes distinct prompt://<worker>/<loop>/<id> frames
// ({§prompt-address}) and returns null when no loop is active.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

test("{§prompt-address} prompt IDs are opaque while concurrent delivery order survives a new Engine", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "opaque-prompts");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "initial");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await Promise.all([engine.injectIntoLoop(loopId, "first"), engine.injectIntoLoop(loopId, "second")]);
        await new Engine({ db, schemes: new SchemeRegistry() }).injectIntoLoop(loopId, "third");
        const frames = await db.drain_undelivered_prompts_for_loop.all<{ pathname: string; content: string; attributes: string }>({
            worker_id: workerId, loop_id: loopId, pattern: "/1/%", prefix_len: 3,
        });
        assert.deepEqual(frames.map(({ content }) => content), ["first", "second", "third"]);
        assert.equal(new Set(frames.map(({ pathname }) => pathname)).size, 3);
        for (const [index, frame] of frames.entries()) {
            assert.match(frame.pathname, /^\/1\/[a-f0-9]{8}$/u);
            assert.equal(JSON.parse(frame.attributes).ordinal, index + 2, "initial prompt reserves ordinal 1 before its materialization");
        }
    } finally { await db.close(); }
});

test("engine.inject: persists an addressed prompt with its ordinal, open paths, and causal source", async () => {
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

        const [frame] = await db.test_prompt_paths_by_worker.all<{ pathname: string }>({ worker_id: workerId });
        assert.match(frame!.pathname, /^\/1\/[a-f0-9]{8}$/u);
        const entry = await db.test_get_entry_by_path.get<{ id: number; attributes: string }>({
            workspace_id: workspaceId, scheme: "prompt", pathname: frame!.pathname,
        });
        assert.ok(entry, "the published prompt identity is addressable");
        assert.deepEqual(JSON.parse(entry.attributes), {
            ordinal: 2,
            openPaths: ["src/context.ts", "README.md"],
            source: "worker://researcher",
        }, "the prompt frame durably owns its selected workspace paths and causal source");
        const body = await db.test_get_channel.get<{ content: string }>({
            entry_id: entry.id, name: "body",
        });
        assert.equal(body?.content, "follow-up");
    } finally { await db.close(); }
});

test("concurrent injects are contained as distinct ordered frames with their own attributes", async () => {
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

        const frames = await db.test_prompt_paths_by_worker.all<{ pathname: string }>({ worker_id: workerId });
        const f1 = await db.test_get_entry_by_path.get<{ id: number; attributes: string }>({ workspace_id: workspaceId, scheme: "prompt", pathname: frames[0]!.pathname });
        const f2 = await db.test_get_entry_by_path.get<{ id: number; attributes: string }>({ workspace_id: workspaceId, scheme: "prompt", pathname: frames[1]!.pathname });
        assert.ok(f1 && f2);
        assert.notEqual(f1.id, f2.id, "concurrent prompts remain independent resources");
        const b1 = await db.test_get_channel.get<{ content: string }>({ entry_id: f1!.id, name: "body" });
        const b2 = await db.test_get_channel.get<{ content: string }>({ entry_id: f2!.id, name: "body" });
        assert.equal(b1?.content, "first follow-up", "the earlier prompt is CONTAINED, never superseded");
        assert.equal(b2?.content, "second follow-up");
        assert.deepEqual(JSON.parse(f1.attributes), { ordinal: 2, openPaths: ["first.ts"] });
        assert.deepEqual(JSON.parse(f2.attributes), { ordinal: 3, openPaths: ["second.ts"] });

        const restarted = new Engine({ db, schemes: new SchemeRegistry() });
        await restarted.injectIntoLoop(loopId, "after restart", ["third.ts"]);
        const after = await db.test_prompt_paths_by_worker.all<{ pathname: string }>({ worker_id: workerId });
        const f3 = await db.test_get_entry_by_path.get<{ id: number; attributes: string }>({ workspace_id: workspaceId, scheme: "prompt", pathname: after[2]!.pathname });
        assert.ok(f3, "a new engine continues after the durable historical ordinals");
        assert.deepEqual(JSON.parse(f3.attributes), { ordinal: 4, openPaths: ["third.ts"] });
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
