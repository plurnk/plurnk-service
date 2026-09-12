import test from "node:test";
import assert from "node:assert/strict";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { MIGRATIONS_DIR, openMigrated } from "./_helpers.ts";

// {§db-schema-baseline} — the project has not entered its migration phase: the baseline is its
// chapters, numbered consecutively from 1, and a fresh database lands on the last chapter's number.
test("the pre-release database is the chaptered baseline, applied in chapter order", async () => {
    const migrations = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE;
    const versions = migrations.map(({ version }) => version);
    assert.ok(versions.length > 1, "the baseline is chaptered");
    assert.deepEqual(versions, versions.map((_, index) => index + 1), "chapters are numbered consecutively from 1 with no gaps");

    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, versions.length, "a fresh database is at the last chapter; nothing beyond the baseline was applied");
    } finally { await db.close(); }
});
