import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { MIGRATIONS_DIR } from "./_helpers.ts";

test("v7 subscription history migrates to honest durable results without fabricating diagnostics", () => {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(`
            CREATE TABLE subscriptions (
                id INTEGER PRIMARY KEY,
                closed_at TEXT,
                close_status INTEGER
            ) STRICT;

            INSERT INTO subscriptions (id) VALUES (1);
            INSERT INTO subscriptions (id, closed_at, close_status)
            VALUES
                (2, '2026-01-01T00:00:00.000Z', 200),
                (3, '2026-01-01T00:00:00.000Z', 500);
            PRAGMA user_version = 7;
        `);

        const migration = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.filter(({ version }) => version === 8);
        assert.equal(migration.length, 1);
        SqlRiteCore.applyMigrations(db, migration);

        const rows = db.prepare(`
            SELECT id, close_status, close_result
            FROM subscriptions
            ORDER BY id
        `).all() as Array<{ id: number; close_status: number | null; close_result: string | null }>;

        assert.deepEqual({ ...rows[0] }, { id: 1, close_status: null, close_result: null });
        assert.deepEqual(JSON.parse(rows[1]!.close_result ?? "null"), { status: 200 });
        assert.deepEqual(JSON.parse(rows[2]!.close_result ?? "null"), {
            status: 500,
            problem: {
                type: "https://problems.plurnk.dev/migration/subscription/historic-failure",
                title: "Historic stream failure",
                status: 500,
                detail: "This stream failed before durable Problem Details were recorded.",
            },
        });
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 8);
    } finally {
        db.close();
    }
});
