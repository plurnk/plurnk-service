import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { MIGRATIONS_DIR } from "./_helpers.ts";

test("v8 loop history migrates to honest durable results without fabricating diagnostics", () => {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(`
            CREATE TABLE loops (
                id INTEGER PRIMARY KEY,
                status INTEGER NOT NULL
                    CHECK (status IN (100, 102, 200, 202, 413, 429, 499, 500, 504, 508))
            ) STRICT;

            INSERT INTO loops (id, status)
            VALUES
                (1, 102),
                (2, 202),
                (3, 200),
                (4, 500);
            PRAGMA user_version = 8;
        `);

        const migration = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE
            .filter(({ version }) => version === 9);
        assert.equal(migration.length, 1);
        SqlRiteCore.applyMigrations(db, migration);

        const rows = db.prepare(`
            SELECT id, status, terminal_result
            FROM loops
            ORDER BY id
        `).all() as Array<{ id: number; status: number; terminal_result: string | null }>;

        assert.deepEqual({ ...rows[0] }, { id: 1, status: 102, terminal_result: null });
        assert.deepEqual({ ...rows[1] }, { id: 2, status: 202, terminal_result: null });
        assert.deepEqual(JSON.parse(rows[2]!.terminal_result ?? "null"), { status: 200 });
        assert.deepEqual(JSON.parse(rows[3]!.terminal_result ?? "null"), {
            status: 500,
            problem: {
                type: "https://problems.plurnk.dev/migration/loop/historic-failure",
                title: "Historic loop failure",
                status: 500,
                detail: "This loop failed before durable Problem Details were recorded.",
                instance: "loop:///4",
            },
        });
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 9);
    } finally {
        db.close();
    }
});
