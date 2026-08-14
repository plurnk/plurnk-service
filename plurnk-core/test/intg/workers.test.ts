import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace } from "./_helpers.ts";
import Envelope from "../../src/server/envelope.ts";

let nameCounter = 0;
const n = (suffix: string): string => `worker-${suffix}-${++nameCounter}`;

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

test("{§worker-auto-name} #159: concurrent anonymous attachments atomically claim distinct client ordinals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-concurrent-clients-${crypto.randomUUID()}`);
        const envelopes = await Promise.all(Array.from(
            { length: 8 },
            () => Envelope.attachToWorkspace(db, workspaceId),
        ));
        const names = envelopes.map(({ workerName }) => workerName);

        assert.equal(new Set(names).size, envelopes.length, "every attachment receives a distinct addressable worker");
        assert.deepEqual(names.toSorted(), Array.from({ length: 8 }, (_, i) => `client-${i + 1}`).toSorted());
    } finally { await db.close(); }
});

test("workers: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_workers_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("workers: root worker insert — null parent_worker_id, defaults populate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-trunk");
        await db.test_workers_insert.run({ workspace_id: workspaceId, name: n("trunk") });
        const row = await db.test_workers_get_by_workspace.get<{
            id: number; version: number; workspace_id: number; name: string; created_at: string;
            parent_worker_id: number | null; provider_identity: string;
        }>({ workspace_id: workspaceId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.workspace_id, workspaceId);
        assert.match(row?.name ?? "", /^worker-trunk-\d+$/);
        assert.match(row?.created_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.parent_worker_id, null);
        assert.match(row?.provider_identity ?? "", /^[0-9a-f]{32}$/, "provider identity is an opaque 128-bit value, not the local row id");
    } finally { await db.close(); }
});

test("{§worker-provider-identity}: every worker mints a unique immutable provider identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-provider-identity-${crypto.randomUUID()}`);
        const first = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("provider-a") });
        const second = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("provider-b") });
        const firstIdentity = await db.test_workers_get_provider_identity.get<{ provider_identity: string }>({ id: first?.id });
        const secondIdentity = await db.test_workers_get_provider_identity.get<{ provider_identity: string }>({ id: second?.id });
        assert.match(firstIdentity?.provider_identity ?? "", /^[0-9a-f]{32}$/);
        assert.match(secondIdentity?.provider_identity ?? "", /^[0-9a-f]{32}$/);
        assert.notEqual(firstIdentity?.provider_identity, secondIdentity?.provider_identity);
        await assert.rejects(
            () => db.test_workers_update_provider_identity.run({
                id: first?.id,
                provider_identity: "0".repeat(32),
            }),
            /workers\.provider_identity is immutable/,
        );
        await assert.rejects(
            () => db.test_workers_insert_provider_identity.run({
                workspace_id: workspaceId,
                name: n("provider-duplicate"),
                provider_identity: firstIdentity?.provider_identity,
            }),
            /UNIQUE constraint failed: workers\.provider_identity/,
        );
    } finally { await db.close(); }
});

test("{§methods-model-worker}: one durable default-conversation role admits only a model root", async () => {
    const db = await openMigrated();
    try {
        const uniqueWorkspaceId = await insertWorkspace(db, "ws-one-default-conversation");
        await db.test_workers_insert_default_conversation.run({
            workspace_id: uniqueWorkspaceId,
            name: n("default"),
            parent_worker_id: null,
            origin: "model",
        });
        await assert.rejects(
            () => db.test_workers_insert_default_conversation.run({
                workspace_id: uniqueWorkspaceId,
                name: n("second-default"),
                parent_worker_id: null,
                origin: "model",
            }),
            /UNIQUE constraint failed: workers\.workspace_id/,
        );

        const clientWorkspaceId = await insertWorkspace(db, "ws-client-not-default");
        await assert.rejects(
            () => db.test_workers_insert_default_conversation.run({
                workspace_id: clientWorkspaceId,
                name: n("client-default"),
                parent_worker_id: null,
                origin: "client",
            }),
            /CHECK constraint failed/,
        );

        const childWorkspaceId = await insertWorkspace(db, "ws-child-not-default");
        const parent = await db.test_workers_insert_returning.get<{ id: number }>({
            workspace_id: childWorkspaceId,
            name: n("parent"),
        });
        await assert.rejects(
            () => db.test_workers_insert_default_conversation.run({
                workspace_id: childWorkspaceId,
                name: n("child-default"),
                parent_worker_id: parent?.id,
                origin: "model",
            }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("workers: fork insert — non-null parent_worker_id pointing at root worker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-fork");
        const trunk = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("trunk") });
        const fork = await db.test_workers_insert_with_parent_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fork"), parent_worker_id: trunk?.id });
        const forkRow = await db.test_workers_get_parent.get<{ parent_worker_id: number }>({ id: fork?.id });
        assert.equal(forkRow?.parent_worker_id, trunk?.id);
    } finally { await db.close(); }
});

test("workers: workspace_id NOT NULL — insert without workspace_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workers_insert_default_values(),
            /NOT NULL constraint failed: workers\.workspace_id/,
        );
    } finally { await db.close(); }
});

test("workers: workspace_id FK — insert against non-existent workspace rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workers_insert.run({ workspace_id: 99999, name: n("fk-fail") }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("workers: parent_worker_id FK — insert against non-existent parent rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-badparent");
        await assert.rejects(
            () => db.test_workers_insert_with_parent.run({ workspace_id: workspaceId, name: n("badparent"), parent_worker_id: 99999 }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("workers: parent_worker_id self-reference CHECK — parent != id rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-self");
        const worker = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("self") });
        await assert.rejects(
            () => db.test_workers_set_parent.run({ parent_worker_id: worker?.id, id: worker?.id }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("workers: ON DELETE CASCADE via workspace — deleting workspace removes all its workers", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cascade");
        const otherWorkspaceId = await insertWorkspace(db, "ws-untouched");
        await db.test_workers_insert.run({ workspace_id: workspaceId, name: n("c1") });
        await db.test_workers_insert.run({ workspace_id: workspaceId, name: n("c2") });
        await db.test_workers_insert.run({ workspace_id: otherWorkspaceId, name: n("c3") });
        const before = await db.test_workers_count.get<{ n: number }>();
        assert.equal(before?.n, 3);
        await db.test_workspaces_delete.run({ id: workspaceId });
        const after = await db.test_workers_count.get<{ n: number }>();
        assert.equal(after?.n, 1);
        const survivor = await db.test_workers_get_one_workspace_id.get<{ workspace_id: number }>();
        assert.equal(survivor?.workspace_id, otherWorkspaceId);
    } finally { await db.close(); }
});

test("workers: ON DELETE CASCADE via parent_worker_id — deleting a parent worker removes its forks", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-forkcascade");
        const trunk = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fc-trunk") });
        const trunkId = trunk!.id;
        const forkA = await db.test_workers_insert_with_parent_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fc-fA"), parent_worker_id: trunkId });
        await db.test_workers_insert_with_parent.run({ workspace_id: workspaceId, name: n("fc-fB"), parent_worker_id: trunkId });
        await db.test_workers_insert_with_parent.run({ workspace_id: workspaceId, name: n("fc-fC"), parent_worker_id: forkA?.id });
        const before = await db.test_workers_count.get<{ n: number }>();
        assert.equal(before?.n, 4);
        await db.test_workers_delete.run({ id: trunkId });
        const after = await db.test_workers_count.get<{ n: number }>();
        assert.equal(after?.n, 0);
    } finally { await db.close(); }
});

test("workers: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-negversion");
        await assert.rejects(
            () => db.test_workers_insert_version.run({ workspace_id: workspaceId, name: n("negversion"), version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("workers: index workers_workspace_id_created_at exists", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_workers_index_exists.get<{ name: string }>({ name: "workers_workspace_id_created_at" });
        assert.equal(row?.name, "workers_workspace_id_created_at");
    } finally { await db.close(); }
});

test("workers: index workers_parent_worker_id exists", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_workers_index_exists.get<{ name: string }>({ name: "workers_parent_worker_id" });
        assert.equal(row?.name, "workers_parent_worker_id");
    } finally { await db.close(); }
});

test("workers: a name repeats within a workspace — reclamation across time, not store-unique", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-reclaim");
        const first = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        // The store PERMITS a second 'worker': a name is frozen per worker but reclaimable across time —
        // a terminated worker keeps its name in permanent history while a fresh spawn reuses it. A LIVE
        // collision is refused at the spawn gate (Engine.#handleWorkerCopy → worker_live_by_name → 409), never by the
        // store. The dropped UNIQUE index returned a raw 500 the model couldn't read.
        const second = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.notEqual(first?.id, second?.id, "two distinct workers can hold the same name");
        // Resolution is newest-wins — the live/fresh worker, never the corpse.
        const resolved = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.equal(resolved?.id, second?.id, "worker_resolve_by_name resolves the newest holder");
    } finally { await db.close(); }
});

test("workers: index workers_workspace_name exists (plain — the by-name resolve/spawn lookup, not a uniqueness constraint)", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_workers_index_exists.get<{ name: string }>({ name: "workers_workspace_name" });
        assert.equal(row?.name, "workers_workspace_name");
    } finally { await db.close(); }
});

test("workers: id auto-assigns on insert", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-autoid");
        await db.test_workers_insert.run({ workspace_id: workspaceId, name: n("auto-a") });
        await db.test_workers_insert.run({ workspace_id: workspaceId, name: n("auto-b") });
        const rows = await db.test_workers_list_by_workspace.all<{ id: number }>({ workspace_id: workspaceId });
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});

test("workers: root-worker lookup uses the (workspace_id, created_at) index", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-trunklookup");
        const trunk = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("tl-trunk") });
        await db.test_workers_insert_with_parent.run({ workspace_id: workspaceId, name: n("tl-fA"), parent_worker_id: trunk?.id });
        await db.test_workers_insert_with_parent.run({ workspace_id: workspaceId, name: n("tl-fB"), parent_worker_id: trunk?.id });
        const found = await db.test_workers_root_lookup.get<{ id: number }>({ workspace_id: workspaceId });
        assert.equal(found?.id, trunk?.id);
    } finally { await db.close(); }
});
