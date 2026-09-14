// {§db-schema-baseline} — a database that predates the current baseline is deleted, never
// migrated; the launcher must say so instead of surfacing SQLite's bare "no such column".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { launch } from "./_launcher.ts";

test("{§db-schema-baseline}: opening a database from an older baseline names the remedy", async () => {
    const result = await launch({}, async ({ dir, dbPath }) => {
        // A database already at the last chapter's version whose entry_channels has an earlier
        // shape: the chapters do not run again, and the statements naming today's columns
        // cannot prepare. Exactly the pre-migration incident.
        const older = join(dir, "older-baseline");
        await mkdir(older);
        await writeFile(join(older, "008_older.sql"), "-- MIGRATE: 8 older\nCREATE TABLE entry_channels (entry_id INTEGER, name TEXT, content TEXT);\n");
        new SqlRiteSync({ path: dbPath, dir: older }).close();
    });
    assert.equal(result.code, 1, `the launcher fails closed (stderr: ${result.stderr})`);
    assert.match(result.stderr, /predates the current schema baseline/, "the operator is told what the failure is");
    assert.match(result.stderr, /delete .*plurnk\.db with its -wal and -shm sidecars/, "and what to do about it");
    assert.match(result.stderr, /cause: no such (?:column|table)/, "SQLite's own diagnosis stays attached");
});
