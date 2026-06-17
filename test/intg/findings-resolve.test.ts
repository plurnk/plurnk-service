// Project Findings, phase 2a — the finding resolver: a matched entry's hit lines become
// findings, each addressed by its smallest enclosing symbol (or the line itself when none
// covers it). Many hits in one symbol collapse to one finding. Built on phase 1's
// enclosingSymbol; phase 2b wires it into the FIND result shape (results: Finding[]).

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import EntryGraph from "../../src/schemes/_entry-graph.ts";
import EntryFind from "../../src/schemes/_entry-find.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (p: string): UrlPath => ({ kind: "url", raw: `known:///${p}`, scheme: "known", username: null, password: null, hostname: null, port: null, pathname: `/${p}`, params: {}, fragment: null });
const editStmt = (target: UrlPath, body: string): EditStatement => ({ op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 } });
const findStmt = (target: UrlPath, body: MatcherBody | null): FindStatement => ({ op: "FIND", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 } });
const regex = (pattern: string): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" });

test("[findings] findingsForMatch maps hit lines to enclosing-symbol findings, deduped by extent", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `findings-resolve-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        await new Known().edit(editStmt(url("code.ts"), "x"), ctx);
        const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: "/code.ts" });
        assert.ok(entry !== undefined, "the entry exists");

        // A function 10–20 with a nested method 12–15.
        await EntryGraph.populateFrom(db, sessionId, entry!.id, [
            { name: "outer", kind: "function", line: 10, endLine: 20 },
            { name: "inner", kind: "method", line: 12, endLine: 15 },
        ], []);

        const path = "known:///code.ts";
        // Hits at 13 & 14 both fall in `inner` → one finding; 18 → `outer`; 5 → no symbol.
        const findings = await EntryFind.findingsForMatch(db, entry!.id, path, [13, 14, 18, 5]);

        assert.deepEqual(findings, [
            { path, extent: { first: 12, last: 15 }, symbol: "inner" },
            { path, extent: { first: 10, last: 20 }, symbol: "outer" },
            { path, extent: { first: 5, last: 5 } },
        ], "two hits in inner collapse to one finding; outer is its own; the uncovered line is its own extent with no symbol");
    } finally { await db.close(); }
});

test("[findings] FIND returns structured findings end-to-end — extent + symbol, rendered as an address", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `findings-shape-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        await new Known().edit(editStmt(url("doc.txt"), "line one\nthe needle is here\nline three"), ctx);
        const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: "/doc.txt" });
        // A block symbol spanning all three lines — the needle (a content hit) sits inside it.
        await EntryGraph.populateFrom(db, sessionId, entry!.id, [{ name: "block", kind: "function", line: 1, endLine: 3 }], []);

        const r = await new Known().find(findStmt(url(""), regex("needle")), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results, [{ path: "known:///doc.txt", extent: { first: 1, last: 3 }, symbol: "block" }], "the content hit resolves to its enclosing structural unit, not a bare path");
        assert.equal(r.content, "known:///doc.txt<1,3> (block)", "and renders as a usable <L> address carrying the symbol name");
    } finally { await db.close(); }
});
