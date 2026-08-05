// {§entry-identity-no-null} — repeated registration converges and NULL cannot fragment identity.
import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace } from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";

test("{§entry-identity-no-null}: repeated membership registration converges to one row", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `identity-${crypto.randomUUID()}`);
        const commonsId = await Owner.commonsId(db, workspaceId);
        // Simulate repeated turn-boundary registration of one member.
        for (let turn = 0; turn < 3; turn++) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", pathname: "/evaluator/functions.go", membership_origin: "git" });
        }
        const rows = await db.test_count_entry_rows.get<{ n: number }>({ workspace_id: workspaceId, pathname: "/evaluator/functions.go" });
        assert.equal(rows?.n, 1, "three registrations, ONE row — ON CONFLICT fires now that no identity component is NULL");
    } finally { await db.close(); }
});

test("{§entry-identity-no-null}: the schema refuses a NULL scheme", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `identity-null-${crypto.randomUUID()}`);
        const commonsId = await Owner.commonsId(db, workspaceId);
        await assert.rejects(
            () => db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: null, pathname: "/x.md", membership_origin: "git" }),
            /NOT NULL/i,
            "the column refuses NULL — the identity law is enforced at the schema, not by caller discipline",
        );
    } finally { await db.close(); }
});
