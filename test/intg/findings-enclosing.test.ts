// Project Findings, phase 1 — the smallest-enclosing-symbol resolution: given (entry,
// line), the tightest symbol_def covering it. This is the substrate the structured
// FindResult will use — a match at line N becomes a finding addressed by its enclosing
// structural unit (function/class/heading) rather than a bare pathname.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import EntryGraph from "../../src/schemes/_entry-graph.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (p: string): UrlPath => ({ kind: "url", raw: `known:///${p}`, scheme: "known", username: null, password: null, hostname: null, port: null, pathname: `/${p}`, params: {}, fragment: null });
const editStmt = (target: UrlPath, body: string): EditStatement => ({ op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 } });

test("[findings] enclosingSymbol returns the tightest symbol covering a line; null outside any", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `findings-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        await new Known().edit(editStmt(url("code.ts"), "x"), ctx);
        const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: "/code.ts" });
        assert.ok(entry !== undefined, "the entry exists");

        // A function spanning 10–20 with a nested method 12–15.
        await EntryGraph.populateFrom(db, sessionId, entry!.id, [
            { name: "outer", kind: "function", line: 10, endLine: 20 },
            { name: "inner", kind: "method", line: 12, endLine: 15 },
        ], []);

        assert.deepEqual(await EntryGraph.enclosingSymbol(db, entry!.id, 13), { name: "inner", kind: "method", line: 12, endLine: 15 }, "a line inside both resolves to the TIGHTEST (nested) symbol");
        assert.deepEqual(await EntryGraph.enclosingSymbol(db, entry!.id, 18), { name: "outer", kind: "function", line: 10, endLine: 20 }, "a line in only the outer span resolves to it");
        assert.equal(await EntryGraph.enclosingSymbol(db, entry!.id, 5), null, "a line covered by no symbol → null (the finding's extent will be the match line)");
    } finally { await db.close(); }
});
