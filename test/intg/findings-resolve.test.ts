// Project Findings, phase 2a — the finding resolver: a matched entry's hit lines become
// findings, each addressed by its smallest enclosing symbol (or the line itself when none
// covers it). Many hits in one symbol collapse to one finding. Built on phase 1's
// enclosingSymbol; phase 2b wires it into the FIND result shape (results: Finding[]).

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import EntryGraph from "../../src/schemes/_entry-graph.ts";
import EntryFind from "../../src/schemes/_entry-find.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (p: string): UrlPath => ({ kind: "url", raw: `known:///${p}`, scheme: "known", username: null, password: null, hostname: null, port: null, pathname: `/${p}`, params: {}, fragment: null });
const editStmt = (target: UrlPath, body: string): EditStatement => ({ op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 } });

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
