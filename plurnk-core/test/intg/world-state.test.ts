// [§fs-world-state] — the harness proves BOTH directions: a lawful world reports zero
// violations, and a manufactured breach is DETECTED (a detector nobody has seen catch
// anything is a guard nobody can trust). The soak half runs the run59 shape in miniature:
// turn boundaries over one workspace, zero entry growth on read-only turns.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WorldState from "../../src/core/world-state.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES, rootWorkspace } from "./_helpers.ts";

test("a lawful world reports ZERO violations after real lifecycle traffic", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-ws-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-clean-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry("a.md", { channels: { body: { content: "a\n", mimetype: "text/markdown" } }, tags: ["t1"] }, ctx, "file");
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", pathname: "b.md", membership_origin: "git" });

        const violations = await WorldState.check(db);
        assert.deepEqual(violations, [], "the lawful world is silent");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("the detector CATCHES: a non-canon stored key and an alien grantor both self-name", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-ws-bad-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-bad-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const commons = await Owner.commonsId(db, workspaceId);
        // A pre-canon legacy key smuggled in raw (the class the v3 heal folds).
        await db.crud_insert_workspace_entry.get({ workspace_id: workspaceId, owner_id: commons, scheme: "file", pathname: "/legacy.md" });
        // An alien grantor cannot even be MANUFACTURED — the schema CHECK is the wall
        // (stronger than detection); ws_alien_origin stays in the harness as the belt for
        // pre-wall specimens bench may sweep.
        await assert.rejects(
            () => db.test_set_origin.run({ workspace_id: workspaceId, pathname: "/legacy.md", membership_origin: "plurnk-decided" }),
            /CHECK constraint failed/,
            "the closed admission set is enforced at the schema wall",
        );

        const violations = await WorldState.check(db);
        const laws = violations.map((v) => v.invariant).toSorted();
        assert.ok(laws.includes("§fs-canonical-name"), `the non-canon key is caught: ${JSON.stringify(violations)}`);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
