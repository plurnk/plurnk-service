// engine_scheme_catalog_summary — the per-scheme entry tally that sources the turn-0 foist,
// so the model sees which schemes hold content without probing FIND(known://**) every turn.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import Known from "../../src/schemes/Known.ts";
import Unknown from "../../src/schemes/Unknown.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}:///${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("[catalog] engine_scheme_catalog_summary tallies distinct entries per scheme", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `catalog-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Known().edit(editStmt(url("known", "a.md"), "alpha beta"), ctx);
        await new Known().edit(editStmt(url("known", "b.md"), "gamma"), ctx);
        await new Unknown().edit(editStmt(url("unknown", "q"), "an open question"), ctx);

        const rows = await (db.engine_scheme_catalog_summary as PrepMethod).all<{ scheme: string | null; entries: number }>({ workspace_id: workspaceId });
        const byScheme = new Map(rows.map((r) => [r.scheme, r]));
        assert.equal(byScheme.get("known")?.entries, 2, "two known entries tallied as distinct");
        assert.equal(byScheme.get("unknown")?.entries, 1, "one unknown entry tallied");
    } finally { db.close(); }
});
