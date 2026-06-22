import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod, ExecMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession } from "./_helpers.ts";

const insertSessionEntry = async (db: Db, sessionId: number, scheme: string | null, pathname: string): Promise<number> => {
    const row = await (db.test_entries_insert_session as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
    if (row === undefined) throw new Error("session entry insert returned no row");
    return row.id;
};

// Convenience for tests that just need "an entry" — agent-scope (the old sessionless shortcut)
// is gone, so this gives a session-scope entry on its own fresh session.
const insertEntry = async (db: Db, scheme: string | null, pathname: string): Promise<number> => {
    const sessionId = await insertSession(db, `ws-entry-${crypto.randomUUID()}`);
    return insertSessionEntry(db, sessionId, scheme, pathname);
};

test("entries: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_entries_table_sql as PrepMethod).get<{ sql: string }>({ name: "entries" });
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("entries: session-scoped insert — session_id required", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-entries-session");
        await insertSessionEntry(db, sessionId, "known", "foo");
        const row = await (db.test_entries_get_first_scope_session as PrepMethod).get<{ scope: string; session_id: number }>();
        assert.equal(row?.scope, "session");
        assert.equal(row?.session_id, sessionId);
    } finally { await db.close(); }
});

test("entries: scope='session' with null session_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_entries_insert_session_no_session_id as ExecMethod)(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: scope value outside enum rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_entries_insert_bad_scope as ExecMethod)(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: session-scope identity UNIQUE — duplicate rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-entries-dupid");
        await insertSessionEntry(db, sessionId, "known", "france");
        await assert.rejects(
            () => insertSessionEntry(db, sessionId, "known", "france"),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: cross-session same (scheme, pathname) is allowed", async () => {
    const db = await openMigrated();
    try {
        const sessionA = await insertSession(db, "ws-entries-sessA");
        const sessionB = await insertSession(db, "ws-entries-sessB");
        await insertSessionEntry(db, sessionA, "known", "france");
        await insertSessionEntry(db, sessionB, "known", "france");
        const count = (await (db.test_entries_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("entries: session_id FK — insert with non-existent session rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_entries_insert_with_session_id_only as PrepMethod).run({ session_id: 99999, pathname: "/x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: ON DELETE CASCADE via session", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-entries-cascade");
        await insertSessionEntry(db, sessionId, "known", "a");
        await insertSessionEntry(db, sessionId, "known", "b");
        await insertEntry(db, "known", "c");
        await (db.test_sessions_delete as PrepMethod).run({ id: sessionId });
        const remaining = (await (db.test_entries_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(remaining, 1);
    } finally { await db.close(); }
});

test("entries: scheme can be null", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, null, "config/foo.json");
        const row = await (db.test_entries_get_scheme as PrepMethod).get<{ scheme: string | null }>();
        assert.equal(row?.scheme, null);
    } finally { await db.close(); }
});

test("entries: empty scheme string rejected", async () => {
    const db = await openMigrated();
    try {
        await insertSession(db, "ws-empty-scheme");
        await assert.rejects(
            () => (db.test_entries_insert_empty_scheme as ExecMethod)(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: port range CHECK", async () => {
    const db = await openMigrated();
    try {
        await insertSession(db, "ws-port");
        await (db.test_entries_insert_with_port as PrepMethod).run({ scheme: "https", hostname: "example.com", port: 443, pathname: "/x" });
        await (db.test_entries_insert_with_port as PrepMethod).run({ scheme: "https", hostname: "example.com", port: 0, pathname: "/y" });
        await (db.test_entries_insert_with_port as PrepMethod).run({ scheme: "https", hostname: "example.com", port: 65535, pathname: "/z" });
        await assert.rejects(
            () => (db.test_entries_insert_with_port as PrepMethod).run({ scheme: "https", hostname: "example.com", port: 65536, pathname: "/w" }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => (db.test_entries_insert_with_port as PrepMethod).run({ scheme: "https", hostname: "example.com", port: -1, pathname: "/v" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: params null/well-formed accepted; invalid JSON rejected", async () => {
    const db = await openMigrated();
    try {
        await insertSession(db, "ws-params");
        await (db.test_entries_insert_with_params as PrepMethod).run({ pathname: "/a", params: null });
        await (db.test_entries_insert_with_params as PrepMethod).run({ pathname: "/b", params: '{"q":["x"],"page":"2"}' });
        await assert.rejects(
            () => (db.test_entries_insert_with_params as PrepMethod).run({ pathname: "/c", params: "{not json" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: attributes defaults to '{}' and rejects invalid JSON", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, "known", "a");
        const row = await (db.test_entries_get_attributes as PrepMethod).get<{ attributes: string }>();
        assert.equal(row?.attributes, "{}");
        await assert.rejects(
            () => (db.test_entries_insert_with_attributes as PrepMethod).run({ pathname: "/b", attributes: "{bad" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: pathname NOT NULL", async () => {
    const db = await openMigrated();
    try {
        await insertSession(db, "ws-no-pathname");
        await assert.rejects(
            () => (db.test_entries_insert_no_pathname as ExecMethod)(),
            /NOT NULL constraint failed: entries\.pathname/,
        );
    } finally { await db.close(); }
});

test("entries: pathname empty string allowed", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, "known", "");
        const row = await (db.test_entries_get_pathname as PrepMethod).get<{ pathname: string }>();
        assert.equal(row?.pathname, "");
    } finally { await db.close(); }
});

test("entries: partial indexes exist", async () => {
    const db = await openMigrated();
    try {
        const indexes = await (db.test_entries_partial_indexes as PrepMethod).all<{ name: string; sql: string }>();
        const names = indexes.map((i) => i.name).sort();
        assert.deepEqual(names, ["entries_run_identity", "entries_session_identity"]);
        for (const idx of indexes) {
            assert.match(idx.sql, /WHERE scope = '(session|run)'/); // the session + run identity partials
            assert.match(idx.sql, /UNIQUE/);
        }
    } finally { await db.close(); }
});

test("entry_channels: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_entries_table_sql as PrepMethod).get<{ sql: string }>({ name: "entry_channels" });
        assert.match(row?.sql ?? "", /STRICT/);
        assert.match(row?.sql ?? "", /WITHOUT ROWID/);
    } finally { await db.close(); }
});

test("entry_channels: insert channel — defaults populate", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "france");
        await (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "body", content: "Paris is the capital.", mimetype: "text/markdown" });
        const row = await (db.test_entry_channels_get_first as PrepMethod).get<{ name: string; content: string; mimetype: string; tokens: number; state: string }>({ entry_id: entryId });
        assert.equal(row?.name, "body");
        assert.equal(row?.content, "Paris is the capital.");
        assert.equal(row?.mimetype, "text/markdown");
        assert.equal(row?.tokens, 0);
        assert.equal(row?.state, "static");
    } finally { await db.close(); }
});

test("entry_channels: (entry_id, name) UNIQUE", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "exec", "ls");
        await (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "stdout", content: "a", mimetype: "text/plain" });
        await assert.rejects(
            () => (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "stdout", content: "b", mimetype: "text/plain" }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: content length CHECK enforces 100 MiB char cap (SPEC §stream-constraints)", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "big");
        // Just-under the cap (100 MiB = 104857600 chars) succeeds.
        const justUnder = "a".repeat(104857600);
        await (db.test_entry_channels_insert_default as PrepMethod).run({
            entry_id: entryId, name: "body", content: justUnder, mimetype: "text/plain",
        });
        // 1 char over the cap fails.
        const justOver = "a".repeat(104857601);
        await assert.rejects(
            () => (db.test_entry_channels_insert_default as PrepMethod).run({
                entry_id: entryId, name: "body2", content: justOver, mimetype: "text/plain",
            }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: state enum CHECK", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "sse", "feed");
        for (const state of ["static", "active", "closed", "errored"]) {
            await (db.test_entry_channels_insert_with_state as PrepMethod).run({ entry_id: entryId, name: `ch_${state}`, content: "", mimetype: "text/plain", state });
        }
        await assert.rejects(
            () => (db.test_entry_channels_insert_with_state as PrepMethod).run({ entry_id: entryId, name: "bad", content: "", mimetype: "text/plain", state: "draining" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: NOT NULL on name, content, mimetype", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "x");
        await assert.rejects(
            () => (db.test_entry_channels_insert_missing_name as PrepMethod).run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channels\.name/,
        );
        await assert.rejects(
            () => (db.test_entry_channels_insert_missing_content as PrepMethod).run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channels\.content/,
        );
        await assert.rejects(
            () => (db.test_entry_channels_insert_missing_mimetype as PrepMethod).run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channels\.mimetype/,
        );
    } finally { await db.close(); }
});

test("entry_channels: empty name or mimetype rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "y");
        await assert.rejects(
            () => (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "", content: "", mimetype: "text/plain" }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "body", content: "", mimetype: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: tokens negative rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "z");
        await assert.rejects(
            () => (db.test_entry_channels_insert_with_tokens as PrepMethod).run({ entry_id: entryId, name: "body", content: "", mimetype: "text/plain", tokens: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: ON DELETE CASCADE via entry", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "exec", "ls");
        await (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "stdout", content: "a", mimetype: "text/plain" });
        await (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "stderr", content: "b", mimetype: "text/plain" });
        await (db.test_delete_entry as PrepMethod).run({ id: entryId });
        const remaining = (await (db.test_entry_channels_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("entry_channels: CASCADE chain session→entries→entry_channels", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-channels-chain");
        const entryId = await insertSessionEntry(db, sessionId, "known", "a");
        await (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "body", content: "x", mimetype: "text/plain" });
        await (db.test_sessions_delete as PrepMethod).run({ id: sessionId });
        const remaining = (await (db.test_entry_channels_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("entry_tags: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_entries_table_sql as PrepMethod).get<{ sql: string }>({ name: "entry_tags" });
        assert.match(row?.sql ?? "", /STRICT/);
        assert.match(row?.sql ?? "", /WITHOUT ROWID/);
    } finally { await db.close(); }
});

test("entry_tags: (entry_id, tag) UNIQUE", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "france");
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: entryId, tag: "geography" });
        await assert.rejects(
            () => (db.test_entry_tags_insert as PrepMethod).run({ entry_id: entryId, tag: "geography" }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_tags: same tag on different entries is fine", async () => {
    const db = await openMigrated();
    try {
        const a = await insertEntry(db, "known", "france");
        const b = await insertEntry(db, "known", "germany");
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: a, tag: "geography" });
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: b, tag: "geography" });
        const count = (await (db.test_entry_tags_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("entry_tags: empty tag rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "france");
        await assert.rejects(
            () => (db.test_entry_tags_insert as PrepMethod).run({ entry_id: entryId, tag: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_tags: ON DELETE CASCADE via entry", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "known", "france");
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: entryId, tag: "geography" });
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: entryId, tag: "europe" });
        await (db.test_delete_entry as PrepMethod).run({ id: entryId });
        const remaining = (await (db.test_entry_tags_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("entry_tags: index entry_tags_tag enables tag-filter lookups", async () => {
    const db = await openMigrated();
    try {
        const a = await insertEntry(db, "known", "france");
        const b = await insertEntry(db, "known", "germany");
        const c = await insertEntry(db, "known", "japan");
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: a, tag: "europe" });
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: b, tag: "europe" });
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: c, tag: "asia" });
        const europeEntries = await (db.test_entry_tags_by_tag as PrepMethod).all<{ entry_id: number }>({ tag: "europe" });
        assert.deepEqual(europeEntries.map((e) => e.entry_id).toSorted(), [a, b].toSorted());
        const idxRow = await (db.test_entry_tags_index as PrepMethod).get<{ name: string }>();
        assert.equal(idxRow?.name, "entry_tags_tag");
    } finally { await db.close(); }
});
