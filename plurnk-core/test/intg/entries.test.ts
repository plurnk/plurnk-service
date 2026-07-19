import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod, ExecMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace } from "./_helpers.ts";

const insertWorkspaceEntry = async (db: Db, workspaceId: number, scheme: string | null, pathname: string): Promise<number> => {
    const row = await (db.test_entries_insert_session as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, scheme, pathname });
    if (row === undefined) throw new Error("workspace entry insert returned no row");
    return row.id;
};

// Convenience for tests that just need "an entry" — agent-scope (the old workspaceless shortcut)
// is gone, so this gives a workspace-scope entry on its own fresh workspace.
const insertEntry = async (db: Db, scheme: string | null, pathname: string): Promise<number> => {
    const workspaceId = await insertWorkspace(db, `ws-entry-${crypto.randomUUID()}`);
    return insertWorkspaceEntry(db, workspaceId, scheme, pathname);
};

test("entries: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_entries_table_sql as PrepMethod).get<{ sql: string }>({ name: "entries" });
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("entries: insert — workspace_id + owner_id populate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-workspace");
        await insertWorkspaceEntry(db, workspaceId, "worker", "foo");
        const row = await (db.test_entries_get_first_scope_session as PrepMethod).get<{ workspace_id: number; owner_id: number }>();
        assert.equal(row?.workspace_id, workspaceId);
        assert.ok((row?.owner_id ?? 0) >= 1, "the commons owner is stamped ({§entry-owner})");
    } finally { await db.close(); }
});

test("entries: null workspace_id rejected", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, `ws-${crypto.randomUUID()}`); // a commons owner exists → the constraint under test is the one that fires
        await assert.rejects(
            () => (db.test_entries_insert_session_no_workspace_id as ExecMethod)(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: identity UNIQUE — duplicate rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-dupid");
        await insertWorkspaceEntry(db, workspaceId, "worker", "france");
        await assert.rejects(
            () => insertWorkspaceEntry(db, workspaceId, "worker", "france"),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: cross-workspace same (scheme, pathname) is allowed", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-entries-sessA");
        const workspaceB = await insertWorkspace(db, "ws-entries-sessB");
        await insertWorkspaceEntry(db, workspaceA, "worker", "france");
        await insertWorkspaceEntry(db, workspaceB, "worker", "france");
        const count = (await (db.test_entries_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("entries: workspace_id FK — insert with non-existent workspace rejected", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-fk-owner"); // a commons owner exists → the FK is the failing constraint
        await assert.rejects(
            () => (db.test_entries_insert_with_workspace_id_only as PrepMethod).run({ workspace_id: 99999, pathname: "/x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: ON DELETE CASCADE via workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-cascade");
        await insertWorkspaceEntry(db, workspaceId, "worker", "a");
        await insertWorkspaceEntry(db, workspaceId, "worker", "b");
        await insertEntry(db, "worker", "c");
        await (db.test_sessions_delete as PrepMethod).run({ id: workspaceId });
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
        await insertWorkspace(db, "ws-empty-scheme");
        await assert.rejects(
            () => (db.test_entries_insert_empty_scheme as ExecMethod)(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: port range CHECK", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-port");
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
        await insertWorkspace(db, "ws-params");
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
        await insertEntry(db, "worker", "a");
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
        await insertWorkspace(db, "ws-no-pathname");
        await assert.rejects(
            () => (db.test_entries_insert_no_pathname as ExecMethod)(),
            /NOT NULL constraint failed: entries\.pathname/,
        );
    } finally { await db.close(); }
});

test("entries: pathname empty string allowed", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, "worker", "");
        const row = await (db.test_entries_get_pathname as PrepMethod).get<{ pathname: string }>();
        assert.equal(row?.pathname, "");
    } finally { await db.close(); }
});

test("entries: partial indexes exist", async () => {
    const db = await openMigrated();
    try {
        const indexes = await (db.test_entries_partial_indexes as PrepMethod).all<{ name: string; sql: string }>();
        const names = indexes.map((i) => i.name).sort();
        assert.deepEqual(names, ["entries_identity"]); // ONE owner-keyed identity ({§entry-owner}) — scope is dead
        for (const idx of indexes) {
            assert.match(idx.sql, /\(workspace_id, owner_id, scheme, pathname\)/);
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
        const entryId = await insertEntry(db, "worker", "france");
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
        const entryId = await insertEntry(db, "worker", "big");
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
        const entryId = await insertEntry(db, "worker", "x");
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
        const entryId = await insertEntry(db, "worker", "y");
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
        const entryId = await insertEntry(db, "worker", "z");
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

test("entry_channels: CASCADE chain workspace→entries→entry_channels", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-channels-chain");
        const entryId = await insertWorkspaceEntry(db, workspaceId, "worker", "a");
        await (db.test_entry_channels_insert_default as PrepMethod).run({ entry_id: entryId, name: "body", content: "x", mimetype: "text/plain" });
        await (db.test_sessions_delete as PrepMethod).run({ id: workspaceId });
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
        const entryId = await insertEntry(db, "worker", "france");
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
        const a = await insertEntry(db, "worker", "france");
        const b = await insertEntry(db, "worker", "germany");
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: a, tag: "geography" });
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: b, tag: "geography" });
        const count = (await (db.test_entry_tags_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("entry_tags: empty tag rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "worker", "france");
        await assert.rejects(
            () => (db.test_entry_tags_insert as PrepMethod).run({ entry_id: entryId, tag: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_tags: ON DELETE CASCADE via entry", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "worker", "france");
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
        const a = await insertEntry(db, "worker", "france");
        const b = await insertEntry(db, "worker", "germany");
        const c = await insertEntry(db, "worker", "japan");
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: a, tag: "europe" });
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: b, tag: "europe" });
        await (db.test_entry_tags_insert as PrepMethod).run({ entry_id: c, tag: "asia" });
        const europeEntries = await (db.test_entry_tags_by_tag as PrepMethod).all<{ entry_id: number }>({ tag: "europe" });
        assert.deepEqual(europeEntries.map((e) => e.entry_id).toSorted(), [a, b].toSorted());
        const idxRow = await (db.test_entry_tags_index as PrepMethod).get<{ name: string }>();
        assert.equal(idxRow?.name, "entry_tags_tag");
    } finally { await db.close(); }
});
