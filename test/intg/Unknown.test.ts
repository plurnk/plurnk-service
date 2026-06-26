import test from "node:test";
import assert from "node:assert/strict";
import type { LineMarker, MatcherBody, ParsedPath, ReadStatement } from "@plurnk/plurnk-grammar";
import Unknown from "../../src/schemes/Unknown.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, openStmt, foldStmt } from "./_dsl.ts";

const readStmtPlus = (target: ParsedPath, opts: { tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null } = {}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null, target,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Unknown.edit: writes entry with scope='session' and scheme='unknown'", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Unknown().edit(editStmt(urlPath("unknown", "/france/capital"), "What is the capital of France?", ["france"]), makeSchemeCtx({ db, sessionId, runId }));
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
        await u.edit(editStmt(urlPath("unknown", "/x"), "open question"), makeSchemeCtx({ db, sessionId, runId }));
        const Known = (await import("../../src/schemes/Known.ts")).default;
        await new Known().edit(editStmt(urlPath("known", "/x"), "known answer"), makeSchemeCtx({ db, sessionId, runId }));
        const rows = await (db.test_list_entry_schemes as PrepMethod).all<{ scheme: string }>();
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.scheme), ["known", "unknown"]);
    } finally { await db.close(); }
});

test("Unknown.edit: idempotent on same path", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const first = await u.edit(editStmt(urlPath("unknown", "/x"), "first"), makeSchemeCtx({ db, sessionId, runId }));
        const second = await u.edit(editStmt(urlPath("unknown", "/x"), "second"), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId);
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: first.entryId, name: "body" });
        assert.equal(channel?.content, "second");
    } finally { await db.close(); }
});

test("Unknown.edit: null path → 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        assert.equal((await u.edit({ ...editStmt(urlPath("unknown", "/x")), target: null }, makeSchemeCtx({ db, sessionId, runId }))).status, 400);
    } finally { await db.close(); }
});

test("Unknown.edit: lineMarker <-1> appends to existing entry", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit(editStmt(urlPath("unknown", "/x"), "one\ntwo"), makeSchemeCtx({ db, sessionId, runId }));
        const r = await u.edit({ ...editStmt(urlPath("unknown", "/x"), "three"), lineMarker: { marks: [-1] } }, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(r.status, 200);
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: r.entryId, name: "body" });
        assert.equal(channel?.content, "one\ntwo\nthree");
    } finally { await db.close(); }
});

test("Unknown.edit: tags merge additively", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const r = await u.edit(editStmt(urlPath("unknown", "/x"), "a", ["france"]), makeSchemeCtx({ db, sessionId, runId }));
        await u.edit(editStmt(urlPath("unknown", "/x"), "b", ["geography"]), makeSchemeCtx({ db, sessionId, runId }));
        const tags = await (db.test_list_entry_tags as PrepMethod).all<{ tag: string }>({ entry_id: r.entryId });
        assert.deepEqual(tags.map((t) => t.tag), ["france", "geography"]);
    } finally { await db.close(); }
});

test("Unknown.read: existing entry → 200; nonexistent → 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit(editStmt(urlPath("unknown", "/x"), "question"), makeSchemeCtx({ db, sessionId, runId }));
        const found = await u.read(readStmtPlus(urlPath("unknown", "/x")), makeSchemeCtx({ db, sessionId }));
        assert.equal(found.status, 200);
        assert.equal(found.content, "question");
        const missing = await u.read(readStmtPlus(urlPath("unknown", "/nope")), makeSchemeCtx({ db, sessionId }));
        assert.equal(missing.status, 404);
    } finally { await db.close(); }
});

test("Unknown.read: scheme isolation", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const Known = (await import("../../src/schemes/Known.ts")).default;
        await new Known().edit(editStmt(urlPath("known", "/iso"), "known content"), makeSchemeCtx({ db, sessionId, runId }));
        const result = await new Unknown().read(readStmtPlus(urlPath("unknown", "/iso")), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 404);
    } finally { await db.close(); }
});

test("Unknown.read: lineMarker, body matcher, tag filter — positive coverage", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit(editStmt(urlPath("unknown", "/lined"), "alpha\nbeta\ngamma"), makeSchemeCtx({ db, sessionId, runId }));
        const sliced = await u.read(readStmtPlus(urlPath("unknown", "/lined"), { lineMarker: { marks: [2] } }), makeSchemeCtx({ db, sessionId }));
        assert.equal(sliced.status, 200);
        assert.equal(sliced.content, "beta");
        assert.equal((sliced as { startLine?: number }).startLine, 2);

        await u.edit(editStmt(urlPath("unknown", "/m"), "match these alpha words"), makeSchemeCtx({ db, sessionId, runId }));
        const matched = await u.read(readStmtPlus(urlPath("unknown", "/m"), { body: { dialect: "regex", raw: "/alpha/", pattern: "alpha", flags: "" } }), makeSchemeCtx({ db, sessionId }));
        assert.equal(matched.status, 200);
        // READ returns the LINE (plurnk.md:31), not the matched token `alpha`.
        assert.equal(matched.content, "1:\tmatch these alpha words");

        await u.edit(editStmt(urlPath("unknown", "/t"), "tagged", ["france"]), makeSchemeCtx({ db, sessionId, runId }));
        const hit = await u.read(readStmtPlus(urlPath("unknown", "/t"), { tags: ["france"] }), makeSchemeCtx({ db, sessionId }));
        assert.equal(hit.status, 200);
        const miss = await u.read(readStmtPlus(urlPath("unknown", "/t"), { tags: ["germany"] }), makeSchemeCtx({ db, sessionId }));
        assert.equal(miss.status, 404);
    } finally { await db.close(); }
});
