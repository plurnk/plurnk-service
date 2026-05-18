import test from "node:test";
import assert from "node:assert/strict";
import type { HideStatement, LineMarker, MatcherBody, ParsedPath, ShowStatement } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";
import { urlPath, editStmt } from "./_dsl.ts";

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

const writeKnown = async (db: Db, ctx: { sessionId: number; runId: number }, pathname: string) =>
    new Known().edit({ db, statement: editStmt(urlPath("known", pathname), "x"), sessionId: ctx.sessionId, runId: ctx.runId });

const visibilityOf = async (db: Db, runId: number, entryId: number): Promise<number | undefined> => {
    const row = await (db.test_get_visibility as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: entryId, channel: "body" });
    return row?.indexed;
};

test("Known.show: null path returns 400", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().show({ db: ctx.db, statement: showStmt({ path: null }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 400);
    } finally { await ctx.db.close(); }
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
    } finally { await ctx.db.close(); }
});

test("Known.show: nonexistent entry returns 404", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/nope") }), sessionId: ctx.sessionId, runId: ctx.runId });
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
        const r = await k.show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
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
        const r = await k.show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 304);
    } finally { await ctx.db.close(); }
});

test("Known.show: empty tag signal ([]) treated as no filter — proceeds", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        await (ctx.db.test_set_visibility_indexed as PrepMethod).run({ run_id: ctx.runId, entry_id: edit.entryId, indexed: 0 });
        const r = await k.show({ db: ctx.db, statement: showStmt({ path: urlPath("known", "/x"), tags: [] }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 200);
    } finally { await ctx.db.close(); }
});

test("Known.hide: null path returns 400", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().hide({ db: ctx.db, statement: hideStmt({ path: null }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 400);
    } finally { await ctx.db.close(); }
});

test("Known.hide: nonexistent entry returns 404", async () => {
    const ctx = await setup();
    try {
        const r = await new Known().hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/nope") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 404);
    } finally { await ctx.db.close(); }
});

test("Known.hide: indexed entry → 200, flips indexed from 1 to 0", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 1);
        const r = await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 200);
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);
    } finally { await ctx.db.close(); }
});

test("Known.hide: already-archived entry returns 304", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        await writeKnown(ctx.db, ctx, "/x");
        await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        const r = await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r.status, 304);
    } finally { await ctx.db.close(); }
});

test("Known.show/hide: round-trip — show, hide, show alternates state and 200/304 statuses", async () => {
    const ctx = await setup();
    try {
        const k = new Known();
        const edit = await writeKnown(ctx.db, ctx, "/x");
        const path = urlPath("known", "/x");

        const r1 = await k.show({ db: ctx.db, statement: showStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r1.status, 304, "already indexed");

        const r2 = await k.hide({ db: ctx.db, statement: hideStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r2.status, 200);
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0);

        const r3 = await k.hide({ db: ctx.db, statement: hideStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(r3.status, 304, "already hidden");

        const r4 = await k.show({ db: ctx.db, statement: showStmt({ path }), sessionId: ctx.sessionId, runId: ctx.runId });
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

        await k.hide({ db: ctx.db, statement: hideStmt({ path: urlPath("known", "/x") }), sessionId: ctx.sessionId, runId: ctx.runId });
        assert.equal(await visibilityOf(ctx.db, ctx.runId, edit.entryId!), 0, "run A hidden");
        assert.equal(await visibilityOf(ctx.db, runB, edit.entryId!), undefined, "run B unaffected");
    } finally { await ctx.db.close(); }
});
