import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, LineMarker, MatcherBody, ParsedPath, ShowStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (path: ParsedPath, body: string | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const showStmt = (opts: { path?: ParsedPath | null; tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null }): ShowStatement => ({
    op: "SHOW", suffix: "",
    signal: opts.tags ?? null, path: opts.path ?? null,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const hideStmt = (opts: { path?: ParsedPath | null; tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null }): HideStatement => ({
    op: "HIDE", suffix: "",
    signal: opts.tags ?? null, path: opts.path ?? null,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

const writeKnown = async (db: DatabaseSync, ctx: { sessionId: number; runId: number }, pathname: string) => {
    return new Known().edit({ db, statement: editStmt(urlPath("known", pathname), "x"), sessionId: ctx.sessionId, runId: ctx.runId });
};

const visibilityOf = (db: DatabaseSync, runId: number, entryId: number): number | undefined => {
    const row = db.prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ? AND channel = 'body'").get(runId, entryId) as { indexed: number } | undefined;
    return row?.indexed;
};

// -------------------------------------------------------------- SHOW

test("Known.show: null path returns 400", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().show({ db: ctx.db, statement: showStmt({ path: null }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 400);
    } finally { ctx.db.close(); }
});

test("Known.show: lineMarker / body matcher / non-empty tag signal all return 501", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const path = urlPath("known", "/x");
        const matcher: MatcherBody = { dialect: "glob", raw: "x*" };
        assert.equal((await k.show({ db: ctx.db, statement: showStmt({ path, lineMarker: { first: 1, last: null } }), sessionId: ctx.sessionId, runId: ctx.runId })).status, 501);
        assert.equal((await k.show({ db: ctx.db, statement: showStmt({ path, body: matcher }), sessionId: ctx.sessionId, runId: ctx.runId })).status, 501);
        assert.equal((await k.show({ db: ctx.db, statement: showStmt({ path, tags: ["france"] }), sessionId: ctx.sessionId, runId: ctx.runId })).status, 501);
    } finally { ctx.db.close(); }
});

test("Known.show: nonexistent entry returns 404", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/nope") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 404);
    } finally { ctx.db.close(); }
});

test("Known.show: archived entry → 200, flips indexed from 0 to 1", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        ctx.db.prepare("UPDATE visibility SET indexed = 0 WHERE run_id = ? AND entry_id = ?").run(ctx.runId, edit.entryId);
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);
        const r = await k.show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 200);
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
    } finally { ctx.db.close(); }
});

test("Known.show: already-indexed entry returns 304 without write", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");  // edit sets visibility to indexed=1 by default
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
        const r = await k.show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 304);
    } finally { ctx.db.close(); }
});

test("Known.show: empty tag signal ([]) treated as no filter — proceeds", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        ctx.db.prepare("UPDATE visibility SET indexed = 0 WHERE run_id = ? AND entry_id = ?").run(ctx.runId, edit.entryId);
        const r = await k.show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/x"), tags: [] }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 200);
    } finally { ctx.db.close(); }
});

// -------------------------------------------------------------- HIDE

test("Known.hide: null path returns 400", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().hide({ db: ctx.db, statement: hideStmt({ path: null }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 400);
    } finally { ctx.db.close(); }
});

test("Known.hide: nonexistent entry returns 404", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/nope") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 404);
    } finally { ctx.db.close(); }
});

test("Known.hide: indexed entry → 200, flips indexed from 1 to 0", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
        const r = await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 200);
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);
    } finally { ctx.db.close(); }
});

test("Known.hide: already-archived entry returns 304", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        const r = await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 304);
    } finally { ctx.db.close(); }
});

// -------------------------------------------------------------- round-trip

test("Known.show/hide: round-trip — show, hide, show alternates state and 200/304 statuses", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");  // indexed=1
        const path = urlPath("known", "/x");

        const r1 = await k.show({ db: ctx.db, statement: showStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r1.status, 304, "already indexed");

        const r2 = await k.hide({ db: ctx.db, statement: hideStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r2.status, 200);
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);

        const r3 = await k.hide({ db: ctx.db, statement: hideStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r3.status, 304, "already hidden");

        const r4 = await k.show({ db: ctx.db, statement: showStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r4.status, 200);
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
    } finally { ctx.db.close(); }
});

test("Known.show/hide: per-run isolation — show in run A doesn't affect run B's view", async () => {
    const ctx = await setup();
    try {
        const runB = await insertRun(ctx.db, ctx.sessionId);
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");  // run A: indexed=1
        // run B has no visibility row for this entry yet

        await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0, "run A hidden");
        assert.equal(visibilityOf(ctx.db, runB, edit.entryId!), undefined, "run B unaffected");
    } finally { ctx.db.close(); }
});
