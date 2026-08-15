import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace } from "./_helpers.ts";

const insertWorkspaceEntry = async (db: Db, workspaceId: number, scheme: string, pathname: string): Promise<number> => {
    const row = await db.test_entries_insert_workspace.get<{ id: number }>({ workspace_id: workspaceId, scheme, pathname });
    if (row === undefined) throw new Error("workspace entry insert returned no row");
    return row.id;
};

// Convenience for tests that just need an entry: create a fresh workspace and
// let the fixture assign its reserved commons owner.
const insertEntry = async (db: Db, scheme: string, pathname: string): Promise<number> => {
    const workspaceId = await insertWorkspace(db, `ws-entry-${crypto.randomUUID()}`);
    return insertWorkspaceEntry(db, workspaceId, scheme, pathname);
};

test("entries: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_entries_table_sql.get<{ sql: string }>({ name: "entries" });
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("entries: insert — workspace_id + owner_id populate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-workspace");
        await insertWorkspaceEntry(db, workspaceId, "worker", "foo");
        const row = await db.test_entries_get_first_identity.get<{ workspace_id: number; owner_id: number }>();
        assert.equal(row?.workspace_id, workspaceId);
        assert.ok((row?.owner_id ?? 0) >= 1, "the commons owner is stamped ({§entry-owner})");
    } finally { await db.close(); }
});

test("entries: null workspace_id rejected", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, `ws-${crypto.randomUUID()}`); // a commons owner exists → the constraint under test is the one that fires
        await assert.rejects(
            () => db.test_entries_insert_workspace_no_workspace_id(),
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
        const count = (await db.test_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("entries: workspace_id FK — insert with non-existent workspace rejected", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-fk-owner"); // a commons owner exists → the FK is the failing constraint
        await assert.rejects(
            () => db.test_entries_insert_with_workspace_id_only.run({ workspace_id: 99999, pathname: "/x" }),
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
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 1);
    } finally { await db.close(); }
});

test("entries: a NULL scheme is refused — no identity component may be NULL", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-entry-null-${crypto.randomUUID()}`);
        await assert.rejects(
            () => db.test_entries_insert_workspace.get({ workspace_id: workspaceId, scheme: null, pathname: "config/foo.json" }),
            /NOT NULL constraint failed: entries\.scheme/,
        );
    } finally { await db.close(); }
});

test("entries: empty scheme string rejected", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-empty-scheme");
        await assert.rejects(
            () => db.test_entries_insert_empty_scheme(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: attributes defaults to '{}' and rejects invalid JSON", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, "worker", "a");
        const row = await db.test_entries_get_attributes.get<{ attributes: string }>();
        assert.equal(row?.attributes, "{}");
        await assert.rejects(
            () => db.test_entries_insert_with_attributes.run({ pathname: "/b", attributes: "{bad" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entries: pathname NOT NULL", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-no-pathname");
        await assert.rejects(
            () => db.test_entries_insert_no_pathname(),
            /NOT NULL constraint failed: entries\.pathname/,
        );
    } finally { await db.close(); }
});

test("entries: pathname empty string allowed", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, "worker", "");
        const row = await db.test_entries_get_pathname.get<{ pathname: string }>();
        assert.equal(row?.pathname, "");
    } finally { await db.close(); }
});

test("entries: partial indexes exist", async () => {
    const db = await openMigrated();
    try {
        const indexes = await db.test_entries_partial_indexes.all<{ name: string; sql: string }>();
        const names = indexes.map((i) => i.name).sort();
        assert.deepEqual(names, ["entries_identity"]); // one owner-keyed identity ({§entry-owner})
        for (const idx of indexes) {
            assert.match(idx.sql, /\(workspace_id, owner_id, scheme, pathname\)/);
            assert.match(idx.sql, /UNIQUE/);
        }
    } finally { await db.close(); }
});

test("entry_channels: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_entries_table_sql.get<{ sql: string }>({ name: "entry_channels" });
        assert.match(row?.sql ?? "", /STRICT/);
        assert.match(row?.sql ?? "", /WITHOUT ROWID/);
    } finally { await db.close(); }
});

test("entry_channels: insert channel — defaults populate", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "worker", "france");
        await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "body", content: "Paris is the capital.", mimetype: "text/markdown" });
        const row = await db.test_entry_channels_get_first.get<{ name: string; content: string; mimetype: string; weight: number; state: string }>({ entry_id: entryId });
        assert.equal(row?.name, "body");
        assert.equal(row?.content, "Paris is the capital.");
        assert.equal(row?.mimetype, "text/markdown");
        assert.equal(row?.weight, 0);
        assert.equal(row?.state, "static");
    } finally { await db.close(); }
});

test("entry_channels: (entry_id, name) UNIQUE", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "exec", "ls");
        await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "stdout", content: "a", mimetype: "text/plain" });
        await assert.rejects(
            () => db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "stdout", content: "b", mimetype: "text/plain" }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: content length CHECK enforces 100 MiB char cap (SPEC )", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "worker", "big");
        // Just-under the cap (100 MiB = 104857600 chars) succeeds.
        const justUnder = "a".repeat(104857600);
        await db.test_entry_channels_insert_default.run({
            entry_id: entryId, name: "body", content: justUnder, mimetype: "text/plain",
        });
        // 1 char over the cap fails.
        const justOver = "a".repeat(104857601);
        await assert.rejects(
            () => db.test_entry_channels_insert_default.run({
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
            await db.test_entry_channels_insert_with_state.run({ entry_id: entryId, name: `ch_${state}`, content: "", mimetype: "text/plain", state });
        }
        await assert.rejects(
            () => db.test_entry_channels_insert_with_state.run({ entry_id: entryId, name: "bad", content: "", mimetype: "text/plain", state: "draining" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: producer result is an exact terminal operation result", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "prepared", "/item");
        const producerResult = JSON.stringify({ status: 203, producer: "specimen" });
        await db.test_entry_channels_insert_with_producer_result.run({
            entry_id: entryId,
            name: "body",
            content: "projected",
            mimetype: "text/plain",
            producer_result: producerResult,
        });
        const row = await db.test_entry_channels_get_first.get<{ producer_result: string | null }>({ entry_id: entryId });
        assert.equal(row?.producer_result, producerResult);

        for (const invalid of [
            JSON.stringify({ status: 102 }),
            JSON.stringify({ status: 202 }),
            JSON.stringify({ status: 502 }),
        ]) {
            await assert.rejects(
                db.test_entry_channels_insert_with_producer_result.run({
                    entry_id: entryId,
                    name: `invalid-${JSON.parse(invalid).status}`,
                    content: "",
                    mimetype: "text/plain",
                    producer_result: invalid,
                }),
                /entry_channel_producer_result_contract/,
            );
        }
    } finally { await db.close(); }
});

test("entry_channels: NOT NULL on name, content, mimetype", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "worker", "x");
        await assert.rejects(
            () => db.test_entry_channels_insert_missing_name.run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channels\.name/,
        );
        await assert.rejects(
            () => db.test_entry_channels_insert_missing_content.run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channels\.content/,
        );
        await assert.rejects(
            () => db.test_entry_channels_insert_missing_mimetype.run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channels\.mimetype/,
        );
    } finally { await db.close(); }
});

test("entry_channels: empty name or mimetype rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "worker", "y");
        await assert.rejects(
            () => db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "", content: "", mimetype: "text/plain" }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "body", content: "", mimetype: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: weight negative rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "worker", "z");
        await assert.rejects(
            () => db.test_entry_channels_insert_with_weight.run({ entry_id: entryId, name: "body", content: "", mimetype: "text/plain", weight: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("entry_channels: ON DELETE CASCADE via entry", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "exec", "ls");
        await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "stdout", content: "a", mimetype: "text/plain" });
        await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "stderr", content: "b", mimetype: "text/plain" });
        await db.test_delete_entry.run({ id: entryId });
        const remaining = (await db.test_entry_channels_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("entry_channels: CASCADE chain workspace→entries→entry_channels", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-channels-chain");
        const entryId = await insertWorkspaceEntry(db, workspaceId, "worker", "a");
        await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "body", content: "x", mimetype: "text/plain" });
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_entry_channels_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("entry resources have no tag relation", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_entries_table_sql.get<{ sql: string }>({ name: "entry_tags" });
        assert.equal(row, undefined);
    } finally { await db.close(); }
});
