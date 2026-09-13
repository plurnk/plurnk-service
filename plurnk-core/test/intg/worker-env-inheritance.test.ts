// SPEC {§exec-env-scoped} — the environment a child starts from (operator ruling 2026-09-13,
// #586). A child inherits a COPY of its parent's registry. FORK already carried it through
// {§machine-processes-entry-inheritance}; WORK is the case this trigger adds, and it copies the
// registry ALONE — a child inherits how work is done, not what was done.

import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace, insertWorker } from "./_helpers.ts";

const REGISTRY = "/.env";
const DOCUMENT = "CARGO_TARGET_DIR=/tmp/shared\n# CI=1";

const seedRegistry = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, authority: string, content: string): Promise<void> => {
    const entry = await db.ops_insert_workspace_entry_if_absent.get<{ id: number }>({
        workspace_id: workspaceId, scheme: "worker", authority, pathname: REGISTRY,
    });
    await db.ops_insert_channel_if_absent.run({
        entry_id: entry!.id, name: "body", content, mimetype: "text/plain",
        weight: 0, content_hash: null,
    });
};

const registryOf = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, authority: string): Promise<string | null> => {
    const row = await db.ops_read_channel.get<{ content: string }>({
        workspace_id: workspaceId, scheme: "worker", authority, pathname: REGISTRY, channel: "body",
    });
    return row?.content ?? null;
};

test("{§exec-env-scoped} a WORK child inherits a copy of its parent's registry", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `env-inherit-${crypto.randomUUID()}`);
        const parentId = await insertWorker(db, workspaceId);
        const parent = await db.worker_name_by_id.get<{ name: string }>({ worker_id: parentId });
        await seedRegistry(db, workspaceId, parent!.name, DOCUMENT);

        const childId = await insertWorker(db, workspaceId, parentId);
        const child = await db.worker_name_by_id.get<{ name: string }>({ worker_id: childId });

        assert.equal(await registryOf(db, workspaceId, child!.name), DOCUMENT,
            "the document copies faithfully, including the commented entry the parent masked");
    } finally { await db.close(); }
});

test("{§exec-env-scoped} the copy is owned by the child: later edits do not cross", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `env-diverge-${crypto.randomUUID()}`);
        const parentId = await insertWorker(db, workspaceId);
        const parent = await db.worker_name_by_id.get<{ name: string }>({ worker_id: parentId });
        await seedRegistry(db, workspaceId, parent!.name, DOCUMENT);

        const childId = await insertWorker(db, workspaceId, parentId);
        const child = await db.worker_name_by_id.get<{ name: string }>({ worker_id: childId });

        // The parent changes its own registry after the child exists.
        const parentEntry = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "worker", authority: parent!.name, pathname: REGISTRY,
        });
        await db.ops_update_channel_if_content.run({
            entry_id: parentEntry!.id, name: "body", content: "CARGO_TARGET_DIR=/tmp/parent-only",
            mimetype: "text/plain", weight: 0, content_hash: null, expected_content: DOCUMENT,
        });

        assert.equal(await registryOf(db, workspaceId, child!.name), DOCUMENT,
            "a later parent edit never mutates a running child — this is a snapshot, not a link");
    } finally { await db.close(); }
});

test("{§exec-env-scoped} a root worker with no parent inherits nothing", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `env-root-${crypto.randomUUID()}`);
        const rootId = await insertWorker(db, workspaceId);
        const root = await db.worker_name_by_id.get<{ name: string }>({ worker_id: rootId });
        assert.equal(await registryOf(db, workspaceId, root!.name), null,
            "a worker that never set anything has no document, which is the ordinary case");
    } finally { await db.close(); }
});
