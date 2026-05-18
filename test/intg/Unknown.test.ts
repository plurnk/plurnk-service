import test from "node:test";
import assert from "node:assert/strict";
import type { LineMarker, MatcherBody, ParsedPath, ReadStatement } from "@plurnk/plurnk-grammar";
import Unknown from "../../src/schemes/Unknown.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";
import { urlPath, editStmt, showStmt, hideStmt } from "./_dsl.ts";

const readStmtPlus = (path: ParsedPath, opts: { tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null } = {}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null, path,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

const visibilityOf = async (db: Db, runId: number, entryId: number): Promise<number | undefined> => {
    const row = await (db.test_get_visibility as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: entryId, channel: "body" });
    return row?.indexed;
};

test("Unknown.edit: writes entry with scope='session' and scheme='unknown'", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Unknown().edit({ db, statement: editStmt(urlPath("unknown", "/france/capital"), "What is the capital of France?", ["france"]), sessionId, runId });
        assert.equal(r.status, 201);
        const entry = await (db.entry_read_lookup as PrepMethod).get<{ scope: string; scheme: string; pathname: string }>({
            session_id: sessionId, scheme: "unknown", pathname: "/france/capital",
        });
        assert.equal(entry?.scope, "session");
        assert.equal(entry?.scheme, "unknown");
        assert.equal(entry?.pathname, "/france/capital");
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: r.entryId, name: "body" });
        assert.equal(channel?.content, "What is the capital of France?");
    } finally { await db.close(); }
});

test("Unknown.edit: entries with same pathname are scheme-isolated", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "open question"), sessionId, runId });
        const Known = (await import("../../src/schemes/Known.ts")).default;
        await new Known().edit({ db, statement: editStmt(urlPath("known", "/x"), "known answer"), sessionId, runId });
        const rows = await (db.test_list_entry_schemes as PrepMethod).all<{ scheme: string }>();
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.scheme), ["known", "unknown"]);
    } finally { await db.close(); }
});

test("Unknown.edit: idempotent on same path", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const first = await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "first"), sessionId, runId });
        const second = await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "second"), sessionId, runId });
        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId);
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: first.entryId, name: "body" });
        assert.equal(channel?.content, "second");
    } finally { await db.close(); }
});

test("Unknown.edit: null path → 400; lineMarker → 501", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        assert.equal((await u.edit({ db, statement: { ...editStmt(urlPath("unknown", "/x")), path: null }, sessionId, runId })).status, 400);
        assert.equal((await u.edit({ db, statement: { ...editStmt(urlPath("unknown", "/x"), "x"), lineMarker: { first: 5, last: null } }, sessionId, runId })).status, 501);
    } finally { await db.close(); }
});

test("Unknown.edit: tags merge additively; visibility set to indexed=1", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const r = await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "a", ["france"]), sessionId, runId });
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "b", ["geography"]), sessionId, runId });
        const tags = await (db.test_list_entry_tags as PrepMethod).all<{ tag: string }>({ entry_id: r.entryId });
        assert.deepEqual(tags.map((t) => t.tag), ["france", "geography"]);
        assert.equal(await visibilityOf(db, runId, r.entryId!), 1);
    } finally { await db.close(); }
});

test("Unknown.read: existing entry → 200; nonexistent → 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "question"), sessionId, runId });
        const found = await u.read({ db, statement: readStmtPlus(urlPath("unknown", "/x")), sessionId });
        assert.equal(found.status, 200);
        assert.equal(found.content, "question");
        const missing = await u.read({ db, statement: readStmtPlus(urlPath("unknown", "/nope")), sessionId });
        assert.equal(missing.status, 404);
    } finally { await db.close(); }
});

test("Unknown.read: scheme isolation", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const Known = (await import("../../src/schemes/Known.ts")).default;
        await new Known().edit({ db, statement: editStmt(urlPath("known", "/iso"), "known content"), sessionId, runId });
        const result = await new Unknown().read({ db, statement: readStmtPlus(urlPath("unknown", "/iso")), sessionId });
        assert.equal(result.status, 404);
    } finally { await db.close(); }
});

test("Unknown.read: all 501 modes", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "data"), sessionId, runId });
        const path = urlPath("unknown", "/x");
        assert.equal((await u.read({ db, statement: readStmtPlus(path, { lineMarker: { first: 1, last: null } }), sessionId })).status, 501);
        assert.equal((await u.read({ db, statement: readStmtPlus(path, { body: { dialect: "glob", raw: "*" } }), sessionId })).status, 501);
        assert.equal((await u.read({ db, statement: readStmtPlus(path, { tags: ["any"] }), sessionId })).status, 501);
    } finally { await db.close(); }
});

test("Unknown.show/hide: round-trip", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const r = await u.edit({ db, statement: editStmt(urlPath("unknown", "/v"), "x"), sessionId, runId });
        const path = urlPath("unknown", "/v");
        assert.equal((await u.show({ db, statement: showStmt(path), sessionId, runId })).status, 304);
        assert.equal((await u.hide({ db, statement: hideStmt(path), sessionId, runId })).status, 200);
        assert.equal(await visibilityOf(db, runId, r.entryId!), 0);
        assert.equal((await u.hide({ db, statement: hideStmt(path), sessionId, runId })).status, 304);
        assert.equal((await u.show({ db, statement: showStmt(path), sessionId, runId })).status, 200);
        assert.equal(await visibilityOf(db, runId, r.entryId!), 1);
    } finally { await db.close(); }
});

test("Unknown.show: nonexistent entry → 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Unknown().show({ db, statement: showStmt(urlPath("unknown", "/nope")), sessionId, runId });
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("Unknown.show/hide: null path → 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        assert.equal((await u.show({ db, statement: showStmt(null), sessionId, runId })).status, 400);
        assert.equal((await u.hide({ db, statement: hideStmt(null), sessionId, runId })).status, 400);
    } finally { await db.close(); }
});
