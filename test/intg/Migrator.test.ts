import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Migrator from "../../src/core/Migrator.ts";

const withFixture = async (fn: (ctx: { db: DatabaseSync; dir: string }) => Promise<void>): Promise<void> => {
    const db = new DatabaseSync(":memory:");
    const dir = await mkdtemp(join(tmpdir(), "plurnk-mig-"));
    try { await fn({ db, dir }); }
    finally { await rm(dir, { recursive: true, force: true }); db.close(); }
};

test("Migrator: creates applied_migrations meta table on construction", async () => {
    await withFixture(async ({ db, dir }) => {
        new Migrator({ db, dir });
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'applied_migrations'").get() as { name: string } | undefined;
        assert.equal(row?.name, "applied_migrations");
    });
});

test("Migrator: applied_migrations is STRICT and WITHOUT ROWID", async () => {
    await withFixture(async ({ db, dir }) => {
        new Migrator({ db, dir });
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'applied_migrations'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
        assert.match(sql, /WITHOUT ROWID/);
    });
});

test("Migrator: migrate() with empty dir returns empty applied + empty skipped", async () => {
    await withFixture(async ({ db, dir }) => {
        const m = new Migrator({ db, dir });
        const result = await m.migrate();
        assert.deepEqual(result, { applied: [], skipped: [] });
    });
});

test("Migrator: applies a single migration and records the id", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(join(dir, "001_foo.sql"), "CREATE TABLE foo (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        const m = new Migrator({ db, dir });
        const result = await m.migrate();
        assert.deepEqual(result.applied, ["001_foo"]);
        assert.deepEqual(result.skipped, []);
        const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get() as { name: string } | undefined;
        assert.equal(table?.name, "foo");
        const applied = m.listApplied();
        assert.equal(applied.length, 1);
        assert.equal(applied[0]?.id, "001_foo");
        assert.match(applied[0]?.applied_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    });
});

test("Migrator: re-running migrate() skips already-applied migrations", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(join(dir, "001_foo.sql"), "CREATE TABLE foo (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        const m = new Migrator({ db, dir });
        await m.migrate();
        const second = await m.migrate();
        assert.deepEqual(second, { applied: [], skipped: ["001_foo"] });
    });
});

test("Migrator: applies multiple migrations in lexicographic (numeric-prefix) order", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(join(dir, "002_second.sql"), "CREATE TABLE bar (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        await writeFile(join(dir, "001_first.sql"), "CREATE TABLE foo (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        await writeFile(join(dir, "003_third.sql"), "CREATE TABLE baz (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        const m = new Migrator({ db, dir });
        const result = await m.migrate();
        assert.deepEqual(result.applied, ["001_first", "002_second", "003_third"]);
    });
});

test("Migrator: ignores non-migration files in the dir", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(join(dir, "001_foo.sql"), "CREATE TABLE foo (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        await writeFile(join(dir, "README.md"), "# migrations");
        await writeFile(join(dir, "foo.sql"), "CREATE TABLE wrong (id INTEGER) STRICT;");
        await writeFile(join(dir, "001_foo.sql.bak"), "backup");
        const m = new Migrator({ db, dir });
        const result = await m.migrate();
        assert.deepEqual(result.applied, ["001_foo"]);
        const wrong = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wrong'").get();
        assert.equal(wrong, undefined);
    });
});

test("Migrator: failed migration rolls back and throws with cause", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(
            join(dir, "001_bad.sql"),
            "CREATE TABLE foo (id INTEGER NOT NULL PRIMARY KEY) STRICT; INSERT INTO nonexistent_table VALUES (1);",
        );
        const m = new Migrator({ db, dir });
        await assert.rejects(
            () => m.migrate(),
            (err: Error) => {
                assert.match(err.message, /Migration 001_bad failed/);
                assert.ok(err.cause instanceof Error, "cause should be the underlying SQLite error");
                return true;
            },
        );
        const foo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get();
        assert.equal(foo, undefined, "BEGIN/ROLLBACK should have undone the CREATE TABLE");
        const applied = m.listApplied();
        assert.equal(applied.length, 0, "failed migration must not be recorded in applied_migrations");
    });
});

test("Migrator: failed migration leaves subsequent migrations unapplied", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(join(dir, "001_bad.sql"), "INSERT INTO nonexistent VALUES (1);");
        await writeFile(join(dir, "002_unreached.sql"), "CREATE TABLE unreached (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        const m = new Migrator({ db, dir });
        await assert.rejects(() => m.migrate(), /Migration 001_bad failed/);
        const unreached = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unreached'").get();
        assert.equal(unreached, undefined);
    });
});

test("Migrator: aborted signal halts before next migration", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(join(dir, "001_foo.sql"), "CREATE TABLE foo (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        await writeFile(join(dir, "002_bar.sql"), "CREATE TABLE bar (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        const m = new Migrator({ db, dir });
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(() => m.migrate({ signal: controller.signal }), { name: "AbortError" });
        const foo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get();
        assert.equal(foo, undefined, "aborted before first migration applies");
    });
});

test("Migrator: listApplied() returns entries in id order", async () => {
    await withFixture(async ({ db, dir }) => {
        await writeFile(join(dir, "002_b.sql"), "CREATE TABLE b (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        await writeFile(join(dir, "001_a.sql"), "CREATE TABLE a (id INTEGER NOT NULL PRIMARY KEY) STRICT;");
        const m = new Migrator({ db, dir });
        await m.migrate();
        const applied = m.listApplied();
        assert.deepEqual(applied.map((r) => r.id), ["001_a", "002_b"]);
    });
});
