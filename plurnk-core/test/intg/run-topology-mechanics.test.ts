// Core run-topology mechanics at the integration level — fork IDENTITY and the premature-terminate
// LIVENESS contract. These are the seams the fanout demo broke on (forks colliding on one name, forks
// inheriting a frozen-live loop, the 409 gate disagreeing with the Child Runs orientation). Guarded
// here so they can't reach a real-model tier half-baked again.

import test from "node:test";
import assert from "node:assert/strict";
import Fork from "../../src/core/fork.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const TERMINAL = new Set([200, 413, 429, 499, 500, 508]);

test("[§worker-scheme-fork] N self-forks of one parent get UNIQUE, individually-addressable names", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-uniq-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "worker");
        await insertLoop(db, parent, 1, "go");
        const f1 = await Fork.fork(db, parent);
        const f2 = await Fork.fork(db, parent);
        const f3 = await Fork.fork(db, parent);
        const nameOf = async (id: number): Promise<string | undefined> => (await (db.fork_get_worker as PrepMethod).get<{ name: string }>({ id }))?.name;
        const [n1, n2, n3] = [await nameOf(f1), await nameOf(f2), await nameOf(f3)];
        assert.deepEqual([n1, n2, n3], ["worker-fork-1", "worker-fork-2", "worker-fork-3"], "each fork gets a unique -fork-<N>");
        assert.equal(new Set([n1, n2, n3]).size, 3, "no two forks collide on a single name");
        // The bug: a single `worker-fork` would have worker_resolve_by_name resolve to the newest for ALL three,
        // so KILL/SEND/READ could only ever reach one. Each unique name must address its OWN fork.
        for (const [n, id] of [[n1, f1], [n2, f2], [n3, f3]] as const) {
            const r = await (db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: n });
            assert.equal(r?.id, id, `worker://${n} addresses its own fork`);
        }
    } finally { await db.close(); }
});

test("[§worker-scheme-fork] a fork inherits the parent's loops as HISTORY (clamped terminal), never frozen-live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-clamp-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "p");
        await insertLoop(db, parent, 1, "live"); // the parent's current loop — non-terminal (forking mid-flight)
        const fork = await Fork.fork(db, parent);
        const loops = await (db.fork_get_loops as PrepMethod).all<{ status: number }>({ worker_id: fork });
        assert.ok(loops.length > 0, "the fork inherited the parent's loop");
        assert.ok(loops.every((l) => TERMINAL.has(l.status)), `inherited loops are terminal history, not frozen-live (got [${loops.map((l) => l.status)}])`);
    } finally { await db.close(); }
});

test("[§child-orientation] the 409 liveness gate and the Child Runs orientation AGREE — never refused for an invisible child", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `gate-orient-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId);
        const gate = async (): Promise<boolean> => (await (db.engine_worker_has_live_child as PrepMethod).get<{ live: number }>({ worker_id: parent })) !== undefined;
        const orientCount = async (): Promise<number> => (await (db.engine_child_workers_live as PrepMethod).all<{ name: string }>({ worker_id: parent })).length;

        // No children → both clear.
        assert.equal(await gate(), false, "no child: gate clear");
        assert.equal(await orientCount(), 0, "no child: orientation empty");

        // A child whose LATEST loop is live → gate refuses AND the orientation shows exactly it.
        const child = await insertWorker(db, workspaceId, parent);
        await insertLoop(db, child, 1, "inherited"); // seq 1 — stays non-terminal (the frozen inherited loop)
        assert.equal(await gate(), true, "live child: gate refuses termination");
        assert.equal(await orientCount(), 1, "live child: orientation shows it — the model can SEE what to KILL");

        // The fanout regression: a LATER loop is the child's own work and it concludes — while seq 1
        // remains a non-terminal inherited loop. The any-loop gate used to refuse here (it saw seq 1 @ 102)
        // while the orientation showed nothing (latest loop terminal) — refused for an invisible child →
        // strike-out. The latest-loop gate now matches the orientation: both clear, in lockstep.
        const ownLatest = await insertLoop(db, child, 2, "own work"); // seq 2 — the actual work loop
        await (db.test_set_loop_status as PrepMethod).run({ id: ownLatest, status: 200 }); // it concluded
        assert.equal(await gate(), false, "concluded child: gate clears (the inherited seq-1 @ 102 is not the latest loop)");
        assert.equal(await orientCount(), 0, "concluded child: orientation empty too — gate and orientation never contradict");
    } finally { await db.close(); }
});
