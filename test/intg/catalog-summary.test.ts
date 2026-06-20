// engine_scheme_catalog_summary — the data half of the # Plurnk System Catalog section
// (§packet). A per-scheme tally (distinct entries + summed stored tokens) so the model sees
// which schemes hold content without probing FIND(known://**) every turn.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import Known from "../../src/schemes/Known.ts";
import Unknown from "../../src/schemes/Unknown.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}:///${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("[catalog] engine_scheme_catalog_summary tallies distinct entries + summed tokens per scheme", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `catalog-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        // makeSchemeCtx tokenizes as ceil(len/4): "alpha beta"(10)=3 + "gamma"(5)=2 → known 5;
        // "an open question"(16)=4 → unknown 4.
        await new Known().edit(editStmt(url("known", "a.md"), "alpha beta"), ctx);
        await new Known().edit(editStmt(url("known", "b.md"), "gamma"), ctx);
        await new Unknown().edit(editStmt(url("unknown", "q"), "an open question"), ctx);

        const rows = await (db.engine_scheme_catalog_summary as PrepMethod).all<{ scheme: string | null; entries: number; tokens: number }>({ session_id: sessionId });
        const byScheme = new Map(rows.map((r) => [r.scheme, r]));
        assert.equal(byScheme.get("known")?.entries, 2, "two known entries tallied as distinct");
        assert.equal(byScheme.get("known")?.tokens, 5, "known body tokens summed (3 + 2)");
        assert.equal(byScheme.get("unknown")?.entries, 1, "one unknown entry tallied");
        assert.equal(byScheme.get("unknown")?.tokens, 4, "unknown body tokens summed");
    } finally { db.close(); }
});
