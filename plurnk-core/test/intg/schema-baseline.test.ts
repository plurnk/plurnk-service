import test from "node:test";
import assert from "node:assert/strict";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { MIGRATIONS_DIR, openMigrated } from "./_helpers.ts";

// {§db-schema-baseline} — the project has not entered its migration phase.
test("the pre-release database is one version-1 baseline", async () => {
    const migrations = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE;
    assert.deepEqual(migrations.map(({ version }) => version), [1]);

    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, 1);
    } finally { await db.close(); }
});
