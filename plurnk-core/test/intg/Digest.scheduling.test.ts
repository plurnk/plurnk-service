import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Digest from "../../src/digest/Digest.ts";
import { insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§digest-forensic-fidelity}: scheduled timing remains inspectable without private SQL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-schedule-"));
    const dbPath = join(dir, "plurnk.db");
    const db = await openMigrated(dbPath);
    const due = Date.parse("2026-09-16T01:26:57.000Z");
    let loopId: number;
    try {
        const workspaceId = await insertWorkspace(db, "schedule");
        const workerId = await insertWorker(db, workspaceId, null, "scheduler");
        const loop = await db.drain_enqueue_loop.get<{ id: number }>({
            worker_id: workerId, prompt: "Heartbeat", prompt_source: null,
            model_route_id: null, spawn_model_route_id: null, reasoning_policy: null,
            max_turns: 2, policy: "{}", open_paths: "[]", scheduled_at: due, repeat_interval_ms: 3_600_000,
        });
        assert.ok(loop);
        loopId = loop.id;
    } finally { await db.close(); }
    try {
        const digestDir = join(dir, "digest");
        Digest.run({ dbPath, digestDir });
        const { loops } = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(loops[0].id, loopId);
        assert.equal(loops[0].scheduled_at, due);
        assert.equal(loops[0].repeat_interval_ms, 3_600_000);
        assert.equal(loops[0].recurrence_root_loop_id, null);
        assert.equal(loops[0].terminated_at, null);
        assert.match(await readFile(join(digestDir, "digest.md"), "utf8"), /Schedule: 2026-09-16T01:26:57.000Z · every 60 min/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
