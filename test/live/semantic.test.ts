// ~semantic end-to-end with the REAL embedding model (all-MiniLM-L6-v2 via
// @plurnk/plurnk-mimetypes-embeddings). Lives in test:live — the between-intg-and-
// demo tier (--test-concurrency=1) where loading the 16 MB model is expected. The
// fast tiers stay model-free (intg's DEFAULT_MIMETYPES declines the embeddings
// daughter); this test builds its own embeddings-enabled Mimetypes and injects it.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Known from "../../src/schemes/Known.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "../intg/_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known://${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});
const semanticStmt = (target: UrlPath, query: string, k: number): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: { first: k, last: null }, body: { dialect: "semantic", raw: query } as MatcherBody,
    position: { line: 1, column: 1 },
});

test("[#186-semantic-e2e] ~query ranks by REAL semantic similarity (full pipeline, real model)", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `e2e-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId, mimetypes });
        await new Known().edit(editStmt(url("db.md"), "the database connection failed with a timeout error"), ctx);
        await new Known().edit(editStmt(url("sql.md"), "sql server connection could not be established"), ctx);
        await new Known().edit(editStmt(url("cake.md"), "preheat the oven and frost the birthday cake"), ctx);
        await EntryManifest.buildManifestBody(ctx);  // real embeddings stored via mimetypes-embeddings

        const r = await new Known().find(semanticStmt(url(""), "database connection error", 2), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0, mimetypes }));
        assert.equal(r.status, 200);
        // The two connection entries are returned, real-cosine-ranked; cake (no shared
        // keyword) is excluded by the FTS narrow, never reaching cosine.
        assert.deepEqual([...r.results].sort(), ["known://db.md", "known://sql.md"]);
        assert.ok(!r.results.includes("known://cake.md"), "the unrelated recipe never enters the ranking");
    } finally { db.close(); }
});
