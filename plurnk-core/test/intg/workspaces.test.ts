import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated } from "./_db.ts";

test("{§workspace-name} workspaces: name UNIQUE — duplicate insert is rejected", async () => {
    const db = await openMigrated();
    try {
        await db.test_workspaces_insert_name_only.run({ name: "workspace-a" });
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "workspace-a" }),
            /UNIQUE constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});

test("{§workspace-name} workspaces: empty name rejected by CHECK (length > 0)", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_name_only.run({ name: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} workspaces: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_with_version.run({ name: "workspace-c", version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§workspace-name} workspaces: NOT NULL enforced on name", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_workspaces_insert_no_name(),
            /NOT NULL constraint failed: workspaces\.name/,
        );
    } finally { await db.close(); }
});
