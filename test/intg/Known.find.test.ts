// Tests for FIND on entry-bearing schemes (SPEC §6.6).

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known://${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (target: UrlPath, body: string, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, body: MatcherBody | null = null, signal: string[] | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal, target, lineMarker: null, body,
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
        await k.edit(editStmt(url(pathname), body, tags ?? null), makeSchemeCtx({ db, sessionId, runId }));
    }
};

test("Known.find returns all entries when scope is broad and no matcher", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [
            ["a", "alpha"], ["b", "beta"], ["c", "gamma"],
        ]);
        const r = await new Known().find(findStmt(url("")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
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
        const r = await new Known().find(findStmt(url("plan/")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://plan/step1", "known://plan/step2"]);
    } finally { db.close(); }
});

test("[§6.6-glob-filter-on-content] Known.find with glob matcher filters by CONTENT", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // Pathnames are neutral (a/b/c); the matchable token lives in the content.
        await seedEntries(db, sessionId, runId, [
            ["a", "france is the topic"], ["b", "france and germany"], ["c", "italy only"],
        ]);
        const r = await new Known().find(findStmt(url(""), glob("france*")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results.toSorted(), ["known://a", "known://b"]);
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
        const r = await new Known().find(findStmt(url(""), null, ["urgent", "europe"]), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a", "known://d"]);
    } finally { db.close(); }
});

test("Known.find combining glob (content) + tag filter", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [
            ["s1", "plan alpha", ["urgent"]],
            ["s2", "plan beta", ["later"]],
            ["s3", "other thing", ["urgent"]],
        ]);
        // glob matches content "plan*"; tag narrows to urgent → only s1 satisfies both.
        const r = await new Known().find(findStmt(url(""), glob("plan*"), ["urgent"]), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://s1"]);
    } finally { db.close(); }
});

test("Known.find with regex matcher filters by CONTENT", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "alpha"], ["b", "beta"], ["c", "aardvark"]]);
        const r = await new Known().find(findStmt(url(""), regex("^a")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results.toSorted(), ["known://a", "known://c"]);
    } finally { db.close(); }
});

test("Known.find regex honors flags — case-insensitive (i) on content", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "Alpha"], ["b", "alpine"], ["c", "beta"]]);
        // `i` must match "Alpha" (capital A) against /^al/ — the flag crosses into
        // the daughter's content regex; without it, `^al` would skip "Alpha".
        const ci: MatcherBody = { dialect: "regex", raw: "/^al/i", pattern: "^al", flags: "i" };
        const r = await new Known().find(findStmt(url(""), ci), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results.toSorted(), ["known://a", "known://b"]);
    } finally { db.close(); }
});

test("Known.find regex accepts `g` flag on content (no throw)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "foo here"], ["b", "a foo"], ["c", "bar"]]);
        // `g` doesn't change hit/no-hit for entry selection; it must not throw.
        const g: MatcherBody = { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" };
        const r = await new Known().find(findStmt(url(""), g), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results.toSorted(), ["known://a", "known://b"]);
    } finally { db.close(); }
});

test("Known.find regex `y` (sticky) anchors at content start", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "foobar"], ["b", "a foobar"]]);
        // sticky → match only at position 0 of the content, not anywhere.
        const y: MatcherBody = { dialect: "regex", raw: "/foo/y", pattern: "foo", flags: "y" };
        const r = await new Known().find(findStmt(url(""), y), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a"]);
    } finally { db.close(); }
});

test("Known.find xpath matcher with no structural match → entry excluded (200, empty)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // xpath runs over the markdown deepXml; `//x` matches no element →
        // no content hit → excluded.
        await seedEntries(db, sessionId, runId, [["a", "plain text"]]);
        const r = await new Known().find(findStmt(url(""), { dialect: "xpath", raw: "//x" }), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, []);
    } finally { db.close(); }
});

test("Known.find with <L> paginates results", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
        const stmt = { ...findStmt(url(""), null), lineMarker: { first: 2, last: 3 } };
        const r = await new Known().find(stmt, makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://b", "known://c"]);
    } finally { db.close(); }
});

test("Known.find with no matches returns 200 with empty results", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedEntries(db, sessionId, runId, [["a", "x"]]);
        const r = await new Known().find(findStmt(url(""), glob("nope*")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
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
        await k.edit(editStmt(url("elsewhere"), "y"), makeSchemeCtx({ db, sessionId: otherSessionId, runId: otherRunId }));

        const r = await k.find(findStmt(url("")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
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
        await new Unknown().edit({ ...editStmt(url("here-unknown"), "y"), target: { ...url("here-unknown"), scheme: "unknown", raw: "unknown://here-unknown" } }, makeSchemeCtx({ db, sessionId, runId }));

        const r = await new Known().find(findStmt(url("")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://here-known"]);
    } finally { db.close(); }
});
