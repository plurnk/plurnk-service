import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated } from "./_helpers.ts";

const registerKnown = async (db: Db, name: string = "known"): Promise<void> => {
    await (db.test_schemes_register as PrepMethod).run({ name, writable_by: JSON.stringify(["model"]) });
};

test("schemes: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_sp_table_sql as PrepMethod).get<{ sql: string }>({ name: "schemes" });
        assert.match(row?.sql ?? "", /STRICT/);
        assert.match(row?.sql ?? "", /WITHOUT ROWID/);
    } finally { await db.close(); }
});

test("schemes: insert minimal known scheme", async () => {
    const db = await openMigrated();
    try {
        await registerKnown(db);
        const row = await (db.test_schemes_get as PrepMethod).get<{
            name: string; model_visible: number; category: string; default_scope: string; default_channel: string;
            channel_orientations: string | null; writable_by: string; volatile: number; handler: string | null;
        }>({ name: "known" });
        assert.equal(row?.name, "known");
        assert.equal(row?.model_visible, 1);
        assert.equal(row?.category, "knowledge");
        assert.equal(row?.default_scope, "session");
        assert.equal(row?.default_channel, "body");
        assert.equal(row?.channel_orientations, null);
        assert.equal(row?.writable_by, '["model"]');
        assert.equal(row?.volatile, 0);
        assert.equal(row?.handler, null);
    } finally { await db.close(); }
});

test("schemes: PK on name — duplicate registration rejected", async () => {
    const db = await openMigrated();
    try {
        await registerKnown(db);
        await assert.rejects(
            () => registerKnown(db),
            /UNIQUE constraint failed|PRIMARY KEY/,
        );
    } finally { await db.close(); }
});

test("schemes: model_visible + volatile CHECK 0/1", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_schemes_insert_full as PrepMethod).run({
                name: "s_model_visible", model_visible: 2, category: "c", default_scope: "session",
                default_channel: "body", writable_by: "[]", volatile: 0,
            }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => (db.test_schemes_insert_full as PrepMethod).run({
                name: "s_volatile", model_visible: 0, category: "c", default_scope: "session",
                default_channel: "body", writable_by: "[]", volatile: 2,
            }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("schemes: default_scope enum", async () => {
    const db = await openMigrated();
    try {
        await (db.test_schemes_insert_full as PrepMethod).run({ name: "a", model_visible: 1, category: "c", default_scope: "agent", default_channel: "body", writable_by: "[]", volatile: 0 });
        await (db.test_schemes_insert_full as PrepMethod).run({ name: "b", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: "[]", volatile: 0 });
        await assert.rejects(
            () => (db.test_schemes_insert_full as PrepMethod).run({ name: "c", model_visible: 1, category: "c", default_scope: "run", default_channel: "body", writable_by: "[]", volatile: 0 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("schemes: length CHECK on name, category, default_channel", async () => {
    const db = await openMigrated();
    try {
        for (const empty of ["name", "category", "default_channel"] as const) {
            const params = { name: "s", category: "c", default_channel: "body" };
            params[empty] = "";
            await assert.rejects(
                () => (db.test_schemes_insert_full as PrepMethod).run({
                    name: params.name, model_visible: 1, category: params.category, default_scope: "session",
                    default_channel: params.default_channel, writable_by: "[]", volatile: 0,
                }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("schemes: writable_by JSON validity", async () => {
    const db = await openMigrated();
    try {
        await (db.test_schemes_insert_full as PrepMethod).run({ name: "s1", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: JSON.stringify(["model", "client", "plugin"]), volatile: 0 });
        await (db.test_schemes_insert_full as PrepMethod).run({ name: "s2", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: "[]", volatile: 0 });
        await assert.rejects(
            () => (db.test_schemes_insert_full as PrepMethod).run({ name: "s3", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: "{broken", volatile: 0 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("schemes: channel_orientations nullable", async () => {
    const db = await openMigrated();
    try {
        await (db.test_schemes_insert_with_orient as PrepMethod).run({ name: "s_null", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: "[]", volatile: 0, orient: null });
        await (db.test_schemes_insert_with_orient as PrepMethod).run({ name: "sse", model_visible: 1, category: "streaming", default_scope: "session", default_channel: "event", writable_by: "[]", volatile: 1, orient: JSON.stringify({ event: "tail", data: "tail" }) });
        await assert.rejects(
            () => (db.test_schemes_insert_with_orient as PrepMethod).run({ name: "s_bad", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: "[]", volatile: 0, orient: "{broken" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("schemes: handler nullable", async () => {
    const db = await openMigrated();
    try {
        await (db.test_schemes_insert_with_handler as PrepMethod).run({ name: "core", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: "[]", volatile: 0, handler: null });
        await (db.test_schemes_insert_with_handler as PrepMethod).run({ name: "plug", model_visible: 1, category: "c", default_scope: "session", default_channel: "body", writable_by: "[]", volatile: 0, handler: "plurnk:///handlers/plug" });
        const handlers = await (db.test_schemes_list_handlers as PrepMethod).all<{ name: string; handler: string | null }>();
        assert.equal(handlers.find((s) => s.name === "core")?.handler, null);
        assert.equal(handlers.find((s) => s.name === "plug")?.handler, "plurnk:///handlers/plug");
    } finally { await db.close(); }
});

test("providers: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_sp_table_sql as PrepMethod).get<{ sql: string }>({ name: "providers" });
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("providers: insert minimal — defaults populate", async () => {
    const db = await openMigrated();
    try {
        await (db.test_providers_insert as PrepMethod).run({ provider: "anthropic", family: "claude", model: "claude-opus-4-7", contextSize: 200000, currency: "USD" });
        const row = await (db.test_providers_get as PrepMethod).get<{ version: number; provider: string; family: string; model: string; contextSize: number; currency: string; created_at: string }>({ model: "claude-opus-4-7" });
        assert.equal(row?.version, 0);
        assert.equal(row?.provider, "anthropic");
        assert.equal(row?.family, "claude");
        assert.equal(row?.model, "claude-opus-4-7");
        assert.equal(row?.contextSize, 200000);
        assert.equal(row?.currency, "USD");
        assert.match(row?.created_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally { await db.close(); }
});

test("providers: length CHECK on provider, family, model", async () => {
    const db = await openMigrated();
    try {
        for (const empty of ["provider", "family", "model"] as const) {
            const cols = { provider: "anthropic", family: "claude", model: "claude-opus-4-7" };
            cols[empty] = "";
            await assert.rejects(
                () => (db.test_providers_insert as PrepMethod).run({ ...cols, contextSize: 200000, currency: "USD" }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("providers: contextSize CHECK >= 1", async () => {
    const db = await openMigrated();
    try {
        for (const bad of [0, -1, -100]) {
            await assert.rejects(
                () => (db.test_providers_insert as PrepMethod).run({ provider: "anthropic", family: "claude", model: "claude-opus-4-7", contextSize: bad, currency: "USD" }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("providers: currency CHECK length = 3", async () => {
    const db = await openMigrated();
    try {
        for (const bad of ["US", "USDX", "", "AB", "ABCD"]) {
            await assert.rejects(
                () => (db.test_providers_insert as PrepMethod).run({ provider: "anthropic", family: "claude", model: "claude-opus-4-7", contextSize: 200000, currency: bad }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("providers: multiple rows for the same (provider, family, model) allowed", async () => {
    const db = await openMigrated();
    try {
        await (db.test_providers_insert as PrepMethod).run({ provider: "anthropic", family: "claude", model: "claude-opus-4-7", contextSize: 200000, currency: "USD" });
        await (db.test_providers_insert as PrepMethod).run({ provider: "anthropic", family: "claude", model: "claude-opus-4-7", contextSize: 200000, currency: "USD" });
        const count = (await (db.test_providers_count as PrepMethod).get<{ n: number }>({ model: "claude-opus-4-7" }))?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("providers: id auto-assigns", async () => {
    const db = await openMigrated();
    try {
        await (db.test_providers_insert as PrepMethod).run({ provider: "a", family: "b", model: "c", contextSize: 100, currency: "USD" });
        await (db.test_providers_insert as PrepMethod).run({ provider: "a", family: "b", model: "d", contextSize: 100, currency: "USD" });
        const rows = await (db.test_providers_list_ids as PrepMethod).all<{ id: number }>();
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});

test("providers: index providers_created_at exists", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_providers_index as PrepMethod).get<{ name: string }>();
        assert.equal(row?.name, "providers_created_at");
    } finally { await db.close(); }
});
