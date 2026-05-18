// Tests for FIND on entry-bearing schemes (SPEC §6.6).

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known://${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (path: UrlPath, body: string, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const findStmt = (path: UrlPath, body: MatcherBody | null = null, signal: string[] | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
const regex = (raw: string): MatcherBody => ({ dialect: "regex", raw: `/${raw}/`, pattern: raw, flags: "" });

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

const seedEntries = async (db: import("../../src/core/Db.ts").Db, sessionId: number, runId: number, entries: Array<[string, string, string[]?]>) => {
    const k = new Known();
    for (const [pathname, body, tags] of entries) {
        await k.edit({ db, sessionId, runId, statement: editStmt(url(pathname), body, tags ?? null) });
    }
};

test("Known.find returns all entries when scope is broad and no matcher", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [
            ["a", "alpha"], ["b", "beta"], ["c", "gamma"],
        ]);
        const r = await new Known().find({ db, statement: findStmt(url("")), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a", "known://b", "known://c"]);
        assert.equal(r.mimetype, "text/plain");
        assert.equal(r.content, "known://a\nknown://b\nknown://c");
    } finally { db.close(); }
});

test("[§6.6-scope-prefix-filter] Known.find with scope prefix filters to that subtree", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [
            ["plan/step1", "x"], ["plan/step2", "y"], ["other/thing", "z"],
        ]);
        const r = await new Known().find({ db, statement: findStmt(url("plan/")), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://plan/step1", "known://plan/step2"]);
    } finally { db.close(); }
});

test("[§6.6-glob-filter-on-pathname] Known.find with glob matcher filters by pattern", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [
            ["france", "x"], ["france/capital", "y"], ["italy", "z"],
        ]);
        const r = await new Known().find({ db, statement: findStmt(url(""), glob("france*")), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://france", "known://france/capital"]);
    } finally { db.close(); }
});

test("[§6.6-tag-filter-and-semantics] Known.find with tag filter — AND semantics", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [
            ["a", "x", ["urgent", "europe"]],
            ["b", "y", ["urgent"]],
            ["c", "z", ["europe"]],
            ["d", "w", ["urgent", "europe", "answer"]],
        ]);
        // Both tags must be present
        const r = await new Known().find({ db, statement: findStmt(url(""), null, ["urgent", "europe"]), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a", "known://d"]);
    } finally { db.close(); }
});

test("Known.find combining glob + tag filter", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [
            ["plan/step1", "x", ["urgent"]],
            ["plan/step2", "y", ["later"]],
            ["other/thing", "z", ["urgent"]],
        ]);
        const r = await new Known().find({ db, statement: findStmt(url(""), glob("plan/*"), ["urgent"]), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://plan/step1"]);
    } finally { db.close(); }
});

test("[§6.6-non-glob-dialects-501] Known.find with regex matcher returns 501 (deferred)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "x"]]);
        const r = await new Known().find({ db, statement: findStmt(url(""), regex("a")), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 501);
    } finally { db.close(); }
});

test("Known.find with no matches returns 200 with empty results", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "x"]]);
        const r = await new Known().find({ db, statement: findStmt(url(""), glob("nope*")), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, []);
        assert.equal(r.content, "");
    } finally { db.close(); }
});

test("[§6.6-scoped-isolation] Known.find is scoped to the session (doesn't leak across sessions)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // Seed in this session
        await seedEntries(db, sessionId, runId, [["here", "x"]]);

        // Create another session and seed there
        const otherSessionId = await insertSession(db, "other-session");
        const otherRunId = await insertRun(db, otherSessionId);
        const k = new Known();
        await k.edit({ db, sessionId: otherSessionId, runId: otherRunId, statement: editStmt(url("elsewhere"), "y") });

        const r = await k.find({ db, statement: findStmt(url("")), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://here"], "only entries from this session");
    } finally { db.close(); }
});

test("Known.find is scoped to the scheme (doesn't leak across schemes)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["here-known", "x"]]);

        // Seed an unknown entry under the same session
        const Unknown = (await import("../../src/schemes/Unknown.ts")).default;
        await new Unknown().edit({ db, sessionId, runId, statement: { ...editStmt(url("here-unknown"), "y"), path: { ...url("here-unknown"), scheme: "unknown", raw: "unknown://here-unknown" } } });

        const r = await new Known().find({ db, statement: findStmt(url("")), sessionId, runId, loopId: 0, turnId: 0 });
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://here-known"]);
    } finally { db.close(); }
});
