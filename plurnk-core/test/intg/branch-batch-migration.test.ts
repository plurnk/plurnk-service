import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { MIGRATIONS_DIR } from "./_helpers.ts";

test("v10 repository constraints are removed while membership overlays survive v11", () => {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(`
            CREATE TABLE workspaces (id INTEGER PRIMARY KEY) STRICT;
            CREATE TABLE workers (
                id INTEGER PRIMARY KEY,
                workspace_id INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE loops (
                id INTEGER PRIMARY KEY,
                worker_id INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE turns (
                id INTEGER PRIMARY KEY,
                loop_id INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE workspace_constraints (
                workspace_id INTEGER NOT NULL,
                effect TEXT NOT NULL CHECK (effect IN ('pick', 'hide', 'view', 'repo')),
                glob TEXT NOT NULL,
                PRIMARY KEY (workspace_id, effect, glob),
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            ) STRICT, WITHOUT ROWID;

            INSERT INTO workspaces (id) VALUES (1);
            INSERT INTO workspace_constraints (workspace_id, effect, glob) VALUES
                (1, 'pick', 'notes/**'),
                (1, 'hide', 'dist/**'),
                (1, 'view', 'vendor/**'),
                (1, 'repo', 'packages/**');
            PRAGMA user_version = 10;
        `);

        const migration = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE
            .filter(({ version }) => version === 11);
        assert.equal(migration.length, 1);
        SqlRiteCore.applyMigrations(db, migration);

        const rows = db.prepare(`
            SELECT effect, glob
            FROM workspace_constraints
            ORDER BY effect
        `).all().map((row) => ({ ...row }));
        assert.deepEqual(rows, [
            { effect: "hide", glob: "dist/**" },
            { effect: "pick", glob: "notes/**" },
            { effect: "view", glob: "vendor/**" },
        ]);
        assert.throws(
            () => db.exec("INSERT INTO workspace_constraints VALUES (1, 'repo', 'other/**')"),
            /constraint failed/i,
        );
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 11);
    } finally {
        db.close();
    }
});
