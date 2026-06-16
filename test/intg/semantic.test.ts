// ~query semantic search end-to-end with the REAL embedding model
// (all-MiniLM-L6-v2 via @plurnk/plurnk-mimetypes-embeddings). Runs in test:intg —
// semantics is NORMAL integration coverage, not a special live-only track; the
// model load is an accepted cost. The test builds its OWN embeddings-enabled
// Mimetypes, so DEFAULT_MIMETYPES's decline only affects tests that don't need
// the embedder.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Known from "../../src/schemes/Known.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

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
// #209 — decimal <0.x> (+ optional ,N cap) = similarity threshold, not top-K.
const thresholdStmt = (target: UrlPath, query: string, threshold: number, cap: number | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: { marks: cap === null ? [threshold] : [threshold, cap] }, body: { dialect: "semantic", raw: query } as MatcherBody,
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
        assert.deepEqual([...r.results].sort(), ["known:///db.md", "known:///sql.md"]);
        assert.ok(!r.results.includes("known:///cake.md"), "the unrelated recipe never enters the ranking");
    } finally { db.close(); }
});

test("[#209-semantic-threshold] ~query <0.x> form-dispatches to a similarity threshold, not top-K", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `thresh-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId, mimetypes });
        await new Known().edit(editStmt(url("db.md"), "the database connection failed with a timeout error"), ctx);
        await new Known().edit(editStmt(url("sql.md"), "sql server connection could not be established"), ctx);
        await new Known().edit(editStmt(url("cake.md"), "preheat the oven and frost the birthday cake"), ctx);
        await EntryManifest.buildManifestBody(ctx);
        const findCtx = (): ReturnType<typeof makeSchemeCtx> => makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0, mimetypes });

        // A low floor admits every FTS-matched candidate (cosine > 0.05) — same set
        // an integer top-K would, proving the decimal routes to the threshold path.
        const low = await new Known().find(thresholdStmt(url(""), "database connection error", 0.05), findCtx());
        assert.equal(low.status, 200);
        assert.deepEqual([...low.results].sort(), ["known:///db.md", "known:///sql.md"]);

        // A near-1 floor admits nothing — the threshold actually filters; it isn't a top-K in disguise.
        const high = await new Known().find(thresholdStmt(url(""), "database connection error", 0.999), findCtx());
        assert.equal(high.status, 200);
        assert.deepEqual(high.results, [], "a 0.999 floor filters everything out");

        // <0.05,1> — threshold + result cap → at most one, the closest.
        const capped = await new Known().find(thresholdStmt(url(""), "database connection error", 0.05, 1), findCtx());
        assert.equal(capped.results.length, 1, "the ,N cap bounds the threshold set");

        // A fractional value outside (0,1) is a nonsense result-marker → 416, never coerced.
        const bad = await new Known().find(thresholdStmt(url(""), "database connection error", 1.5), findCtx());
        assert.equal(bad.status, 416, "a fractional marker outside (0,1) is 416");
    } finally { db.close(); }
});
