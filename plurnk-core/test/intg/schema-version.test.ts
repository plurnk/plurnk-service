// {§db-schema-version-stamp} (#536) — every plurnk DB carries PRAGMA user_version, the
// cross-repo drift gate bench's digest fail-hards on. A schema-shape change that forgets
// the bump ships silent rot to every external consumer; this pin makes the stamp itself
// unforgettable (the bump discipline rides review + the SPEC law).
import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated } from "./_helpers.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

test("[§db-schema-version-stamp] a migrated DB is stamped with the current schema version", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_schema_version as PrepMethod).get<{ v: number }>({});
        assert.equal(row?.v, 1, "PRAGMA user_version carries the genesis stamp — external consumers gate on it");
    } finally { await db.close(); }
});
