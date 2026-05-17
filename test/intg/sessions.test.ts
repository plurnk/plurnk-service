import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Migrator from "../../src/core/Migrator.ts";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const openMigrated = async (): Promise<DatabaseSync> => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    await new Migrator({ db, dir: MIGRATIONS_DIR }).migrate();
    return db;
};

test("sessions: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
    } finally { db.close(); }
});

test("sessions: insert with name only — defaults populate version, created_at, cost_pico, scheme_registry_additions", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO sessions (name) VALUES (?)").run("opus-1747400000");
        const row = db.prepare("SELECT * FROM sessions WHERE name = ?").get("opus-1747400000") as {
            id: number;
            version: number;
            name: string;
            created_at: string;
            cost_pico: number;
            scheme_registry_additions: string;
        };
        assert.equal(typeof row.id, "number");
        assert.ok(row.id >= 1);
        assert.equal(row.version, 0);
        assert.equal(row.name, "opus-1747400000");
        assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row.cost_pico, 0);
        assert.equal(row.scheme_registry_additions, "[]");
    } finally { db.close(); }
});

test("sessions: name UNIQUE — duplicate insert is rejected", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO sessions (name) VALUES (?)").run("workspace-a");
        assert.throws(
            () => db.prepare("INSERT INTO sessions (name) VALUES (?)").run("workspace-a"),
            /UNIQUE constraint failed: sessions\.name/,
        );
    } finally { db.close(); }
});

test("sessions: empty name rejected by CHECK (length > 0)", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO sessions (name) VALUES (?)").run(""),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("sessions: negative cost_pico rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO sessions (name, cost_pico) VALUES (?, ?)").run("workspace-b", -1),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("sessions: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO sessions (name, version) VALUES (?, ?)").run("workspace-c", -1),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("sessions: malformed JSON in scheme_registry_additions rejected by CHECK (json_valid)", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO sessions (name, scheme_registry_additions) VALUES (?, ?)").run("workspace-d", "{not json"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("sessions: well-formed JSON object in scheme_registry_additions accepted", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO sessions (name, scheme_registry_additions) VALUES (?, ?)").run(
            "workspace-e",
            JSON.stringify([{ name: "wiki", model_visible: true, category: "external", default_scope: "session", default_channel: "body", writable_by: ["model"], volatile: false, handler: null }]),
        );
        const row = db.prepare("SELECT scheme_registry_additions FROM sessions WHERE name = ?").get("workspace-e") as { scheme_registry_additions: string };
        const parsed = JSON.parse(row.scheme_registry_additions);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].name, "wiki");
    } finally { db.close(); }
});

test("sessions: NOT NULL enforced on name", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.exec("INSERT INTO sessions (cost_pico) VALUES (0)"),
            /NOT NULL constraint failed: sessions\.name/,
        );
    } finally { db.close(); }
});

test("sessions: index sessions_created_at exists", async () => {
    const db = await openMigrated();
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_created_at'").get() as { name: string } | undefined;
        assert.equal(row?.name, "sessions_created_at");
    } finally { db.close(); }
});

test("sessions: explicit cost_pico value overrides default", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO sessions (name, cost_pico) VALUES (?, ?)").run("workspace-f", 12345);
        const row = db.prepare("SELECT cost_pico FROM sessions WHERE name = ?").get("workspace-f") as { cost_pico: number };
        assert.equal(row.cost_pico, 12345);
    } finally { db.close(); }
});

test("sessions: id auto-assigns on insert (INTEGER PRIMARY KEY rowid alias)", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO sessions (name) VALUES (?)").run("workspace-g");
        db.prepare("INSERT INTO sessions (name) VALUES (?)").run("workspace-h");
        const rows = db.prepare("SELECT id, name FROM sessions ORDER BY id").all() as { id: number; name: string }[];
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { db.close(); }
});
