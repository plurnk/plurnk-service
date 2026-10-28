import test, { describe } from "node:test";
import assert from "node:assert/strict";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Session from "../../src/schemes/Session.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SqlRiteCore from "@possumtech/sqlrite/core";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { TextCoordinates, Mimetypes, discover } from "@plurnk/plurnk-mimetypes";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertLoop, insertTurn, insertSession } from "./_db.ts";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testArtifactPath } from "../../../scripts/lib/test-artifacts.ts";
import { Digest, DigestRender } from "@plurnk/plurnk-digest";
import { type SchemeManifest } from "../../src/core/scheme-types.ts";
import { createRequire } from "node:module";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { launch } from "./_launcher.ts";
import { seedDemoFixture } from "./_demo-fixture.ts";
import { routeAdvisories, rootsFor } from "../../scripts/deps-audit.ts";
import { makeSchemeCtx } from "./_scheme.ts";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- {§db-migrations}: witness reads sqlite_master and plans registry SQL; no persistence happens outside SqlRite.
import { DatabaseSync } from "node:sqlite";
import { sqlFunctionPaths } from "../../src/core/sql-functions.ts";
import { InvalidOperationResultError, Results, type ChannelProducerResult, type ProblemDetails } from "@plurnk/plurnk-schemes";

describe("entries", () => {
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

test("{§execution-output-identity} entries: owner derives its workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-entries-workspace");
        await insertWorkspaceEntry(db, workspaceId, "session", "foo");
        const row = await db.test_entries_get_first_identity.get<{ workspace_id: number }>();
        assert.equal(row?.workspace_id, workspaceId);
        assert.ok((row?.workspace_id ?? 0) >= 1, "the commons owner is stamped ({§execution-output-identity})");
    } finally { await db.close(); }
});

test("{§execution-output-identity} entries: owner is required", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, `ws-${crypto.randomUUID()}`); // a commons owner exists → the constraint under test is the one that fires
        await assert.rejects(
            () => db.test_entries_insert_no_workspace(),
            /NOT NULL constraint failed: entries\.workspace_id/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} entries: identity UNIQUE — duplicate rejected", async () => {
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

test("{§db-migrations} entries: authority is a durable identity component", async () => {
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

test("{§db-migrations} entries: cross-workspace same (scheme, authority, pathname) is allowed", async () => {
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

test("{§execution-output-identity} entries: workspace FK rejects a non-existent workspace", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_entries_insert_with_workspace_id_only.run({ workspace_id: 99999, pathname: "/x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§execution-output-identity} entries: ON DELETE CASCADE via workspace", async () => {
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

test("{§db-migrations} entries: a NULL scheme is refused — no identity component may be NULL", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-entry-null-${crypto.randomUUID()}`);
        await assert.rejects(
            () => db.test_entries_insert_workspace.get({ workspace_id: workspaceId, scheme: null, pathname: "config/foo.json" }),
            /NOT NULL constraint failed: entries\.scheme/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} entries: authority defaults to empty and rejects NULL", async () => {
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

test("{§db-migrations} entries: empty scheme string rejected", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-empty-scheme");
        await assert.rejects(
            () => db.test_entries_insert_empty_scheme(),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} entries: attributes defaults to '{}' and rejects invalid JSON", async () => {
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

test("{§db-migrations} entries: pathname NOT NULL", async () => {
    const db = await openMigrated();
    try {
        await insertWorkspace(db, "ws-no-pathname");
        await assert.rejects(
            () => db.test_entries_insert_no_pathname(),
            /NOT NULL constraint failed: entries\.pathname/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} entries: pathname empty string allowed", async () => {
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

test("{§stream} entry_channels: content length CHECK enforces 100 MiB char cap", async () => {
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

test("{§db-migrations} entry_channels: producer result is an exact terminal operation result", async () => {
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

test("{§db-migrations} entry_channels: NOT NULL on name, content, mimetype", async () => {
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

test("{§db-migrations} entry_channels: empty name or mimetype rejected by CHECK", async () => {
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

test("{§db-migrations} entry_channels: weight negative rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "session", "z");
        await assert.rejects(
            () => db.test_entry_channels_insert_with_weight.run({ entry_id: entryId, name: "body", content: "", mimetype: "text/plain", weight: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} entry_channels: ON DELETE CASCADE via entry", async () => {
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

test("{§execution-output-identity} entry_channels: CASCADE chain workspace→entries→entry_channels", async () => {
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

test("{§mimetype-error-policy} entry resources have no tag relation", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_entries_table_sql.get<{ sql: string }>({ name: "entry_tags" });
        assert.equal(row, undefined);
    } finally { await db.close(); }
});

// {§mimetype-error-policy} — `entry_channels.lines` is the persisted mirror of the one line count: the
// trigger expression and `TextCoordinates.lineCount` agree on every shape, at insert and at
// update ({§tokenomics}).
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

test("{§mimetype-error-policy} entry_channels: the stored line count mirrors TextCoordinates.lineCount on every LF shape", async () => {
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

// {§mimetype-error-policy} — a lone CR breaks a line; `005_entries` counts it.
test("{§mimetype-error-policy} entry_channels: the stored line count mirrors TextCoordinates.lineCount on a lone CR", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertEntry(db, "session", "/lines/lone-cr");
        const { inserted, updated } = await storedLines(db, entryId, "a\rb\r");
        assert.equal(inserted, TextCoordinates.lineCount("a\rb\r"), "lone CR: insert trigger");
        assert.equal(updated, TextCoordinates.lineCount("a\rb\r"), "lone CR: update trigger");
    } finally { await db.close(); }
});
});

describe("Digest.edit-census", () => {
// {§digest-forensic-fidelity} — every model EDIT counted by the form it authored, how it landed, and
// whether it came back to a path within two model turns.









const TMP_DIR = testArtifactPath("core");

interface EditFixture {
    sessionId: number; loopId: number; turnId: number; sequence: number;
    pathname: string; marker: string | null; pattern?: string | null; status: number; origin?: "model" | "_plurnk";
}

// One EDIT log row as the dispatcher writes it: the statement in tx, the marker beside it.
const insertEdit = async (db: Db, fixture: EditFixture): Promise<number> => {
    // The durable statement's matcher is a MatcherBody, as the parser records it.
    const matcher = fixture.pattern === undefined || fixture.pattern === null ? null : { dialect: "regex", raw: fixture.pattern, pattern: fixture.pattern.slice(1, -1), flags: "" };
    const statement = { op: "EDIT", path: fixture.pathname, lineMarker: fixture.marker === null ? null : JSON.parse(fixture.marker), matcher, body: "x" };
    const row = await db.engine_insert_log_entry.get<{ id: number }>({
        session_id: fixture.sessionId, loop_id: fixture.loopId, turn_id: fixture.turnId, sequence: fixture.sequence,
        origin: fixture.origin ?? "model", source: null, model_call_id: null,
        op: "EDIT", signal: null,
        scheme: "file", username: null, password: null, hostname: null, port: null,
        pathname: fixture.pathname, query: null, fragment: null, lineMarker: fixture.marker,
        tx: JSON.stringify(statement), mimetype_tx: "application/json",
        // A refusal is a Problem-bearing result; the digest validates every stored result ({§db-migrations}).
        rx: JSON.stringify(fixture.status >= 400
            ? { status: fixture.status, problem: { type: "https://problems.plurnk.xyz/test/edit-refused", title: "Edit refused", status: fixture.status, detail: "The witness refusal." } }
            : { status: fixture.status }),
        mimetype_rx: "application/json", status_rx: fixture.status, weight: 0,
        state: "resolved", outcome: null, attrs: "{}", initial_folded: null,
    });
    if (row === undefined) throw new Error("edit-census fixture log row did not insert");
    return row.id;
};

test("{§digest-forensic-fidelity}: the form is read from the authored marker and pattern", () => {
    const form = (marker: string | null, pattern: string | null = null): string => DigestRender.editForm({ line_marker: marker, pattern });
    assert.equal(form('{"marks":["@abcde"]}'), "hash");
    assert.equal(form('{"marks":[42]}'), "line");
    assert.equal(form('{"marks":["@abcde","@fghij"]}'), "range");
    assert.equal(form('{"marks":[3,5]}'), "range");
    assert.equal(form('{"marks":["@abcde",1,"@abcde",1]}'), "insert");
    assert.equal(form('{"marks":[42,1,42,1]}'), "insert");
    assert.equal(form('{"marks":[2,3,3,6]}'), "column");
    assert.equal(form('{"marks":[0]}'), "prepend");
    assert.equal(form('{"marks":[-1]}'), "append");
    assert.equal(form('{"marks":["@abcde",1,2]}'), "offset");
    assert.equal(form(null, "/foo/"), "pattern");
    assert.equal(form('{"marks":["@abcde"]}', "/foo/"), "pattern", "a matcher names the selection whatever marker rides beside it");
    assert.equal(form(null), "whole");
});

test("{§digest-forensic-fidelity}: a session's EDITs are counted by form, refusal and revisit, on the summary and in digest.json", async () => {
    const dbPath = join(TMP_DIR, `edit-census-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    const ids: Record<string, number> = {};
    try {
        const workspaceId = await insertWorkspace(db, "edit-census");
        const sessionId = await insertSession(db, workspaceId, null, "editor");
        await insertSession(db, workspaceId, null, "bystander");
        const loopId = await insertLoop(db, sessionId, 1, "edit things");
        const turns = await Promise.all([1, 2, 3, 4].map((sequence) => insertTurn(db, loopId, sequence, 200)));
        const base = { sessionId, loopId };
        ids.hash = await insertEdit(db, { ...base, turnId: turns[0], sequence: 1, pathname: "src/a.py", marker: '{"marks":["@abcde"]}', status: 200 });
        ids.whole = await insertEdit(db, { ...base, turnId: turns[0], sequence: 2, pathname: "src/b.py", marker: null, status: 201 });
        ids.harness = await insertEdit(db, { ...base, turnId: turns[0], sequence: 3, pathname: "workspace:///_plurnk/x.md", marker: null, status: 201, origin: "_plurnk" });
        // Turn 2 returns to a.py one turn later: a revisit.
        ids.insert = await insertEdit(db, { ...base, turnId: turns[1], sequence: 1, pathname: "src/a.py", marker: '{"marks":["@abcde",1,"@abcde",1]}', status: 200 });
        ids.pattern = await insertEdit(db, { ...base, turnId: turns[2], sequence: 1, pathname: "src/c.py", marker: null, pattern: "/foo/", status: 200 });
        // Turn 4: a.py again, two turns after its last edit (a revisit, refused); b.py three turns after (not one).
        ids.range = await insertEdit(db, { ...base, turnId: turns[3], sequence: 1, pathname: "src/a.py", marker: '{"marks":[3,5]}', status: 400 });
        ids.column = await insertEdit(db, { ...base, turnId: turns[3], sequence: 2, pathname: "src/b.py", marker: '{"marks":[1,3,2,4]}', status: 200 });
        ids.append = await insertEdit(db, { ...base, turnId: turns[3], sequence: 3, pathname: "src/d.py", marker: '{"marks":[-1]}', status: 200 });
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `edit-census-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /^EDITs: {6}7 · hash=1 range=1 insert=1 column=1 append=1 pattern=1 whole=1 · refused=1 · revisits=2$/mu,
        "the session summary counts every model EDIT by form, the refusal, and the two returns to a.py; the harness EDIT is not the model's");
    assert.match(markdown, /^EDITs: {6}\(no edits\)$/mu, "a session without EDITs says so");

    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        sessions: Array<{ name: string; edit_census: { edits: number; refused: number; revisits: number; forms: Record<string, number> } | null }>;
        log_entries: Array<{ id: number; edit_form?: string; edit_revisit?: boolean }>;
    };
    const editor = json.sessions.find((session) => session.name === "editor");
    assert.deepEqual(editor?.edit_census, {
        edits: 7, refused: 1, revisits: 2,
        forms: { hash: 1, line: 0, range: 1, insert: 1, column: 1, prepend: 0, append: 1, offset: 0, pattern: 1, whole: 1 },
    });
    const stamped = new Map(json.log_entries.filter((entry) => entry.edit_form !== undefined).map((entry) => [entry.id, entry]));
    assert.deepEqual(
        Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, stamped.get(id) === undefined ? null : `${stamped.get(id)!.edit_form}${stamped.get(id)!.edit_revisit ? "+revisit" : ""}`])),
        { hash: "hash", whole: "whole", harness: null, insert: "insert+revisit", pattern: "pattern", range: "range+revisit", column: "column", append: "append" },
        "every model EDIT row carries its form and revisit flag; the harness row carries neither",
    );
});
});

describe("SchemeRegistry", () => {
test("{§core-extension-composition} SchemeRegistry: constructor registers the engine-owned scheme roster", () => {
    const r = new SchemeRegistry();
    assert.deepEqual(r.list().toSorted(), ["exec", "file", "log", "message", "note", "ops", "reasoning", "session", "workspace"], "the engine roster is exact; skill belongs to the daemon's skills lifecycle");
});

test("{§core-extension-composition} SchemeRegistry: register(name) on already-registered name fails hard", () => {
    const r = new SchemeRegistry();
    assert.throws(
        () => r.register("session", new Session()),
        /scheme name 'session' is reserved by core package '@plurnk\/plurnk-service'; programmatic scheme 'session' cannot claim it/,
    );
});

test("{§manifest} SchemeRegistry exposes scheme traits without owning capability admission", () => {
    const r = new SchemeRegistry();
    class Http {
        static manifest: SchemeManifest = {
            name: "https",
            channels: {},
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: true,
            modelVisible: true,
            traits: ["web"],
        };
    }
    r.register("https", new Http());
    assert.deepEqual(r.manifestFor("https")?.traits, ["web"]);
    assert.equal(r.has("https"), true, "registration is topology; CapabilityResolver owns admission");
});
});

describe("bundled-mimetype-handlers", () => {
// Smoke coverage for the service-owned default mimetype composition
// ({§bundled-set}). The service manifest is the inventory authority; this suite
// asserts every declared handler from those dependencies is discovered, then
// drives representative handlers through the assembled processing path.
//
// Per-handler behavioral tests live in each sibling's repo. This file
// is the plurnk-service-side integration check: "the handler exists,
// the framework finds it, our path through it works."
//
// NOTE: tree-sitter-backed languages (python, typescript, toml, yaml, …) are
// NOT standalone deps — the 0.10.0 framework absorbed them into its internal
// TREE_SITTER_REGISTRY ({§treesitter-runtime-gate} Tier 1), so they're covered by
// @plurnk/plurnk-mimetypes' own suite, not here. Only bespoke standalone
// handlers belong to this service-side composition check.





const require = createRequire(import.meta.url);
const serviceManifest = require("../../package.json") as {
    dependencies?: Record<string, string>;
};
const imagePackage = "@plurnk/plurnk-mimetypes-image";
const imageManifest = require(`${imagePackage}/package.json`) as { version: string };
const pdfManifest = require("@plurnk/plurnk-mimetypes-application-pdf/package.json") as { version: string; dependencies?: Record<string, string> };
const defaultHandlerPackages = Object.keys(serviceManifest.dependencies ?? {})
    .filter((name) => name.startsWith("@plurnk/plurnk-mimetypes-"))
    .flatMap((packageName) => {
        const manifest = require(`${packageName}/package.json`) as {
            plurnk?: { handlers?: Array<{ name?: unknown }> };
        };
        return (manifest.plurnk?.handlers ?? [])
            .filter((handler): handler is { name: string } => typeof handler.name === "string")
            .map((handler) => ({ packageName, mimetype: handler.name }));
    });

interface Case {
    label: string;
    ext: string;
    sampleContent: string;
    expectedMimetype: string;
}

const CASES: Case[] = [
    {
        label: "text/markdown",
        ext: ".md",
        sampleContent: "# Title\n\nA paragraph.\n\n## Section\n",
        expectedMimetype: "text/markdown",
    },
    {
        label: "text/html",
        ext: ".html",
        sampleContent: "<!DOCTYPE html><html><head><title>Page</title></head><body><h1>Heading</h1></body></html>",
        expectedMimetype: "text/html",
    },
    {
        label: "text/csv",
        ext: ".csv",
        sampleContent: "name,age\nAlice,30\nBob,25\n",
        expectedMimetype: "text/csv",
    },
    {
        label: "application/json",
        ext: ".json",
        sampleContent: "{\"name\":\"Alice\",\"age\":30}",
        expectedMimetype: "application/json",
    },
    {
        label: "application/jsonl",
        ext: ".jsonl",
        sampleContent: "{\"name\":\"Alice\"}\n{\"name\":\"Bob\"}\n",
        expectedMimetype: "application/jsonl",
    },
    {
        label: "application/x-ipynb+json",
        ext: ".ipynb",
        sampleContent: "{\"cells\":[],\"metadata\":{},\"nbformat\":4,\"nbformat_minor\":5}",
        expectedMimetype: "application/x-ipynb+json",
    },
    {
        label: "application/xml",
        ext: ".xml",
        sampleContent: "<root><item>value</item></root>",
        expectedMimetype: "application/xml",
    },
    {
        label: "text/x-diff",
        ext: ".diff",
        sampleContent: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
        expectedMimetype: "text/x-diff",
    },
    {
        label: "text/x-dotenv",
        ext: ".env",
        sampleContent: "PLURNK_EXAMPLE=settled\n",
        expectedMimetype: "text/x-dotenv",
    },
    {
        label: "text/x-ini",
        ext: ".ini",
        sampleContent: "[section]\nkey=value\n",
        expectedMimetype: "text/x-ini",
    },
    {
        label: "text/plain",
        ext: ".txt",
        sampleContent: "Just some text content here.",
        expectedMimetype: "text/plain",
    },
];

// One Mimetypes instance per file — auto-discovery scans node_modules
// once and the registered handlers are reused across tests. ready() is
// idempotent and cheap on the cached path.
const mimetypes = new Mimetypes();

test("{§bundled-set} discovery: Mimetypes initializes without throwing", async () => {
    await mimetypes.ready();
});

test("{§bundled-set} discovery: every service-owned format-handler declaration is registered", async () => {
    const found = await discover({ includeTreeSitter: false });
    for (const { packageName, mimetype } of defaultHandlerPackages) {
        assert.equal(
            found.handlers.get(mimetype)?.packageName,
            packageName,
            `${mimetype} should resolve to the service-owned ${packageName} leaf`,
        );
    }
});

test("{§mimetype-binary-input} the default service installs its image and PDF owners without inference or optional artifact catalogs", () => {
    assert.equal(serviceManifest.dependencies?.[imagePackage], imageManifest.version);
    // {§mimetype-binary-input} — the PDF owner is header-only and dependency-free, so it ships by default like the image owner (#542).
    assert.equal(serviceManifest.dependencies?.["@plurnk/plurnk-mimetypes-application-pdf"], pdfManifest.version);
    assert.deepEqual(pdfManifest.dependencies, undefined, "the PDF owner pulls no extraction or rendering stack");
});

for (const c of CASES) {
    test(`{§bundled-set} ${c.label}: extension '${c.ext}' routes to '${c.expectedMimetype}'`, async () => {
        await mimetypes.ready();
        const detected = await mimetypes.detect({ ext: c.ext });
        assert.equal(detected, c.expectedMimetype,
            `extension '${c.ext}' should resolve to '${c.expectedMimetype}', got '${detected}'`);
    });

    test(`{§bundled-set} ${c.label}: process produces the structural surface for sample content`, async () => {
        await mimetypes.ready();
        const result = await mimetypes.process({ content: c.sampleContent, ext: c.ext }, { channels: ["symbols"] });
        assert.equal(result.mimetype, c.expectedMimetype);
        assert.ok(result.ok, `process should succeed for ${c.label}`);
        assert.ok(result.totalLines > 0, `${c.label} should report a content extent`);
    });
}
});

describe("db-baseline-hint", () => {
// {§db-migrations} — a database whose shape disagrees with its version cannot be migrated;
// the launcher must say so instead of surfacing SQLite's bare "no such column", and a pre-floor
// database must name its stepping-stone release.






test("{§db-migrations}: opening a database whose shape disagrees with its version names the remedy", async () => {
    const result = await launch({}, async ({ dir, dbPath }) => {
        const mismatched = join(dir, "mismatched-baseline");
        await mkdir(mismatched);
        await writeFile(
            join(mismatched, "010_other.sql"),
            "-- MIGRATE: 10 other\nCREATE TABLE workspaces (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE session_references (id INTEGER NOT NULL PRIMARY KEY);\nCREATE TABLE entry_channels (entry_id INTEGER, name TEXT, content TEXT);\n",
        );
        new SqlRiteSync({ path: dbPath, dir: mismatched }).close();
    });
    assert.equal(result.code, 1, `the launcher fails closed (stderr: ${result.stderr})`);
    assert.match(result.stderr, /shape disagrees with its schema version/, "the operator is told what the failure is");
    assert.match(result.stderr, /point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside/, "and what to do about it without deleting the database");
    assert.match(result.stderr, /cause: no such (?:column|table)/, "SQLite's own diagnosis stays attached");
});

test("{§db-migrations}: opening a database newer than the build names both versions read", async () => {
    const result = await launch({}, async ({ dir, dbPath }) => {
        const newer = join(dir, "newer-release");
        await mkdir(newer);
        await writeFile(
            join(newer, "099_future.sql"),
            "-- MIGRATE: 99 future\nCREATE TABLE workspaces (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE session_references (id INTEGER NOT NULL PRIMARY KEY);\n",
        );
        new SqlRiteSync({ path: dbPath, dir: newer }).close();
    });
    assert.equal(result.code, 1, `the launcher fails closed (stderr: ${result.stderr})`);
    assert.match(result.stderr, /database schema \(version 99\) is newer than this build \(schema version 10\)/, "both schema versions read are named");
});

test("{§db-migrations}: opening a pre-floor database names both versions read and non-destructive remediation", async () => {
    const result = await launch({}, async ({ dir, dbPath }) => {
        const legacy = join(dir, "pre-floor");
        await mkdir(legacy);
        await writeFile(join(legacy, "034_legacy.sql"), "-- MIGRATE: 34 legacy\nCREATE TABLE workspaces (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL);\n");
        new SqlRiteSync({ path: dbPath, dir: legacy }).close();
    });
    assert.equal(result.code, 1, `the launcher fails closed (stderr: ${result.stderr})`);
    assert.match(result.stderr, /database schema \(version 34\) precedes the 5\.0\.0 support floor \(schema version 10\); point PLURNK_SERVICE_DB_PATH at a new file or move the database/, "both versions and non-destructive remediation are named");
});
});

describe("demo-fixture", () => {
test("{§db-migrations} the demo fixture registers every project member under the non-null file identity", async () => {
    const fixture = await seedDemoFixture(`identity-${crypto.randomUUID()}`);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `demo-fixture-${crypto.randomUUID()}`);
        await fixture.addToCatalog(db, workspaceId);
        const rows = await db.test_list_entry_schemes.all<{ scheme: string }>();
        assert.ok(rows.length > 0, "the fixture registers its project members");
        assert.ok(rows.every(({ scheme }) => scheme === "file"), "every project member persists as scheme='file'");
    } finally {
        await db.close();
        await fixture.cleanup();
    }
});
});

describe("deps-audit", () => {
// {§bundled-set}: fixtures shaped like `npm audit --json`
// verify routing without introducing a vulnerable dependency.

test("{§bundled-set} routeAdvisories routes a transitive advisory to its owning @plurnk/* package", () => {
    // uuid (the GHSA source) → @cucumber/messages → @cucumber/gherkin → text-gherkin → @plurnk/plurnk-mimetypes (direct). Fixture predates the -all removal; the chain is synthetic.
    const audit = {
        vulnerabilities: {
            uuid: {
                severity: "moderate",
                via: [{ source: 1, name: "uuid", title: "uuid uses Math.random()", url: "https://github.com/advisories/GHSA-w5hq-g745-h8pq", severity: "moderate" }],
                effects: ["@cucumber/messages"],
            },
            "@cucumber/messages": { severity: "moderate", via: ["uuid"], effects: ["@cucumber/gherkin"] },
            "@cucumber/gherkin": { severity: "moderate", via: ["@cucumber/messages"], effects: ["text-gherkin"] },
            "text-gherkin": { severity: "moderate", via: ["@cucumber/gherkin"], effects: ["@plurnk/plurnk-mimetypes"] },
            "@plurnk/plurnk-mimetypes": { severity: "moderate", via: ["text-gherkin"], effects: [] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 } },
    };
    const deps = new Set(["@plurnk/plurnk-mimetypes", "ws", "diff"]);

    const routed = routeAdvisories(audit, deps);
    assert.equal(routed.length, 1, "one entry per advisory SOURCE, not one per pass-through node in the chain");
    assert.equal(routed[0].package, "uuid");
    assert.equal(routed[0].ghsa, "https://github.com/advisories/GHSA-w5hq-g745-h8pq");
    assert.deepEqual(routed[0].plurnkRoots, ["@plurnk/plurnk-mimetypes"], "routed to its owning @plurnk package for upstream filing");
});

test("{§bundled-set} an advisory rooted in a first-party direct dependency is not routed upstream", () => {
    // A vuln pulled directly by a non-@plurnk direct dep (ws) is ours to fix here, not routed to an extension.
    const audit = {
        vulnerabilities: {
            ws: { severity: "high", via: [{ source: 2, name: "ws", title: "ws DoS", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high" }], effects: [] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    };
    const routed = routeAdvisories(audit, new Set(["ws", "@plurnk/plurnk-contracts"]));
    assert.equal(routed.length, 1);
    assert.deepEqual(routed[0].roots, ["ws"], "ws roots in itself — a direct dep");
    assert.deepEqual(routed[0].plurnkRoots, [], "not a @plurnk chain → not routed upstream");
});

test("{§bundled-set} rootsFor follows effects edges to every direct-dependency root", () => {
    const vulns = {
        leaf: { effects: ["mid"] },
        mid: { effects: ["@plurnk/a", "ws"] },
        "@plurnk/a": { effects: [] },
        ws: { effects: [] },
    };
    assert.deepEqual(rootsFor(vulns, "leaf", new Set(["@plurnk/a", "ws"])).toSorted(), ["@plurnk/a", "ws"], "a leaf reachable via two roots reports both");
});
});

describe("entry-identity", () => {
// {§db-migrations} — repeated registration converges and NULL cannot fragment identity.



test("{§db-migrations}: repeated membership registration converges to one row", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `identity-${crypto.randomUUID()}`);
        // Simulate repeated turn-boundary registration of one member.
        for (let turn = 0; turn < 3; turn++) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "/evaluator/functions.go", membership_origin: "git" });
        }
        const rows = await db.test_count_entry_rows.get<{ n: number }>({ workspace_id: workspaceId, pathname: "/evaluator/functions.go" });
        assert.equal(rows?.n, 1, "three registrations, ONE row — ON CONFLICT fires now that no identity component is NULL");
    } finally { await db.close(); }
});

test("{§db-migrations}: the schema refuses a NULL scheme", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `identity-null-${crypto.randomUUID()}`);
        await assert.rejects(
            () => db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: null, authority: "", pathname: "/x.md", membership_origin: "git" }),
            /NOT NULL/i,
            "the column refuses NULL — the identity law is enforced at the schema, not by caller discipline",
        );
    } finally { await db.close(); }
});
});

describe("manifest-tags", () => {
test("{§db-migrations} manifest catalog: a file member stores scheme=file and renders slash-free (note 1)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mslash-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        // {§db-migrations} — storage uses the reserved file identity, while
        // the catalog projects the relative bare path the model reads and writes.
        await EntryCrud.writeEntry({ authority: "", pathname: "notes.md" }, { channels: { body: { content: "hi", mimetype: "text/markdown" } } }, ctx, "file");
        const stored = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "notes.md", scheme: "file" });
        assert.equal(stored?.scheme, "file", "the durable entry identity is non-null and explicit");
        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const note = catalog.find(([channel]) => channel.path.endsWith("notes.md"));
        assert.equal(note?.[0].path, "notes.md", "the /notes.md member renders as bare notes.md — what the model writes back");
    } finally { await db.close(); }
});
});

describe("schema-composition", () => {
// {§db-migrations} — the baseline declares shape: tables, indexes, views, and the constraint
// triggers that are a table's invariants. {§db-migrations} — a trigger that writes rows is a
// process, declared as an INIT block beside the statements that fire it, dropped and recreated on
// every open so its definition is current on any database whose shape is current (#624).





const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const TRIGGER = /CREATE TRIGGER(?: IF NOT EXISTS)? (\w+)\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w,\s]+?)?\s+ON (\w+)[\s\S]*?\nEND;/g;
const DROPPED = /^DROP TRIGGER(?: IF EXISTS)? (\w+);/gm;
const WRITES = /\b(INSERT INTO|UPDATE \w+\s+SET|DELETE FROM)\b/i;
const body = (block: string): string => block.slice(block.indexOf("BEGIN"));

const sqlFiles = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...await sqlFiles(path)); continue; }
        if (entry.name.endsWith(".sql")) out.push(path);
    }
    return out;
};

// The baseline is the chapters of `migrations/`, each one MIGRATE block whose version is the
// file's numeric prefix, so the chapter a reader opens is the version sqlrite applies.
const baselineTriggers = async (): Promise<Array<{ name: string; when: string; writes: boolean }>> => {
    const dir = resolve(PROJECT_ROOT, "migrations");
    const chapters = (await readdir(dir)).filter((name) => name.endsWith(".sql")).toSorted();
    assert.ok(chapters.length > 1, "the baseline is chaptered");
    // {§db-migrations}: a chapter that rebuilds a table redeclares that table's guards, so the
    // latest chapter naming a trigger is its current declaration, and one it drops without
    // redeclaring is no longer declared.
    const triggers = new Map<string, { name: string; when: string; writes: boolean }>();
    for (const [index, chapter] of chapters.entries()) {
        const text = await readFile(join(dir, chapter), "utf8");
        const version = Number(chapter.split("_")[0]);
        assert.equal(version, index + 1, `${chapter}: chapters are numbered consecutively from 1`);
        assert.deepEqual(text.match(/^-- MIGRATE: (\d+)/gm), [`-- MIGRATE: ${version}`], `${chapter}: one MIGRATE block, its version is the file's prefix`);
        assert.equal((text.match(/^-- (INIT|PREP|EXEC|TX): /gm) ?? []).length, 0, `${chapter}: a chapter holds shape only; processes live beside their owners`);
        const statements = [
            ...[...text.matchAll(TRIGGER)].map((m) => ({ index: m.index, name: m[1], declared: { name: m[1], when: m[2], writes: WRITES.test(body(m[0])) } })),
            ...[...text.matchAll(DROPPED)].map((m) => ({ index: m.index, name: m[1], declared: null })),
        ].toSorted((a, b) => a.index - b.index);
        for (const { name, declared } of statements) {
            if (declared === null) triggers.delete(name);
            else triggers.set(name, declared);
        }
    }
    return [...triggers.values()];
};

const initTriggers = async (): Promise<Array<{ file: string; init: string; name: string; dropsFirst: boolean; writes: boolean }>> => {
    const out: Array<{ file: string; init: string; name: string; dropsFirst: boolean; writes: boolean }> = [];
    for (const path of await sqlFiles(resolve(PROJECT_ROOT, "src"))) {
        const text = await readFile(path, "utf8");
        for (const block of text.split(/^-- INIT: /m).slice(1)) {
            const init = block.split("\n")[0].trim();
            for (const m of block.matchAll(TRIGGER)) {
                out.push({
                    file: path.slice(PROJECT_ROOT.length + 1),
                    init,
                    name: m[1],
                    dropsFirst: new RegExp(`DROP TRIGGER IF EXISTS ${m[1]};\\s*\\nCREATE TRIGGER ${m[1]}\\b`).test(block),
                    writes: WRITES.test(body(m[0])),
                });
            }
        }
    }
    return out;
};

test("{§db-migrations}: every trigger in the baseline guards its table; only the view's INSTEAD OF trigger writes", async () => {
    const triggers = await baselineTriggers();
    assert.ok(triggers.length > 0);
    const processes = triggers.filter(({ writes, when }) => writes && when !== "INSTEAD OF").map(({ name }) => name);
    assert.deepEqual(processes, [], "a trigger that writes rows is a process and belongs beside its owner");
    const guards = triggers.filter(({ writes }) => !writes);
    assert.ok(guards.every(({ when }) => when === "BEFORE" || when === "AFTER"));
});

test("{§db-migrations}: every INIT trigger writes rows, is named after itself, and is dropped before it is created", async () => {
    const triggers = await initTriggers();
    assert.ok(triggers.length >= 21, `the process triggers are declared as INIT blocks (found ${triggers.length})`);
    for (const t of triggers) {
        assert.equal(t.init, t.name, `${t.file}: INIT block ${t.init} declares trigger ${t.name}; the block is named after its trigger`);
        assert.ok(t.dropsFirst, `${t.file} ${t.name}: DROP TRIGGER IF EXISTS precedes CREATE TRIGGER, so the definition is current on every open`);
        assert.ok(t.writes, `${t.file} ${t.name}: an INIT trigger is a process; a guard belongs with its table in the baseline`);
    }
    const names = triggers.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length, "one owner per process trigger");
});

test("{§db-migrations}: a fresh database holds exactly the declared triggers, and a reopen keeps every one", async () => {
    const declared = [...(await baselineTriggers()).map(({ name }) => name), ...(await initTriggers()).map(({ name }) => name)].toSorted();
    assert.equal(new Set(declared).size, declared.length, "no trigger is declared twice");
    const path = join(tmpdir(), `composition-${crypto.randomUUID()}.db`);
    const live = (): string[] => {
        const raw = new DatabaseSync(path, { readOnly: true });
        try { return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name); }
        finally { raw.close(); }
    };
    const first = await openMigrated(path);
    try { assert.deepEqual(live(), declared, "the live trigger set is the declared set"); } finally { await first.close(); }
    const second = await openMigrated(path);
    try { assert.deepEqual(live(), declared, "the second open drops and recreates every process trigger and loses none"); } finally { await second.close(); }
});
});

describe("schema-query-plans", () => {
// {§db-migrations} — every prepared statement's plan, read from the baseline schema, must not
// scan a table that only grows. Written as the witness for the #614 audit: it prints the offending
// plans so the audit reasons from EXPLAIN QUERY PLAN, never from a grep of index names.





const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
// Workload-scaled tables; retention does not make a full scan a bounded lookup.
const GROWING = new Set(["log_entries", "entries", "entry_channel_rows", "contents", "subscriptions", "sessions", "loops", "turns", "symbol_defs", "symbol_refs", "derivations", "ambient_events", "provider_requests", "inference_calls", "model_calls", "turn_attempts", "log_entry_projections", "native_contents", "proposal_decisions", "client_interactions", "turn_sources", "packet_items", "turn_sections", "turn_section_items"]);
// Statements that read a whole table on purpose (forensic digest, startup recovery, whole-workspace listings).
// A retention collector considers every row of its table by definition ({§content-store}).
// A write through the entry_channels view ({§content-store}) plans as a SEARCH of its rows plus a
// SCAN of the matched rows SQLite has already copied aside; the view itself is not a table.
const VIEWS = new Set(["entry_channels"]);
const WHOLE_TABLE_BY_DESIGN = /^(digest_|recovery_|test_|envelope_list_|retention_collect_|drain_scheduled_loops$|drain_claim_next_loop$|drain_ready_loop$)/;

const collectStatements = async (): Promise<Array<{ name: string; file: string; sql: string }>> => {
    return SqlRiteCore.getFiles(resolve(PROJECT_ROOT, "src")).flatMap((file) =>
        SqlRiteCore.parseSql([file]).PREP.map(({ name, sql }) => ({ name, sql, file: file.slice(PROJECT_ROOT.length + 1) })),
    );
};

// Plan with the same function declarations and SQL parser as the runtime.
const planRegistry = async (): Promise<{ plans: Array<{ name: string; file: string; rows: string[] }>; raw: DatabaseSync; close: () => Promise<void> }> => {
    const path = join(tmpdir(), `plans-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    const raw = SqlRiteCore.openDb({ path, readOnly: true });
    const close = async (): Promise<void> => { raw.close(); await db.close(); };
    try {
        SqlRiteCore.initDb(raw);
        await SqlRiteCore.registerFunctions(raw, sqlFunctionPaths);
        const plans: Array<{ name: string; file: string; rows: string[] }> = [];
        for (const { name, file, sql } of await collectStatements()) {
            const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
            plans.push({ name, file, rows: rows.map(({ detail }) => detail) });
        }
        return { plans, raw, close };
    } catch (error) {
        await close();
        throw error;
    }
};

test("{§db-migrations}: no registry statement scans a growing table without an index", async () => {
    const { plans, close } = await planRegistry();
    const offenders: string[] = [];
    try {
        for (const { name, file, rows } of plans) {
            if (WHOLE_TABLE_BY_DESIGN.test(name)) continue;
            for (const detail of rows) {
                const scan = /^SCAN (\S+)/.exec(detail);
                if (scan === null) continue;
                const table = scan[1];
                if (VIEWS.has(table)) continue;
                if (GROWING.has(table) && !/USING (COVERING )?INDEX/.test(detail)) offenders.push(`${file} ${name}: ${detail}`);
            }
        }
    } finally { await close(); }
    assert.deepEqual(offenders, [], `full scans of growing tables:\n${offenders.join("\n")}`);
});

// {§db-migrations} — an index earns its place by a plan that uses it, a foreign key whose
// check it serves (its leading column is a foreign-key column), or a uniqueness constraint. Anything
// else is a write cost on every insert with no reader, and this test names it.
test("{§db-migrations}: every explicit index is used by a registry plan, backs a foreign key, or enforces uniqueness", async () => {
    const { plans, raw, close } = await planRegistry();
    const unowned: string[] = [];
    try {
        const used = new Set<string>();
        for (const { rows } of plans) {
            for (const detail of rows) {
                const index = /USING (?:COVERING )?INDEX (\S+)/.exec(detail)?.[1];
                if (index !== undefined) used.add(index);
            }
        }
        const declared = raw.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY tbl_name, name").all() as Array<{ name: string; tbl_name: string; sql: string }>;
        for (const { name, tbl_name, sql } of declared) {
            if (used.has(name) || /UNIQUE/u.test(sql)) continue;
            const leading = /\(\s*([A-Za-z_]\w*)/u.exec(sql.slice(sql.indexOf(" ON ")))?.[1];
            const foreignKeys = (raw.prepare(`PRAGMA foreign_key_list(${tbl_name})`).all() as Array<{ from: string }>).map(({ from }) => from);
            if (leading !== undefined && foreignKeys.includes(leading)) continue;
            unowned.push(`${tbl_name}.${name}: no plan uses it, leading column ${leading ?? "?"} is not a foreign key, and it is not unique`);
        }
    } finally { await close(); }
    assert.deepEqual(unowned, [], `indexes without an owner:\n${unowned.join("\n")}`);
});
});

describe("validation-topology", () => {
// {§db-migrations} — one settled-result corpus, three enforcers: the gate a scheme's result
// crosses (`Results.assertChannelProducerResult`), chapter 5's `entry_channel_producer_result_contract`
// and chapter 7's `subscriptions_result_contract_update`. They agree on every row.






const problem = (status: number, overrides: Partial<Record<keyof ProblemDetails, string | undefined>> = {}): Record<string, unknown> => {
    const complete: Record<string, unknown> = {
        type: "https://problems.plurnk.xyz/test/settled",
        title: "Settled",
        status,
        detail: "The witness problem.",
        ...overrides,
    };
    return Object.fromEntries(Object.entries(complete).filter(([, value]) => value !== undefined));
};

const CORPUS: ReadonlyArray<readonly [label: string, result: Record<string, unknown>, settled: boolean]> = [
    ["200 without a Problem", { status: 200 }, true],
    ["302 without a Problem", { status: 302 }, true],
    ["404 with a complete Problem", { status: 404, problem: problem(404) }, true],
    ["500 with a complete Problem", { status: 500, problem: problem(500) }, true],
    ["202 is a proposal, not a settlement", { status: 202 }, false],
    ["199 is below the settled range", { status: 199 }, false],
    ["600 is above the status range", { status: 600 }, false],
    ["404 without a Problem", { status: 404 }, false],
    ["200 with a Problem", { status: 200, problem: problem(200) }, false],
    ["404 whose Problem carries another status", { status: 404, problem: problem(500) }, false],
    ["404 with no type", { status: 404, problem: problem(404, { type: undefined }) }, false],
    ["404 with an empty type", { status: 404, problem: problem(404, { type: "" }) }, false],
    ["404 with no title", { status: 404, problem: problem(404, { title: undefined }) }, false],
    ["404 with an empty title", { status: 404, problem: problem(404, { title: "" }) }, false],
    ["404 with no detail", { status: 404, problem: problem(404, { detail: undefined }) }, false],
    ["404 with an empty detail", { status: 404, problem: problem(404, { detail: "" }) }, false],
];

const seed = async (db: Db): Promise<{ entryId: number; sessionId: number }> => {
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
        workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: `/${crypto.randomUUID()}`,
    });
    if (entry === undefined) throw new Error("seed entry failed");
    await db.test_seed_channel.run({ entry_id: entry.id, name: "body", content: "", mimetype: "text/plain", state: "active" });
    return { entryId: entry.id, sessionId };
};

const gate = (result: Record<string, unknown>): boolean => {
    try {
        Results.assertChannelProducerResult(structuredClone(result) as ChannelProducerResult);
        return true;
    } catch (error) {
        if (!(error instanceof InvalidOperationResultError)) throw error;
        return false;
    }
};

const chapterFive = async (db: Db, entryId: number, result: Record<string, unknown>): Promise<boolean> => {
    try {
        await db.test_seed_channel_hashed.run({
            entry_id: entryId, name: crypto.randomUUID(), content: "x", mimetype: "text/plain",
            weight: null, content_hash: null, state: "static", producer_result: JSON.stringify(result),
        });
        return true;
    } catch (error) {
        assert.match((error as Error).message, /entry_channel_producer_result_contract/);
        return false;
    }
};

const chapterSeven = async (db: Db, { entryId, sessionId }: { entryId: number; sessionId: number }, result: Record<string, unknown>): Promise<boolean> => {
    const subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sse", handle: "/settled" });
    try {
        await db.test_topology_settle_subscription.run({ subscription_id: subscriptionId, status: result.status as number, result: JSON.stringify(result) });
    } catch (error) {
        assert.match((error as Error).message, /subscription terminal result violates the operation-result contract/);
        return false;
    }
    const closed = await db.test_topology_subscription_closed.get<{ close_status: number }>({ subscription_id: subscriptionId });
    assert.equal(closed?.close_status, result.status);
    return true;
};

test("{§db-migrations}: the gate, chapter 5 and chapter 7 settle the same results and refuse the same results", async () => {
    const db = await openMigrated();
    try {
        for (const [label, result, settled] of CORPUS) {
            const seeded = await seed(db);
            assert.equal(gate(result), settled, `${label}: Results.assertChannelProducerResult`);
            assert.equal(await chapterFive(db, seeded.entryId, result), settled, `${label}: entry_channel_producer_result_contract`);
            assert.equal(await chapterSeven(db, seeded, result), settled, `${label}: subscriptions_result_contract_update`);
        }
    } finally { await db.close(); }
});
});
