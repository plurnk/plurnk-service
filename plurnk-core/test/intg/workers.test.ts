import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace } from "./_db.ts";
import Envelope from "../../src/server/envelope.ts";
import RuntimeWorker from "../../src/core/RuntimeWorker.ts";
import { WorkerNameError } from "../../src/core/WorkerName.ts";

let nameCounter = 0;
const n = (suffix: string): string => `worker-${suffix}-${++nameCounter}`;

test("{§worker-name-minting}: 'plurnk' is an ordinary worker name; the runtime actor's '_plurnk' is not mintable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-plurnk-name");
        const runtimeId = await RuntimeWorker.ensure(db, workspaceId);
        const plurnk = await Envelope.createModelWorker(db, workspaceId, "plurnk");
        assert.equal(plurnk.name, "plurnk", "an operator may name a worker plurnk");
        assert.notEqual(plurnk.id, runtimeId, "and holds a worker of their own, not the runtime actor");
        await assert.rejects(() => Envelope.createModelWorker(db, workspaceId, "_plurnk"), WorkerNameError, "the runtime actor's name cannot be minted");
        const upper = await Envelope.createModelWorker(db, workspaceId, "PLURNK");
        assert.equal(upper.name, "PLURNK");
        assert.notEqual(upper.id, plurnk.id, "worker identity is case-sensitive");
        for (const worker of [plurnk, upper]) {
            const resolved = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: worker.name });
            assert.equal(resolved?.id, worker.id, "a name resolves the exact literal identity");
        }
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

test("{§machine-processes-fork-shares-workspace} workers: fork insert — non-null parent_worker_id pointing at root worker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-fork");
        const trunk = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("trunk") });
        const fork = await db.test_workers_insert_with_parent_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fork"), parent_worker_id: trunk?.id });
        const forkRow = await db.test_workers_get_parent.get<{ parent_worker_id: number }>({ id: fork?.id });
        assert.equal(forkRow?.parent_worker_id, trunk?.id);
    } finally { await db.close(); }
});

test("{§validation-topology} workers: workspace_id NOT NULL — insert without workspace_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workers_insert_default_values(),
            /NOT NULL constraint failed: workers\.workspace_id/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} workers: workspace_id FK — insert against non-existent workspace rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workers_insert.run({ workspace_id: 99999, name: n("fk-fail") }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} workers: parent_worker_id FK — insert against non-existent parent rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-badparent");
        await assert.rejects(
            () => db.test_workers_insert_with_parent.run({ workspace_id: workspaceId, name: n("badparent"), parent_worker_id: 99999 }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} workers: parent_worker_id self-reference CHECK — parent != id rejected", async () => {
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

test("{§validation-topology} workers: ON DELETE CASCADE via workspace — deleting workspace removes all its workers", async () => {
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

test("{§validation-topology} workers: ON DELETE CASCADE via parent_worker_id — deleting a parent worker removes its forks", async () => {
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

test("{§validation-topology} workers: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-negversion");
        await assert.rejects(
            () => db.test_workers_insert_version.run({ workspace_id: workspaceId, name: n("negversion"), version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§worker-scheme-spawn} workers: retained names are workspace-unique so old resource addresses remain stable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-reclaim");
        const first = await db.test_workers_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        await assert.rejects(
            db.test_workers_insert_returning.get({ workspace_id: workspaceId, name: "worker" }),
            /UNIQUE constraint failed: workers.workspace_id, workers.name/,
        );
        const resolved = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.equal(resolved?.id, first?.id);
    } finally { await db.close(); }
});
