import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace } from "./_helpers.ts";
import Envelope from "../../src/server/envelope.ts";

let nameCounter = 0;
const n = (suffix: string): string => `run-${suffix}-${++nameCounter}`;

test("a client cannot create or resume a worker named 'plurnk' (runtime impersonation)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-reserved");
        await assert.rejects(() => Envelope.attachToWorkspace(db, workspaceId, { workerName: "plurnk" }), /reserved/, "forging a plurnk worker is refused");
        await assert.rejects(() => Envelope.attachToWorkspace(db, workspaceId, { workerName: "PLURNK" }), /reserved/, "case variants are refused too");
        const ok = await Envelope.attachToWorkspace(db, workspaceId, { workerName: "my-feature" });
        assert.equal(ok.workerName, "my-feature", "a normal worker name still resolves");
    } finally { await db.close(); }
});

test("runs: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_runs_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("runs: trunk run insert — null parent_worker_id, defaults populate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-trunk");
        await db.test_runs_insert.run({ workspace_id: workspaceId, name: n("trunk") });
        const row = await db.test_runs_get_by_session.get<{
            id: number; version: number; workspace_id: number; name: string; created_at: string;
            parent_worker_id: number | null; cost_usd: number;
        }>({ workspace_id: workspaceId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.workspace_id, workspaceId);
        assert.match(row?.name ?? "", /^run-trunk-\d+$/);
        assert.match(row?.created_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.parent_worker_id, null);
        assert.equal(row?.cost_usd, 0);
    } finally { await db.close(); }
});

test("runs: fork insert — non-null parent_worker_id pointing at trunk run", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-fork");
        const trunk = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("trunk") });
        const fork = await db.test_runs_insert_with_parent_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fork"), parent_worker_id: trunk?.id });
        const forkRow = await db.test_runs_get_parent.get<{ parent_worker_id: number }>({ id: fork?.id });
        assert.equal(forkRow?.parent_worker_id, trunk?.id);
    } finally { await db.close(); }
});

test("runs: workspace_id NOT NULL — insert without workspace_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_runs_insert_default_values(),
            /NOT NULL constraint failed: workers\.workspace_id/,
        );
    } finally { await db.close(); }
});

test("runs: workspace_id FK — insert against non-existent workspace rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_runs_insert.run({ workspace_id: 99999, name: n("fk-fail") }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: parent_worker_id FK — insert against non-existent parent rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-badparent");
        await assert.rejects(
            () => db.test_runs_insert_with_parent.run({ workspace_id: workspaceId, name: n("badparent"), parent_worker_id: 99999 }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: parent_worker_id self-reference CHECK — parent != id rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-self");
        const run = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("self") });
        await assert.rejects(
            () => db.test_runs_set_parent.run({ parent_worker_id: run?.id, id: run?.id }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: ON DELETE CASCADE via workspace — deleting workspace removes all its runs", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cascade");
        const otherWorkspaceId = await insertWorkspace(db, "ws-untouched");
        await db.test_runs_insert.run({ workspace_id: workspaceId, name: n("c1") });
        await db.test_runs_insert.run({ workspace_id: workspaceId, name: n("c2") });
        await db.test_runs_insert.run({ workspace_id: otherWorkspaceId, name: n("c3") });
        const before = await db.test_runs_count.get<{ n: number }>();
        assert.equal(before?.n, 3);
        await db.test_sessions_delete.run({ id: workspaceId });
        const after = await db.test_runs_count.get<{ n: number }>();
        assert.equal(after?.n, 1);
        const survivor = await db.test_runs_get_one_workspace_id.get<{ workspace_id: number }>();
        assert.equal(survivor?.workspace_id, otherWorkspaceId);
    } finally { await db.close(); }
});

test("runs: ON DELETE CASCADE via parent_worker_id — deleting a parent run removes its forks", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-forkcascade");
        const trunk = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fc-trunk") });
        const trunkId = trunk!.id;
        const forkA = await db.test_runs_insert_with_parent_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fc-fA"), parent_worker_id: trunkId });
        await db.test_runs_insert_with_parent.run({ workspace_id: workspaceId, name: n("fc-fB"), parent_worker_id: trunkId });
        await db.test_runs_insert_with_parent.run({ workspace_id: workspaceId, name: n("fc-fC"), parent_worker_id: forkA?.id });
        const before = await db.test_runs_count.get<{ n: number }>();
        assert.equal(before?.n, 4);
        await db.test_runs_delete.run({ id: trunkId });
        const after = await db.test_runs_count.get<{ n: number }>();
        assert.equal(after?.n, 0);
    } finally { await db.close(); }
});

test("runs: negative cost_usd rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-negcost");
        await assert.rejects(
            () => db.test_runs_insert_cost.run({ workspace_id: workspaceId, name: n("negcost"), cost_usd: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-negversion");
        await assert.rejects(
            () => db.test_runs_insert_version.run({ workspace_id: workspaceId, name: n("negversion"), version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: index workers_workspace_id_created_at exists", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_runs_index_exists.get<{ name: string }>({ name: "workers_workspace_id_created_at" });
        assert.equal(row?.name, "workers_workspace_id_created_at");
    } finally { await db.close(); }
});

test("runs: index workers_parent_worker_id exists", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_runs_index_exists.get<{ name: string }>({ name: "workers_parent_worker_id" });
        assert.equal(row?.name, "workers_parent_worker_id");
    } finally { await db.close(); }
});

test("runs: a name repeats within a workspace — reclamation across time, NOT store-unique ()", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-reclaim");
        const first = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        // The store PERMITS a second 'worker': a name is frozen per worker but reclaimable across time —
        // a terminated run keeps its name in permanent history while a fresh spawn reuses it. A LIVE
        // collision is refused at the spawn gate (Engine.#handleWorkerCopy → worker_live_by_name → 409), never by the
        // store. The dropped UNIQUE index returned a raw 500 the model couldn't read.
        const second = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.notEqual(first?.id, second?.id, "two distinct runs can hold the same name");
        // Resolution is newest-wins — the live/fresh run, never the corpse.
        const resolved = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.equal(resolved?.id, second?.id, "worker_resolve_by_name resolves the newest holder");
    } finally { await db.close(); }
});

test("runs: index workers_workspace_name exists (plain — the by-name resolve/spawn lookup, not a uniqueness constraint)", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_runs_index_exists.get<{ name: string }>({ name: "workers_workspace_name" });
        assert.equal(row?.name, "workers_workspace_name");
    } finally { await db.close(); }
});

test("runs: id auto-assigns on insert", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-autoid");
        await db.test_runs_insert.run({ workspace_id: workspaceId, name: n("auto-a") });
        await db.test_runs_insert.run({ workspace_id: workspaceId, name: n("auto-b") });
        const rows = await db.test_runs_list_by_session.all<{ id: number }>({ workspace_id: workspaceId });
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});

test("runs: trunk-run lookup uses the (workspace_id, created_at) index", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-trunklookup");
        const trunk = await db.test_runs_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("tl-trunk") });
        await db.test_runs_insert_with_parent.run({ workspace_id: workspaceId, name: n("tl-fA"), parent_worker_id: trunk?.id });
        await db.test_runs_insert_with_parent.run({ workspace_id: workspaceId, name: n("tl-fB"), parent_worker_id: trunk?.id });
        const found = await db.test_runs_trunk_lookup.get<{ id: number }>({ workspace_id: workspaceId });
        assert.equal(found?.id, trunk?.id);
    } finally { await db.close(); }
});
