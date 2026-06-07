// Conformance tests for the canonical examples in plurnk.md.
//
// Each test reconstructs the world a plurnk.md example presupposes and asserts
// the behavior the example demonstrates. The worlds are built DISCRIMINATING:
// every matchable token lives in exactly one field (pathname XOR content), and
// the two fields are swapped between entries — so "match the pathname" and
// "match the content" return DISJOINT results. An implementation that matches
// the wrong field cannot pass by accident.
//
// Contract (plurnk.md §"Body matcher dispatch (FIND, READ, SHOW, HIDE)"): the
// (target) selects WHICH entries are candidates; the body matcher runs against
// the entry CONTENT. The canonical examples are unambiguous about this:
//   <<FIND(config/**/*.xml)://user[@role='admin']:FIND   — xpath over XML content
//   <<FIND(log://**/error):/timeout|deadline exceeded/i:FIND — regex over log content
//   <<SHOW[france](known://countries/**):Paris*:SHOW      — glob over entry content
// The path-globs live in the (target); the body is the content matcher.
//
// READ honors this (matchAgainstContent). FIND/SHOW/HIDE currently run the body
// matcher against the PATHNAME (_entry-find.ts:64-73) — so the FIND tests below
// are deferred-reds pinning that divergence until it is reconciled.

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

const findStmt = (target: UrlPath, body: MatcherBody | null): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target, lineMarker: null, body,
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

// --- FIND: body matcher MUST run against CONTENT (plurnk.md ex. above) --------
// Each world swaps the token between fields: the entry that matches by CONTENT
// is NOT the entry that matches by PATHNAME. Asserting the content-match result
// fails on the current pathname implementation, which is the point.

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

// plurnk.md: <<SHOW[france](known://countries/**):Paris*:SHOW (glob body) — same
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
