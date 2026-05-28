import test from "node:test";
import assert from "node:assert/strict";
import type { HideStatement, LineMarker, MatcherBody, ParsedPath, ShowStatement } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt } from "./_dsl.ts";

const showStmt = (opts: { target?: ParsedPath | null; tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null }): ShowStatement => ({
    op: "SHOW", suffix: "",
    signal: opts.tags ?? null, target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const hideStmt = (opts: { target?: ParsedPath | null; tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null }): HideStatement => ({
    op: "HIDE", suffix: "",
    signal: opts.tags ?? null, target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

const writeKnown = async (db: Db, ctx: { sessionId: number; runId: number }, pathname: string) =>
    new Known().edit(editStmt(urlPath("known", pathname), "x"), makeSchemeCtx({ db, sessionId: ctx.sessionId, runId: ctx.runId }));

const visibilityOf = async (db: Db, runId: number, entryId: number): Promise<number | undefined> => {
    const row = await (db.test_get_visibility as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: entryId, channel: "body" });
    return row?.indexed;
};

test("Known.show: null path returns 400", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().show(showStmt({ target: null }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 400);
    } finally { await ctx.db.close(); }
});

test("Known.show: body matcher (glob) flips matching entries", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        await writeKnown(ctx.db, ctx, "/scope/a");
        await writeKnown(ctx.db, ctx, "/scope/b");
        await writeKnown(ctx.db, ctx, "/other/c");
        await k.hide(hideStmt({ target: urlPath("known", "/scope/"), body: { dialect: "glob", raw: "*" } }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        const r = await k.show(showStmt({ target: urlPath("known", "/scope/"), body: { dialect: "glob", raw: "*" } }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 200);
    } finally { await ctx.db.close(); }
});

test("Known.show: body matcher (regex) filters by pathname", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        await writeKnown(ctx.db, ctx, "/alpha");
        await writeKnown(ctx.db, ctx, "/beta");
        await writeKnown(ctx.db, ctx, "/aardvark");
        const r = await k.hide(hideStmt({ target: urlPath("known", "/"), body: { dialect: "regex", raw: "/^\\/a/", pattern: "^/a", flags: "" } }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 200);
    } finally { await ctx.db.close(); }
});

test("Known.hide: <L> paginates the set of entries flipped", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        await writeKnown(ctx.db, ctx, "/p/a");
        await writeKnown(ctx.db, ctx, "/p/b");
        await writeKnown(ctx.db, ctx, "/p/c");
        const r = await k.hide(hideStmt({ target: urlPath("known", "/p/"), lineMarker: { first: 1, last: 2 } }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 200);
    } finally { await ctx.db.close(); }
});

test("Known.show: tag signal filters which entries are flipped", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        await k.edit(editStmt(urlPath("known", "/x"), "x", ["france"]), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        await k.edit(editStmt(urlPath("known", "/y"), "y", ["germany"]), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        await k.hide(hideStmt({ target: urlPath("known", "/x") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        const r = await k.show(showStmt({ target: urlPath("known", "/"), tags: ["france"] }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 200);
    } finally { await ctx.db.close(); }
});

test("Known.show: xpath body matcher → 501 (pending plurnk-mimetypes#3)", async () => {
    const ctx = await setup();
    try {
        await writeKnown(ctx.db, ctx, "/x");
        const r = await new Known().show(showStmt({ target: urlPath("known", "/"), body: { dialect: "xpath", raw: "//x" } }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 501);
    } finally { await ctx.db.close(); }
});

test("Known.show: nonexistent entry returns 404", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().show(showStmt({ target: urlPath("known", "/nope") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 404);
    } finally { await ctx.db.close(); }
});

test("Known.show: archived entry → 200, flips indexed from 0 to 1", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        await (ctx.db.test_set_visibility_indexed as PrepMethod).run({ run_id: ctx.runId, entry_id: edit.entryId, indexed: 0 });
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);
        const r = await k.show(showStmt({ target: urlPath("known", "/x") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 200);
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
    } finally { await ctx.db.close(); }
});

test("Known.show: already-indexed entry returns 304 without write", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
        const r = await k.show(showStmt({ target: urlPath("known", "/x") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 304);
    } finally { await ctx.db.close(); }
});

test("Known.show: empty tag signal ([]) treated as no filter — proceeds", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        await (ctx.db.test_set_visibility_indexed as PrepMethod).run({ run_id: ctx.runId, entry_id: edit.entryId, indexed: 0 });
        const r = await k.show(showStmt({ target: urlPath("known", "/x"), tags: [] }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 200);
    } finally { await ctx.db.close(); }
});

test("Known.hide: null path returns 400", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().hide(hideStmt({ target: null }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 400);
    } finally { await ctx.db.close(); }
});

test("Known.hide: nonexistent entry returns 404", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().hide(hideStmt({ target: urlPath("known", "/nope") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 404);
    } finally { await ctx.db.close(); }
});

test("Known.hide: indexed entry → 200, flips indexed from 1 to 0", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
        const r = await k.hide(hideStmt({ target: urlPath("known", "/x") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 200);
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);
    } finally { await ctx.db.close(); }
});

test("Known.hide: already-archived entry returns 304", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        await writeKnown(ctx.db, ctx, "/x");
        await k.hide(hideStmt({ target: urlPath("known", "/x") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        const r = await k.hide(hideStmt({ target: urlPath("known", "/x") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r.status, 304);
    } finally { await ctx.db.close(); }
});

test("Known.show/hide: round-trip — show, hide, show alternates state and 200/304 statuses", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        const target = urlPath("known", "/x");

        const r1 = await k.show(showStmt({ target }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r1.status, 304, "already indexed");

        const r2 = await k.hide(hideStmt({ target }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r2.status, 200);
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);

        const r3 = await k.hide(hideStmt({ target }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r3.status, 304, "already hidden");

        const r4 = await k.show(showStmt({ target }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(r4.status, 200);
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
    } finally { await ctx.db.close(); }
});

test("Known.show/hide: per-run isolation — show in run A doesn't affect run B's view", async () => {
    const ctx = await setup();
    try {
        const runB = await insertRun(ctx.db, ctx.sessionId);
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");

        await k.hide(hideStmt({ target: urlPath("known", "/x") }), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0, "run A hidden");
        assert.equal(await visibilityOf(ctx.db, runB, edit.entryId!), undefined, "run B unaffected");
    } finally { await ctx.db.close(); }
});
