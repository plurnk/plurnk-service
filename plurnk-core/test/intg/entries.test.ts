import test from "node:test";
import assert from "node:assert/strict";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace } from "./_db.ts";

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

test("{§entry-owner} entries: owner derives its workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-workspace");
        await insertWorkspaceEntry(db, workspaceId, "session", "foo");
        const row = await db.test_entries_get_first_identity.get<{ workspace_id: number }>();
        assert.equal(row?.workspace_id, workspaceId);
        assert.ok((row?.workspace_id ?? 0) >= 1, "the commons owner is stamped ({§entry-owner})");
    } finally { await db.close(); }
});

test("{§entry-owner} entries: owner is required", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, `ws-${crypto.randomUUID()}`); // a commons owner exists → the constraint under test is the one that fires
        await assert.rejects(
            () => db.test_entries_insert_no_workspace(),
            /NOT NULL constraint failed: entries\.workspace_id/,
        );
    } finally { await db.close(); }
});

test("{§entry-identity-no-null} entries: identity UNIQUE — duplicate rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-dupid");
        await insertWorkspaceEntry(db, workspaceId, "session", "france");
        await assert.rejects(
            () => insertWorkspaceEntry(db, workspaceId, "session", "france"),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§entry-identity-no-null} entries: authority is a durable identity component", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-entry-authority-${crypto.randomUUID()}`);
        const insert = (authority: string) => db.test_entries_insert_workspace_coordinate.get({
            workspace_id: workspaceId,
            scheme: "https",
            authority,
            pathname: "/same",
        });
        await insert("one.example");
        await insert("two.example");
        assert.equal((await db.test_entries_count_all.get<{ n: number }>())?.n, 2, "two authorities may own the same pathname");
        await assert.rejects(() => insert("one.example"), /UNIQUE constraint failed/, "the exact resource coordinate remains unique");
    } finally { await db.close(); }
});

test("{§entry-identity-no-null} entries: cross-workspace same (scheme, authority, pathname) is allowed", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-entries-sessA");
        const workspaceB = await insertWorkspace(db, "ws-entries-sessB");
        await insertWorkspaceEntry(db, workspaceA, "session", "france");
        await insertWorkspaceEntry(db, workspaceB, "session", "france");
        const count = (await db.test_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("{§entry-owner} entries: workspace FK rejects a non-existent workspace", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_entries_insert_with_workspace_id_only.run({ workspace_id: 99999, pathname: "/x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§entry-owner} entries: ON DELETE CASCADE via workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-cascade");
        await insertWorkspaceEntry(db, workspaceId, "session", "a");
        await insertWorkspaceEntry(db, workspaceId, "session", "b");
        await insertEntry(db, "session", "c");
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 1);
    } finally { await db.close(); }
});

test("{§entry-identity-no-null} entries: a NULL scheme is refused — no identity component may be NULL", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-entry-null-${crypto.randomUUID()}`);
        await assert.rejects(
            () => db.test_entries_insert_workspace.get({ workspace_id: workspaceId, scheme: null, pathname: "config/foo.json" }),
            /NOT NULL constraint failed: entries\.scheme/,
        );
    } finally { await db.close(); }
});

test("{§entry-identity-no-null} entries: authority defaults to empty and rejects NULL", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-entry-authority-null-${crypto.randomUUID()}`);
        await db.test_entries_insert_workspace.get({
            workspace_id: workspaceId,
            scheme: "workspace",
            pathname: "/default",
        });
        assert.equal((await db.test_entries_get_authority.get<{ authority: string }>())?.authority, "");
        await assert.rejects(
            () => db.test_entries_insert_null_authority(),
            /NOT NULL constraint failed: entries\.authority/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} entries: empty scheme string rejected", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-empty-scheme");
        await assert.rejects(
            () => db.test_entries_insert_empty_scheme(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} entries: attributes defaults to '{}' and rejects invalid JSON", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, "session", "a");
        const row = await db.test_entries_get_attributes.get<{ attributes: string }>();
        assert.equal(row?.attributes, "{}");
        await assert.rejects(
            () => db.test_entries_insert_with_attributes.run({ pathname: "/b", attributes: "{bad" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§entry-identity-no-null} entries: pathname NOT NULL", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-no-pathname");
        await assert.rejects(
            () => db.test_entries_insert_no_pathname(),
            /NOT NULL constraint failed: entries\.pathname/,
        );
    } finally { await db.close(); }
});

test("{§entry-identity-no-null} entries: pathname empty string allowed", async () => {
    const db = await openMigrated();
    try {
        await insertEntry(db, "session", "");
        const row = await db.test_entries_get_pathname.get<{ pathname: string }>();
        assert.equal(row?.pathname, "");
    } finally { await db.close(); }
});

test("{§channels} entry_channels: (entry_id, name) UNIQUE", async () => {
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

test("{§stream-constraints} entry_channels: content length CHECK enforces 100 MiB char cap", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "session", "big");
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

test("{§channels} entry_channels: state enum CHECK", async () => {
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

test("{§validation-topology} entry_channels: producer result is an exact terminal operation result", async () => {
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

test("{§validation-topology} entry_channels: NOT NULL on name, content, mimetype", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "session", "x");
        await assert.rejects(
            () => db.test_entry_channels_insert_missing_name.run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channel_rows\.name/,
        );
        await assert.rejects(
            () => db.test_entry_channels_insert_missing_content.run({ entry_id: entryId }),
            /a channel requires content/,
        );
        await assert.rejects(
            () => db.test_entry_channels_insert_missing_mimetype.run({ entry_id: entryId }),
            /NOT NULL constraint failed: entry_channel_rows\.mimetype/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} entry_channels: empty name or mimetype rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "session", "y");
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

test("{§validation-topology} entry_channels: weight negative rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "session", "z");
        await assert.rejects(
            () => db.test_entry_channels_insert_with_weight.run({ entry_id: entryId, name: "body", content: "", mimetype: "text/plain", weight: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} entry_channels: ON DELETE CASCADE via entry", async () => {
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

test("{§entry-owner} entry_channels: CASCADE chain workspace→entries→entry_channels", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-channels-chain");
        const entryId = await insertWorkspaceEntry(db, workspaceId, "session", "a");
        await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "body", content: "x", mimetype: "text/plain" });
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_entry_channels_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§logical-line-count} entry resources have no tag relation", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_entries_table_sql.get<{ sql: string }>({ name: "entry_tags" });
        assert.equal(row, undefined);
    } finally { await db.close(); }
});

// {§logical-line-count} — `entry_channels.lines` is the persisted mirror of the one line count: the
// trigger expression and `TextCoordinates.lineCount` agree on every shape, at insert and at
// update ({§tokenomics-weight-stored-at-write}).
const LINE_CORPUS: ReadonlyArray<readonly [label: string, content: string]> = [
    ["empty", ""],
    ["no trailing newline", "a\nb"],
    ["trailing newline", "a\nb\n"],
    ["CRLF", "a\r\nb\r\n"],
    ["one newline", "\n"],
    ["blank lines", "a\n\n\nb\n"],
    ["a final line without newline after blank lines", "a\n\n\nb"],
];

const storedLines = async (db: Db, entryId: number, content: string): Promise<{ inserted: number; updated: number }> => {
    await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "body", content: "seed", mimetype: "text/plain" });
    await db.test_set_channel_content.run({ entry_id: entryId, content });
    const updated = (await db.test_entry_channels_get_lines.get<{ lines: number }>({ entry_id: entryId, name: "body" }))!.lines;
    await db.test_entry_channels_insert_default.run({ entry_id: entryId, name: "fresh", content, mimetype: "text/plain" });
    const inserted = (await db.test_entry_channels_get_lines.get<{ lines: number }>({ entry_id: entryId, name: "fresh" }))!.lines;
    return { inserted, updated };
};

test("{§logical-line-count} entry_channels: the stored line count mirrors TextCoordinates.lineCount on every LF shape", async () => {
    const db = await openMigrated();
    try {
        for (const [label, content] of LINE_CORPUS) {
            const entryId = await insertEntry(db, "session", `/lines/${crypto.randomUUID()}`);
            const expected = TextCoordinates.lineCount(content);
            const { inserted, updated } = await storedLines(db, entryId, content);
            assert.equal(inserted, expected, `${label}: insert trigger`);
            assert.equal(updated, expected, `${label}: update trigger`);
        }
    } finally { await db.close(); }
});

// {§logical-line-count} — a lone CR breaks a line; `005_entries` counts it.
test("{§logical-line-count} entry_channels: the stored line count mirrors TextCoordinates.lineCount on a lone CR", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "session", "/lines/lone-cr");
        const { inserted, updated } = await storedLines(db, entryId, "a\rb\r");
        assert.equal(inserted, TextCoordinates.lineCount("a\rb\r"), "lone CR: insert trigger");
        assert.equal(updated, TextCoordinates.lineCount("a\rb\r"), "lone CR: update trigger");
    } finally { await db.close(); }
});
