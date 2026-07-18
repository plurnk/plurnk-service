// #522 — the PRIMARY worker of a lineage: the no-parent root reached by walking parent_worker_id up.
// The endpoint routes primary→strong / spawned→cheap by `Worker-Primary == Worker-Id`, so the value
// must be the TRUE root (not "first seen"), resolvable on EVERY worker including the primary's own
// (where it equals itself). Core supplies it on the first-party metadata channel; providers emits
// the `Plurnk-Worker-Primary` header.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker } from "./_helpers.ts";

test("[§worker-primary] a 3-level lineage all resolves to the true root; the root is its own primary", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `primary-${crypto.randomUUID()}`);
        const root = await insertWorker(db, workspaceId, null, "root");          // no parent = the primary
        const child = await insertWorker(db, workspaceId, root, "child");
        const grandchild = await insertWorker(db, workspaceId, child, "grandchild");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // Pin 1: the TRUE root — a grandchild resolves straight to root, no depth math.
        assert.equal(await engine.resolveWorkerPrimary(grandchild), root, "grandchild → the root (not its immediate parent)");
        assert.equal(await engine.resolveWorkerPrimary(child), root, "child → the root");
        // Pin 2: the primary's OWN turns stamp Worker-Primary == Worker-Id.
        assert.equal(await engine.resolveWorkerPrimary(root), root, "the root is its own primary — always stamped, never absent");
    } finally { await db.close(); }
});

test("[§worker-primary] two sibling subtrees resolve to their shared root — the grouping key", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `primary-sib-${crypto.randomUUID()}`);
        const root = await insertWorker(db, workspaceId, null, "root");
        const a = await insertWorker(db, workspaceId, root, "branch-a");
        const b = await insertWorker(db, workspaceId, root, "branch-b");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const [pa, pb] = [await engine.resolveWorkerPrimary(a), await engine.resolveWorkerPrimary(b)];
        assert.equal(pa, root);
        assert.equal(pb, root);
        assert.equal(pa, pb, "sibling subtrees share the primary — it doubles as the worker-tree grouping key");
    } finally { await db.close(); }
});
