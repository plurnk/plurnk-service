import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, LineMarker, MatcherBody, ParsedPath, ReadStatement, ShowStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Unknown from "../../src/schemes/Unknown.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (path: ParsedPath, body: string | null = null, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const readStmt = (path: ParsedPath, opts: { tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null } = {}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null, path,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const showStmt = (path: ParsedPath | null): ShowStatement => ({
    op: "SHOW", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const hideStmt = (path: ParsedPath | null): HideStatement => ({
    op: "HIDE", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

const visibilityOf = (db: DatabaseSync, runId: number, entryId: number): number | undefined => {
    const row = db.prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ? AND channel = 'body'").get(runId, entryId) as { indexed: number } | undefined;
    return row?.indexed;
};

// ----------------------------------------------------------------- edit

test("Unknown.edit: writes entry with scope='session' and scheme='unknown'", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Unknown().edit({ db, statement: editStmt(urlPath("unknown", "/france/capital"), "What is the capital of France?", ["france"]), sessionId, runId });
        assert.equal(r.status, 201);
        const entry = db.prepare("SELECT scope, scheme, pathname FROM entries WHERE id = ?").get(r.entryId) as { scope: string; scheme: string; pathname: string };
        assert.equal(entry.scope, "session");
        assert.equal(entry.scheme, "unknown");
        assert.equal(entry.pathname, "/france/capital");
        const content = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(r.entryId) as { content: string }).content;
        assert.equal(content, "What is the capital of France?");
    } finally { db.close(); }
});

test("Unknown.edit: entries with same pathname are scheme-isolated (known and unknown can both hold a path)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "open question"), sessionId, runId });
        const Known = (await import("../../src/schemes/Known.ts")).default;
        await new Known().edit({ db, statement: editStmt(urlPath("known", "/x"), "known answer"), sessionId, runId });
        const rows = db.prepare("SELECT scheme, pathname FROM entries ORDER BY scheme").all() as { scheme: string; pathname: string }[];
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.scheme), ["known", "unknown"]);
    } finally { db.close(); }
});

test("Unknown.edit: idempotent on same path — second edit returns 200 and replaces body", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const first = await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "first"), sessionId, runId });
        const second = await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "second"), sessionId, runId });
        assert.equal(first.status, 201);
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId);
        const body = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(first.entryId) as { content: string }).content;
        assert.equal(body, "second");
    } finally { db.close(); }
});

test("Unknown.edit: null path → 400; lineMarker → 501", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        assert.equal((await u.edit({ db, statement: { ...editStmt(urlPath("unknown", "/x")), path: null }, sessionId, runId })).status, 400);
        assert.equal((await u.edit({ db, statement: { ...editStmt(urlPath("unknown", "/x"), "x"), lineMarker: { first: 5, last: null } }, sessionId, runId })).status, 501);
    } finally { db.close(); }
});

test("Unknown.edit: tags merge additively; visibility set to indexed=1", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const r = await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "a", ["france"]), sessionId, runId });
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "b", ["geography"]), sessionId, runId });
        const tags = db.prepare("SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag").all(r.entryId) as { tag: string }[];
        assert.deepEqual(tags.map((t) => t.tag), ["france", "geography"]);
        assert.equal(visibilityOf(db, runId, r.entryId!), 1);
    } finally { db.close(); }
});

// ----------------------------------------------------------------- read

test("Unknown.read: existing entry → 200 with content; nonexistent → 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "question"), sessionId, runId });
        const found = await u.read({ db, statement: readStmt(urlPath("unknown", "/x")), sessionId });
        assert.equal(found.status, 200);
        assert.equal(found.content, "question");
        const missing = await u.read({ db, statement: readStmt(urlPath("unknown", "/nope")), sessionId });
        assert.equal(missing.status, 404);
    } finally { db.close(); }
});

test("Unknown.read: scheme isolation — known://x not visible to unknown.read", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const Known = (await import("../../src/schemes/Known.ts")).default;
        await new Known().edit({ db, statement: editStmt(urlPath("known", "/iso"), "known content"), sessionId, runId });
        const result = await new Unknown().read({ db, statement: readStmt(urlPath("unknown", "/iso")), sessionId });
        assert.equal(result.status, 404);
    } finally { db.close(); }
});

test("Unknown.read: all 501 modes (lineMarker, body matcher, non-empty tags)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        await u.edit({ db, statement: editStmt(urlPath("unknown", "/x"), "data"), sessionId, runId });
        const path = urlPath("unknown", "/x");
        assert.equal((await u.read({ db, statement: readStmt(path, { lineMarker: { first: 1, last: null } }), sessionId })).status, 501);
        assert.equal((await u.read({ db, statement: readStmt(path, { body: { dialect: "glob", raw: "*" } }), sessionId })).status, 501);
        assert.equal((await u.read({ db, statement: readStmt(path, { tags: ["any"] }), sessionId })).status, 501);
    } finally { db.close(); }
});

// ----------------------------------------------------------------- show/hide

test("Unknown.show/hide: round-trip — show(304) → hide(200) → hide(304) → show(200)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        const r = await u.edit({ db, statement: editStmt(urlPath("unknown", "/v"), "x"), sessionId, runId });
        const path = urlPath("unknown", "/v");
        assert.equal((await u.show({ db, statement: showStmt(path), sessionId, runId })).status, 304, "edit-set visibility = indexed; show is no-op");
        assert.equal((await u.hide({ db, statement: hideStmt(path), sessionId, runId })).status, 200);
        assert.equal(visibilityOf(db, runId, r.entryId!), 0);
        assert.equal((await u.hide({ db, statement: hideStmt(path), sessionId, runId })).status, 304);
        assert.equal((await u.show({ db, statement: showStmt(path), sessionId, runId })).status, 200);
        assert.equal(visibilityOf(db, runId, r.entryId!), 1);
    } finally { db.close(); }
});

test("Unknown.show: nonexistent entry → 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Unknown().show({ db, statement: showStmt(urlPath("unknown", "/nope")), sessionId, runId });
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("Unknown.show/hide: null path → 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const u = new Unknown();
        assert.equal((await u.show({ db, statement: showStmt(null), sessionId, runId })).status, 400);
        assert.equal((await u.hide({ db, statement: hideStmt(null), sessionId, runId })).status, 400);
    } finally { db.close(); }
});
