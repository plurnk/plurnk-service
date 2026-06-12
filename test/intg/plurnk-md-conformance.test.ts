// Conformance tests for the canonical examples in plurnk.md.
//
// Each test reconstructs the world a plurnk.md example presupposes and asserts
// the behavior the example demonstrates. The worlds are built DISCRIMINATING:
// every matchable token lives in exactly one field (pathname XOR content), and
// the two fields are swapped between entries — so "match the pathname" and
// "match the content" return DISJOINT results. An implementation that matches
// the wrong field cannot pass by accident.
//
// Contract (plurnk.md §"Body matcher dispatch (FIND, READ, OPEN, FOLD)"): the
// (target) selects WHICH entries are candidates; the body matcher runs against
// the entry CONTENT. The canonical examples are unambiguous about this:
//   <<FIND(config/**/*.xml)://user[@role='admin']:FIND   — xpath over XML content
//   <<FIND(log://**/error):/timeout|deadline exceeded/i:FIND — regex over log content
//   <<OPEN[france](known://countries/**):Paris*:OPEN      — glob over entry content
// The path-globs live in the (target); the body is the content matcher.
//
// All four honor this: READ via read-resolve, FIND/OPEN/FOLD via
// _entry-find.matchPathnames → matchAgainstContent against the candidate's
// CONTENT (_entry-find.ts:95). The body-on-pathname divergence these once
// pinned is reconciled — they are green pins now, not deferred-reds.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known://${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, body: MatcherBody | null, lineMarker: { first: number; last: number | null } | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target, lineMarker, body,
    position: { line: 1, column: 1 },
});

const readStmt = (target: UrlPath, body: MatcherBody | null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
const regex = (pattern: string, flags = ""): MatcherBody =>
    ({ dialect: "regex", raw: flags ? `/${pattern}/${flags}` : `/${pattern}/`, pattern, flags });

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

const seed = async (
    db: import("../../src/core/Db.ts").Db,
    sessionId: number,
    runId: number,
    entries: Array<[string, string]>,
) => {
    const k = new Known();
    for (const [pathname, content] of entries) {
        await k.edit(editStmt(url(pathname), content), makeSchemeCtx({ db, sessionId, runId }));
    }
};

// --- READ: body matcher runs against CONTENT (the contract; READ honors it) ---
// Anchors "correct." The matched token appears ONLY in the content; the
// pathname shares no character with it, so a pathname-matcher returns nothing.

test("[plurnk.md-READ-glob-on-content] READ glob body matches entry CONTENT, not pathname", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // pathname "doc" contains no "TODO"; only the content does.
        await seed(db, sessionId, runId, [["doc", "alpha\nTODO: ship\nbeta"]]);
        const r = await new Known().read(readStmt(url("doc"), glob("TODO*")), makeSchemeCtx({ db, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.content, "2:\tTODO: ship");
    } finally { db.close(); }
});

test("[plurnk.md-READ-regex-on-content] READ regex body matches entry CONTENT, not pathname", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // pathname "doc" contains no "timeout"; only the content does.
        await seed(db, sessionId, runId, [["doc", "alpha timeout beta"]]);
        const r = await new Known().read(readStmt(url("doc"), regex("timeout")), makeSchemeCtx({ db, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.content, "1:\ttimeout");
    } finally { db.close(); }
});

// plurnk.md: <<READ(/etc/hosts)<2>::READ — the line-slice rides the <L> marker
// slot (NOT the body matcher). Read line 2 of a 3-line entry → just that line.
// Pins the <L>?:body? slot order — the seam the live READ-<2> mis-slot exposed.
test("[plurnk.md-ex-READ-line-slice] READ <L> slices by line via the marker slot, not the body", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seed(db, sessionId, runId, [["lines", "alpha\nbeta\ngamma"]]);
        const stmt: ReadStatement = { op: "READ", suffix: "", signal: null, target: url("lines"), lineMarker: { first: 2, last: 2 }, body: null, position: { line: 1, column: 1 } };
        const r = await new Known().read(stmt, makeSchemeCtx({ db, sessionId }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /beta/);
        assert.doesNotMatch(r.content ?? "", /alpha|gamma/);
    } finally { db.close(); }
});

// --- FIND: body matcher runs against CONTENT (plurnk.md ex. above) --------
// Each world swaps the token between fields: the entry that matches by CONTENT
// is NOT the entry that matches by PATHNAME. The impl selects the content-bearing
// entry — a pathname-matcher (the old divergence) would return the other one.

// plurnk.md: <<FIND(log://**/error):/timeout|deadline exceeded/i:FIND
//   → select entries whose CONTENT matches the regex.
test("[plurnk.md-ex-FIND-regex-on-content] FIND regex body selects entries by CONTENT, not pathname", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seed(db, sessionId, runId, [
            ["alpha", "timeout occurred"], // content matches /timeout/; pathname does not
            ["timeout", "all clear"],      // pathname matches /timeout/; content does not
        ]);
        const r = await new Known().find(findStmt(url(""), regex("timeout")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://alpha"]);
    } finally { db.close(); }
});

// plurnk.md: <<OPEN[france](known://countries/**):Paris*:OPEN (glob body) — same
// dispatch as FIND; glob body selects entries whose CONTENT matches.
test("[plurnk.md-ex-FIND-glob-on-content] FIND glob body selects entries by CONTENT, not pathname", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seed(db, sessionId, runId, [
            ["france/capital", "Paris is the capital"], // content matches Paris*; pathname does not
            ["Paris/note", "see the capital"],          // pathname matches Paris*; content does not
        ]);
        const r = await new Known().find(findStmt(url(""), glob("Paris*")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://france/capital"]);
    } finally { db.close(); }
});

// --- FIND with structural dialects (jsonpath/xpath) over native content -------
// plurnk.md: <<FIND(config/**/*.xml)://user[@role='admin']:FIND — xpath over XML.
// The dialects route through the daughter's deep-json / deep-xml channels; these
// prove they are wired through FIND end-to-end on their native mimetypes (NOT 501).

test("[plurnk.md-ex-FIND-jsonpath-on-json] FIND jsonpath selects JSON entries by content structure", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // `.json` suffix → application/json mimetype → daughter's deep-json channel.
        await seed(db, sessionId, runId, [
            ["alice.json", '{"admin":true}'],
            ["bob.json", '{"guest":true}'],
        ]);
        const r = await new Known().find(findStmt(url(""), { dialect: "jsonpath", raw: "$.admin" }), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://alice.json"]);
    } finally { db.close(); }
});

test("[plurnk.md-ex-FIND-xpath-on-xml] FIND xpath selects XML entries by content structure", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // `.xml` suffix → application/xml mimetype → daughter's deep-xml channel.
        await seed(db, sessionId, runId, [
            ["a.xml", "<root><user>admin</user></root>"],
            ["b.xml", "<root><group>x</group></root>"],
        ]);
        const r = await new Known().find(findStmt(url(""), { dialect: "xpath", raw: "//user" }), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a.xml"]);
    } finally { db.close(); }
});

// --- Cross-dialect: the payoff of filtering the deep channels ourselves --------
// process() builds BOTH deepJson and deepXml for every type, and we run the
// dialect against the matching projection — so xpath works on a JSON doc and
// jsonpath on an XML doc. Source mimetype is irrelevant to the dialect.

test("[plurnk.md-ex-FIND-xpath-on-json] FIND xpath selects JSON entries by structure (over deepXml)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // JSON content → process() also yields deepXml (`<root><role>…</role></root>`); xpath runs over it.
        await seed(db, sessionId, runId, [
            ["a.json", '{"role":"admin"}'],
            ["b.json", '{"name":"guest"}'],
        ]);
        const r = await new Known().find(findStmt(url(""), { dialect: "xpath", raw: "//role" }), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a.json"]);
    } finally { db.close(); }
});

test("[plurnk.md-ex-FIND-jsonpath-on-xml] FIND jsonpath selects XML entries by structure (over deepJson)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // XML content → process() also yields deepJson (`…attrs.role`); jsonpath runs over it.
        await seed(db, sessionId, runId, [
            ["a.xml", '<root><user role="admin">x</user></root>'],
            ["b.xml", '<root><user name="guest">x</user></root>'],
        ]);
        const r = await new Known().find(findStmt(url(""), { dialect: "jsonpath", raw: "$..role" }), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a.xml"]);
    } finally { db.close(); }
});

// plurnk.md (grammar 0.21.0): `<<FIND(known://**)<5>:~french revolutionary history:FIND`
// — RAG semantic similarity, top-K via <L>. The feature is built (embeddings on by
// default); the full real-model pipeline is validated in test/live/semantic.test.ts.
// This tier is model-free by design — its Mimetypes declines the embeddings daughter
// — so the embedder is absent and ~query is a 501 here. Kept as a todo so the grammar
// example stays pinned; it is green against the real model in the live tier.
test("[plurnk.md-ex-FIND-rag] FIND ~query selects entries by semantic similarity", { todo: "model-free intg → embedder absent (501); real-model coverage in test/live/semantic.test.ts" }, async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seed(db, sessionId, runId, [
            ["a", "the french revolution and the storming of the bastille"],
            ["b", "a recipe for chocolate cake"],
        ]);
        const r = await new Known().find(findStmt(url(""), { dialect: "semantic", raw: "~french revolutionary history" }, { first: 5, last: null }), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, ["known://a"]);
    } finally { db.close(); }
});
