// §semantic-fts-at-write — the keyword half of the ~fusion indexes AT THE WRITE, so a
// cold workspace's first query narrows over everything ever written (no pump required).
// Default test env: embedder OFF → the ~<K> form is the pure FTS keyword rank, which is
// exactly the half this anchor pins. Deletion drops the keyword row with the entry.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, UrlPath, MatcherBody } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});
const semanticStmt = (target: UrlPath, query: string, k: number): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: { marks: [k] }, body: { dialect: "semantic", raw: query } as MatcherBody,
    position: { line: 1, column: 1 },
});

test("[§semantic-fts-at-write] a cold workspace's first keyword ~query finds what was just written — no pump ever ran", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ftsw-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
        await new Known().edit(editStmt(url("alpha.md"), "the flux capacitor hums quietly"), ctx);
        await new Known().edit(editStmt(url("beta.md"), "an unrelated grocery list"), ctx);
        const r = await new Known().find(semanticStmt(url(""), "flux capacitor", 5), ctx);
        assert.equal(r.status, 200);
        assert.deepEqual((r.results as Array<{ path: string }>).map((f) => f.path), ["known:///alpha.md"], "write-time FTS narrows the cold corpus");
        // The keyword row dies with the entry.
        await new Known().deleteEntry("/alpha.md", ctx);
        const r2 = await new Known().find(semanticStmt(url(""), "flux capacitor", 5), ctx);
        assert.deepEqual(r2.results, [], "a killed entry leaves no keyword ghost");
    } finally { await db.close(); }
});
