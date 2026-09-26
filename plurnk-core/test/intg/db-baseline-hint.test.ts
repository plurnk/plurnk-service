// {§db-migrations} — a database whose shape disagrees with its version cannot be migrated;
// the launcher must say so instead of surfacing SQLite's bare "no such column".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { launch } from "./_launcher.ts";

test("{§db-migrations}: opening a database whose shape disagrees with its version names the remedy", async () => {
    const result = await launch({}, async ({ dir, dbPath }) => {
        // A database past every version whose entry_channels has another shape: no migration
        // runs, and the statements naming today's columns cannot prepare.
        const older = join(dir, "older-baseline");
        await mkdir(older);
        await writeFile(join(older, "099_other.sql"), "-- MIGRATE: 99 other\nCREATE TABLE entry_channels (entry_id INTEGER, name TEXT, content TEXT);\n");
        new SqlRiteSync({ path: dbPath, dir: older }).close();
    });
    assert.equal(result.code, 1, `the launcher fails closed (stderr: ${result.stderr})`);
    assert.match(result.stderr, /shape disagrees with its schema version/, "the operator is told what the failure is");
    assert.match(result.stderr, /newer release needs that release; .* deleted with its -wal and -shm sidecars/, "and what to do about it");
    assert.match(result.stderr, /cause: no such (?:column|table)/, "SQLite's own diagnosis stays attached");
});
