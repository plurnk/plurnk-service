import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { MIGRATIONS_DIR } from "./_helpers.ts";

test("v6 pico-USD databases migrate values, columns, and rollup triggers to ordinary USD", () => {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(`
            CREATE TABLE workspaces (
                id INTEGER PRIMARY KEY,
                cost_pico INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0)
            ) STRICT;
            CREATE TABLE workers (
                id INTEGER PRIMARY KEY,
                workspace_id INTEGER NOT NULL,
                cost_pico INTEGER NOT NULL DEFAULT 0 CHECK (cost_pico >= 0)
            ) STRICT;
            CREATE TABLE loops (
                id INTEGER PRIMARY KEY,
                worker_id INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE turns (
                id INTEGER PRIMARY KEY,
                loop_id INTEGER NOT NULL,
                usage_cost_pico INTEGER NOT NULL DEFAULT 0 CHECK (usage_cost_pico >= 0)
            ) STRICT;

            CREATE TRIGGER turns_cost_rollup_insert_worker
            AFTER INSERT ON turns BEGIN
                UPDATE workers SET cost_pico = cost_pico + NEW.usage_cost_pico
                WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
            END;
            CREATE TRIGGER turns_cost_rollup_insert_workspace
            AFTER INSERT ON turns BEGIN
                UPDATE workspaces SET cost_pico = cost_pico + NEW.usage_cost_pico
                WHERE id = (
                    SELECT r.workspace_id FROM workers r
                    JOIN loops l ON l.worker_id = r.id WHERE l.id = NEW.loop_id
                );
            END;
            CREATE TRIGGER turns_cost_rollup_update_worker
            AFTER UPDATE OF usage_cost_pico ON turns
            WHEN NEW.usage_cost_pico != OLD.usage_cost_pico BEGIN
                UPDATE workers SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
                WHERE id = (SELECT worker_id FROM loops WHERE id = NEW.loop_id);
            END;
            CREATE TRIGGER turns_cost_rollup_update_workspace
            AFTER UPDATE OF usage_cost_pico ON turns
            WHEN NEW.usage_cost_pico != OLD.usage_cost_pico BEGIN
                UPDATE workspaces SET cost_pico = cost_pico + NEW.usage_cost_pico - OLD.usage_cost_pico
                WHERE id = (
                    SELECT r.workspace_id FROM workers r
                    JOIN loops l ON l.worker_id = r.id WHERE l.id = NEW.loop_id
                );
            END;

            INSERT INTO workspaces (id) VALUES (1);
            INSERT INTO workers (id, workspace_id) VALUES (1, 1);
            INSERT INTO loops (id, worker_id) VALUES (1, 1);
            INSERT INTO turns (id, loop_id, usage_cost_pico) VALUES (1, 1, 1250000000000);
            PRAGMA user_version = 6;
        `);

        const migration = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.filter(({ version }) => version === 7);
        assert.equal(migration.length, 1);
        SqlRiteCore.applyMigrations(db, migration);

        const columns = (table: string): string[] =>
            db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => String(name));
        assert.deepEqual(columns("workspaces"), ["id", "cost_usd"]);
        assert.deepEqual(columns("workers"), ["id", "workspace_id", "cost_usd"]);
        assert.deepEqual(columns("turns"), ["id", "loop_id", "usage_cost_usd"]);

        assert.equal(db.prepare("SELECT cost_usd FROM workspaces WHERE id = 1").get()?.cost_usd, 1.25);
        assert.equal(db.prepare("SELECT cost_usd FROM workers WHERE id = 1").get()?.cost_usd, 1.25);
        assert.equal(db.prepare("SELECT usage_cost_usd FROM turns WHERE id = 1").get()?.usage_cost_usd, 1.25);

        db.exec("INSERT INTO turns (id, loop_id, usage_cost_usd) VALUES (2, 1, 0.5)");
        assert.equal(db.prepare("SELECT cost_usd FROM workers WHERE id = 1").get()?.cost_usd, 1.75);
        assert.equal(db.prepare("SELECT cost_usd FROM workspaces WHERE id = 1").get()?.cost_usd, 1.75);

        db.exec("UPDATE turns SET usage_cost_usd = 0.75 WHERE id = 2");
        assert.equal(db.prepare("SELECT cost_usd FROM workers WHERE id = 1").get()?.cost_usd, 2);
        assert.equal(db.prepare("SELECT cost_usd FROM workspaces WHERE id = 1").get()?.cost_usd, 2);
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 7);
    } finally {
        db.close();
    }
});
