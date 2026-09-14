// SPEC {§module-workspace-state} — a family declares whether its definitions belong to the
// workspace or to a worker, and the coordinator keys state by that scope. `env` is the first
// worker-scoped family: an environment is context (how this worker works) rather than capability
// (what exists in this workspace).
//
// A sibling table rather than a nullable column, so the foreign key is real. These witnesses
// cover the two properties that choice buys: isolation between workers, and a cascade that takes
// a worker's definitions with it.

import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace, insertWorker } from "./_helpers.ts";

const OWNER = "@plurnk/plurnk-service";

test("{§module-workspace-state} worker state is per worker, not shared across siblings", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `worker-state-${crypto.randomUUID()}`);
        const one = await insertWorker(db, workspaceId);
        const two = await insertWorker(db, workspaceId);

        await db.worker_module_state_put.run({
            worker_id: one, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { CARGO_TARGET_DIR: { origin: "worker", enabled: true } } }),
        });

        const mine = await db.worker_module_state_get.get<{ state: string }>({ worker_id: one, namespace_owner: OWNER });
        const sibling = await db.worker_module_state_get.get<{ state: string }>({ worker_id: two, namespace_owner: OWNER });
        assert.match(mine!.state, /CARGO_TARGET_DIR/u);
        assert.equal(sibling, undefined, "a sibling worker sees nothing of it — this is the whole reason for the scope");
    } finally { await db.close(); }
});

test("{§module-workspace-state} a worker's definitions die with the worker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `worker-state-cascade-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await db.worker_module_state_put.run({
            worker_id: workerId, namespace_owner: OWNER, state: JSON.stringify({ version: 1, definitions: {} }),
        });

        await db.test_delete_worker.run({ id: workerId });

        const orphan = await db.worker_module_state_get.get<{ state: string }>({ worker_id: workerId, namespace_owner: OWNER });
        assert.equal(orphan, undefined, "the real foreign key cascades; a nullable column on the workspace table would have orphaned it");
    } finally { await db.close(); }
});

test("{§module-workspace-state} put replaces in place, keyed by (worker, owner)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `worker-state-replace-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const key = { worker_id: workerId, namespace_owner: OWNER };
        await db.worker_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { A: {} } }) });
        await db.worker_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { B: {} } }) });

        const row = await db.worker_module_state_get.get<{ state: string }>(key);
        assert.match(row!.state, /"B"/u);
        assert.doesNotMatch(row!.state, /"A"/u, "one snapshot per (worker, owner), replaced whole");
    } finally { await db.close(); }
});

// {§functionality-scope} — inheritance is a row copy at the child's creation, marked with its source.
const definitionsOf = async (db: Awaited<ReturnType<typeof openMigrated>>, workerId: number): Promise<Record<string, Record<string, unknown>>> => {
    const row = await db.worker_module_state_get.get<{ state: string }>({ worker_id: workerId, namespace_owner: OWNER });
    return row === undefined ? {} : (JSON.parse(row.state) as { definitions: Record<string, Record<string, unknown>> }).definitions;
};

test("{§functionality-scope} a child starts with a copy of its parent's state, every entry named for its source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `worker-state-inherit-${crypto.randomUUID()}`);
        const alice = await insertWorker(db, workspaceId, null, "alice");
        await db.worker_module_state_put.run({
            worker_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: {
                CARGO_TARGET_DIR: { origin: "worker", enabled: true, definition: { value: "/tmp/shared" } },
                CI: { origin: "service", enabled: false },
            } }),
        });
        const bob = await insertWorker(db, workspaceId, alice, "bob");
        assert.deepEqual(await definitionsOf(db, bob), {
            CARGO_TARGET_DIR: { origin: "worker", enabled: true, definition: { value: "/tmp/shared" }, inherited: "alice" },
            CI: { origin: "service", enabled: false, inherited: "alice" },
        }, "copied faithfully, disabled entries included, each named for the Worker that set it");

        // A snapshot, not a link: alice's later edit never reaches bob.
        await db.worker_module_state_put.run({
            worker_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { LATER: { origin: "worker", enabled: true, definition: { value: "x" } } } }),
        });
        assert.deepEqual(Object.keys(await definitionsOf(db, bob)), ["CARGO_TARGET_DIR", "CI"]);

        // Depth is transitive and provenance names the origin, not the intermediate.
        const carol = await insertWorker(db, workspaceId, bob, "carol");
        assert.equal((await definitionsOf(db, carol)).CARGO_TARGET_DIR!.inherited, "alice", "a grandchild still names the Worker that set the entry");

        // A parentless Worker inherits nothing.
        const loner = await insertWorker(db, workspaceId, null, "loner");
        assert.deepEqual(await definitionsOf(db, loner), {});
    } finally { await db.close(); }
});
