// Core worker-topology mechanics at the integration level — fork IDENTITY and the premature-terminate
// LIVENESS contract. These are the seams the fanout demo broke on (forks colliding on one name, forks
// inheriting a frozen-live loop, the 409 gate disagreeing with the Active Child Workers orientation). Guarded
// here so they can't reach a real-model tier half-baked again.

import test from "node:test";
import assert from "node:assert/strict";
import { WORKER_NAME } from "@plurnk/plurnk-contracts";
import Fork from "../../src/core/fork.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const TERMINAL = new Set([200, 413, 429, 499, 500, 508]);

test("N self-forks of one parent get UNIQUE, individually-addressable names", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-uniq-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "worker");
        await insertLoop(db, parent, 1, "go");
        const f1 = await Fork.fork(db, parent, undefined, () => "none");
        const f2 = await Fork.fork(db, parent, undefined, () => "none");
        const f3 = await Fork.fork(db, parent, undefined, () => "none");
        const nameOf = async (id: number): Promise<string | undefined> => (await db.fork_get_worker.get<{ name: string }>({ id }))?.name;
        const [n1, n2, n3] = [await nameOf(f1), await nameOf(f2), await nameOf(f3)];
        assert.deepEqual([n1, n2, n3], ["worker-fork-1", "worker-fork-2", "worker-fork-3"], "each fork gets a unique -fork-<N>");
        assert.equal(new Set([n1, n2, n3]).size, 3, "no two forks collide on a single name");
        // The bug: a single `worker-fork` would have worker_resolve_by_name resolve to the newest for ALL three,
        // so KILL/SEND/READ could only ever reach one. Each unique name must address its OWN fork.
        for (const [n, id] of [[n1, f1], [n2, f2], [n3, f3]] as const) {
            const r = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: n });
            assert.equal(r?.id, id, `worker://${n} addresses its own fork`);
        }
    } finally { await db.close(); }
});

test("{§worker-auto-name} #159: concurrent unnamed forks atomically claim distinct ordinals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-concurrent-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "worker");
        const forks = await Promise.all(Array.from({ length: 8 }, () => Fork.fork(db, parent, undefined, () => "none")));
        const names = await Promise.all(forks.map(async (id) =>
            (await db.fork_get_worker.get<{ name: string }>({ id }))?.name ?? ""));

        assert.equal(new Set(names).size, forks.length, "every concurrent fork remains individually addressable");
        assert.deepEqual(names.toSorted(), Array.from({ length: 8 }, (_, i) => `worker-fork-${i + 1}`).toSorted());
    } finally { await db.close(); }
});

test("an automatic fork of a maximum-length parent remains a mintable worker name", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-name-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "a".repeat(63));
        const fork = await Fork.fork(db, parent, undefined, () => "none");
        const name = (await db.fork_get_worker.get<{ name: string }>({ id: fork }))?.name ?? "";

        assert.ok(WORKER_NAME.test(name), "the generated name satisfies the contracts-owned minting predicate");
        assert.equal(name.length, 63, "only the inherited parent portion is shortened");
        assert.match(name, /-fork-1$/, "the stable fork ordinal remains visible");
    } finally { await db.close(); }
});

test("a fork inherits the parent's loops as HISTORY (clamped terminal), never frozen-live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-clamp-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "p");
        await insertLoop(db, parent, 1, "live"); // the parent's current loop — non-terminal (forking mid-flight)
        const fork = await Fork.fork(db, parent, undefined, () => "none");
        const loops = await db.fork_get_loops.all<{ status: number }>({ worker_id: fork });
        assert.ok(loops.length > 0, "the fork inherited the parent's loop");
        assert.ok(loops.every((l) => TERMINAL.has(l.status)), `inherited loops are terminal history, not frozen-live (got [${loops.map((l) => l.status)}])`);
    } finally { await db.close(); }
});

test("the completion gate and child orientation use the same any-unresolved-loop liveness law", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `gate-orient-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId);
        const gate = async (): Promise<boolean> => (await db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: parent })) !== undefined;
        const orientCount = async (): Promise<number> => (await db.engine_child_workers_live.all<{ name: string }>({ worker_id: parent })).length;

        // No children → both clear.
        assert.equal(await gate(), false, "no child: gate clear");
        assert.equal(await orientCount(), 0, "no child: orientation empty");

        // A child with one unresolved loop is live in both projections.
        const child = await insertWorker(db, workspaceId, parent);
        const unresolved = await insertLoop(db, child, 1, "unresolved");
        assert.equal(await gate(), true, "live child: gate refuses termination");
        assert.equal(await orientCount(), 1, "live child: orientation shows it — the model can SEE what to KILL");

        // Newer terminal history cannot hide the older unresolved obligation.
        const ownLatest = await insertLoop(db, child, 2, "newer terminal work");
        await db.test_set_loop_status.run({
            id: ownLatest,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        assert.equal(await gate(), true, "the unresolved loop remains completion-blocking");
        assert.equal(await orientCount(), 1, "orientation shows the same live child");

        await db.test_set_loop_status.run({
            id: unresolved,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        assert.equal(await gate(), false, "the gate clears after every loop is terminal");
        assert.equal(await orientCount(), 0, "orientation clears at the same boundary");
    } finally { await db.close(); }
});
