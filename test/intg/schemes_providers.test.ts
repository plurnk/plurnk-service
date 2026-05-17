import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openMigrated } from "./_helpers.ts";

const registerKnown = (db: DatabaseSync, name: string = "known"): void => {
    db.prepare(
        "INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, handler) VALUES (?, 1, 'knowledge', 'session', 'body', ?, 0, NULL)"
    ).run(name, JSON.stringify(["model"]));
};

// ---------------------------------------------------------------- schemes

test("schemes: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'schemes'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
        assert.match(sql, /WITHOUT ROWID/);
    } finally { db.close(); }
});

test("schemes: insert minimal known scheme", async () => {
    const db = await openMigrated();
    try {
        registerKnown(db);
        const row = db.prepare("SELECT * FROM schemes WHERE name = 'known'").get() as {
            name: string; model_visible: number; category: string; default_scope: string; default_channel: string;
            channel_orientations: string | null; writable_by: string; volatile: number; handler: string | null;
        };
        assert.equal(row.name, "known");
        assert.equal(row.model_visible, 1);
        assert.equal(row.category, "knowledge");
        assert.equal(row.default_scope, "session");
        assert.equal(row.default_channel, "body");
        assert.equal(row.channel_orientations, null);
        assert.equal(row.writable_by, '["model"]');
        assert.equal(row.volatile, 0);
        assert.equal(row.handler, null);
    } finally { db.close(); }
});

test("schemes: PK on name — duplicate registration rejected", async () => {
    const db = await openMigrated();
    try {
        registerKnown(db);
        assert.throws(
            () => registerKnown(db),
            /UNIQUE constraint failed|PRIMARY KEY/,
        );
    } finally { db.close(); }
});

test("schemes: model_visible + volatile CHECK 0/1 — other values rejected", async () => {
    const db = await openMigrated();
    try {
        for (const field of ["model_visible", "volatile"]) {
            assert.throws(
                () => db.prepare(`INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES ('s_${field}', ?, 'c', 'session', 'body', '[]', ?)`).run(field === "model_visible" ? 2 : 0, field === "volatile" ? 2 : 0),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("schemes: default_scope enum — agent + session accepted, others rejected", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES ('a', 1, 'c', 'agent', 'body', '[]', 0)").run();
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES ('b', 1, 'c', 'session', 'body', '[]', 0)").run();
        assert.throws(
            () => db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES ('c', 1, 'c', 'run', 'body', '[]', 0)").run(),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("schemes: length CHECK on name, category, default_channel — empty rejected", async () => {
    const db = await openMigrated();
    try {
        for (const empty of ["name", "category", "default_channel"]) {
            const values = ["s", "c", "body"].map((v, i) => (["name", "category", "default_channel"][i] === empty ? "" : v));
            assert.throws(
                () => db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES (?, 1, ?, 'session', ?, '[]', 0)").run(...values),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("schemes: writable_by JSON validity — invalid JSON rejected; valid JSON arrays accepted", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES ('s1', 1, 'c', 'session', 'body', ?, 0)").run(JSON.stringify(["model", "client", "plugin"]));
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES ('s2', 1, 'c', 'session', 'body', ?, 0)").run("[]");
        assert.throws(
            () => db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile) VALUES ('s3', 1, 'c', 'session', 'body', ?, 0)").run("{broken"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("schemes: channel_orientations nullable — null + valid JSON accepted; invalid JSON rejected", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, channel_orientations) VALUES ('s_null', 1, 'c', 'session', 'body', '[]', 0, NULL)").run();
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, channel_orientations) VALUES ('sse', 1, 'streaming', 'session', 'event', '[]', 1, ?)").run(JSON.stringify({ event: "tail", data: "tail" }));
        assert.throws(
            () => db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, channel_orientations) VALUES ('s_bad', 1, 'c', 'session', 'body', '[]', 0, ?)").run("{broken"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("schemes: handler nullable — null + non-null both accepted", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, handler) VALUES ('core', 1, 'c', 'session', 'body', '[]', 0, NULL)").run();
        db.prepare("INSERT INTO schemes (name, model_visible, category, default_scope, default_channel, writable_by, volatile, handler) VALUES ('plug', 1, 'c', 'session', 'body', '[]', 0, ?)").run("plurnk://handlers/plug");
        const handlers = db.prepare("SELECT name, handler FROM schemes ORDER BY name").all() as { name: string; handler: string | null }[];
        assert.equal(handlers.find((s) => s.name === "core")?.handler, null);
        assert.equal(handlers.find((s) => s.name === "plug")?.handler, "plurnk://handlers/plug");
    } finally { db.close(); }
});

// ---------------------------------------------------------------- providers

test("providers: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'providers'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
    } finally { db.close(); }
});

test("providers: insert minimal — defaults populate version=0, created_at", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES (?, ?, ?, ?, ?)")
            .run("anthropic", "claude", "claude-opus-4-7", 200000, "USD");
        const row = db.prepare("SELECT * FROM providers WHERE model = ?").get("claude-opus-4-7") as {
            id: number; version: number; provider: string; family: string; model: string; contextSize: number; currency: string; created_at: string;
        };
        assert.equal(row.version, 0);
        assert.equal(row.provider, "anthropic");
        assert.equal(row.family, "claude");
        assert.equal(row.model, "claude-opus-4-7");
        assert.equal(row.contextSize, 200000);
        assert.equal(row.currency, "USD");
        assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally { db.close(); }
});

test("providers: length CHECK on provider, family, model — empty rejected", async () => {
    const db = await openMigrated();
    try {
        for (const empty of ["provider", "family", "model"] as const) {
            const cols = { provider: "anthropic", family: "claude", model: "claude-opus-4-7" };
            cols[empty] = "";
            assert.throws(
                () => db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES (?, ?, ?, ?, ?)").run(cols.provider, cols.family, cols.model, 200000, "USD"),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("providers: contextSize CHECK >= 1 — 0 and negative rejected", async () => {
    const db = await openMigrated();
    try {
        for (const bad of [0, -1, -100]) {
            assert.throws(
                () => db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES (?, ?, ?, ?, ?)").run("anthropic", "claude", "claude-opus-4-7", bad, "USD"),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("providers: currency CHECK length = 3 — other lengths rejected", async () => {
    const db = await openMigrated();
    try {
        for (const bad of ["US", "USDX", "", "AB", "ABCD"]) {
            assert.throws(
                () => db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES (?, ?, ?, ?, ?)").run("anthropic", "claude", "claude-opus-4-7", 200000, bad),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("providers: multiple rows for the same (provider, family, model) are allowed — represents hot-swap history", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES ('anthropic', 'claude', 'claude-opus-4-7', 200000, 'USD')").run();
        db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES ('anthropic', 'claude', 'claude-opus-4-7', 200000, 'USD')").run();
        const count = (db.prepare("SELECT COUNT(*) AS n FROM providers WHERE model = ?").get("claude-opus-4-7") as { n: number }).n;
        assert.equal(count, 2);
    } finally { db.close(); }
});

test("providers: id auto-assigns (INTEGER PRIMARY KEY rowid alias)", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES ('a', 'b', 'c', 100, 'USD')").run();
        db.prepare("INSERT INTO providers (provider, family, model, contextSize, currency) VALUES ('a', 'b', 'd', 100, 'USD')").run();
        const rows = db.prepare("SELECT id FROM providers ORDER BY id").all() as { id: number }[];
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { db.close(); }
});

test("providers: index providers_created_at exists", async () => {
    const db = await openMigrated();
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='providers_created_at'").get() as { name: string } | undefined;
        assert.equal(row?.name, "providers_created_at");
    } finally { db.close(); }
});
