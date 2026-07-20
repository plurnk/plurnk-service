// {§entry-identity-no-null} (#545, run59) — the identity tuple admits no NULL component.
// The proof is the exact production failure in miniature: the per-turn membership upsert
// must CONFLICT (one row, ever) instead of fragmenting one phantom row per turn — the
// 74k-rows-for-530-identities specimen. Plus the schema wall itself: a NULL scheme insert
// is refused at the column, not discovered by a benchmark agent 220 turns later.
import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace } from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

test("[§entry-identity-no-null] the per-turn membership upsert converges to ONE row — the run59 fragmentation is structurally impossible", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `identity-${crypto.randomUUID()}`);
        const commonsId = await Owner.commonsId(db, workspaceId);
        // Three "turn boundaries" re-registering the same member — the exact production shape.
        for (let turn = 0; turn < 3; turn++) {
            await (db.crud_register_workspace_member as PrepMethod).get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", pathname: "/evaluator/functions.go", membership_origin: "git" });
        }
        const rows = await (db.test_count_entry_rows as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, pathname: "/evaluator/functions.go" });
        assert.equal(rows?.n, 1, "three registrations, ONE row — ON CONFLICT fires now that no identity component is NULL");
    } finally { await db.close(); }
});

test("[§entry-identity-no-null] a NULL-scheme insert is refused by the schema wall", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `identity-null-${crypto.randomUUID()}`);
        const commonsId = await Owner.commonsId(db, workspaceId);
        await assert.rejects(
            () => (db.crud_register_workspace_member as PrepMethod).get({ workspace_id: workspaceId, owner_id: commonsId, scheme: null, pathname: "/x.md", membership_origin: "git" }),
            /NOT NULL/i,
            "the column refuses NULL — the identity law is enforced at the schema, not by caller discipline",
        );
    } finally { await db.close(); }
});
