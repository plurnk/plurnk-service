import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated } from "./_helpers.ts";

test("workspaces: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_workspaces_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("workspaces: insert with name only — defaults populate version and created_at", async () => {
    const db = await openMigrated();
    try {
        await db.test_workspaces_insert_name_only.run({ name: "opus-1747400000" });
        const row = await db.test_workspaces_get_by_name.get<{
            id: number; version: number; name: string; created_at: string;
        }>({ name: "opus-1747400000" });
        assert.equal(typeof row?.id, "number");
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.name, "opus-1747400000");
        assert.match(row?.created_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally { await db.close(); }
});

test("workspaces: name UNIQUE — duplicate insert is rejected", async () => {
    const db = await openMigrated();
    try {
        await db.test_workspaces_insert_name_only.run({ name: "workspace-a" });
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "workspace-a" }),
            /UNIQUE constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});

test("workspaces: empty name rejected by CHECK (length > 0)", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("workspaces: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_with_version.run({ name: "workspace-c", version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("workspaces: NOT NULL enforced on name", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_no_name(),
            /NOT NULL constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});

test("workspaces: created_at query index uses workspace vocabulary", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_workspaces_index_exists.get<{ name: string }>();
        assert.equal(row?.name, "workspaces_created_at");
    } finally { await db.close(); }
});

test("workspaces: id auto-assigns on insert (INTEGER PRIMARY KEY rowid alias)", async () => {
    const db = await openMigrated();
    try {
        await db.test_workspaces_insert_name_only.run({ name: "workspace-g" });
        await db.test_workspaces_insert_name_only.run({ name: "workspace-h" });
        const rows = await db.test_workspaces_list_ordered.all<{ id: number; name: string }>();
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});
