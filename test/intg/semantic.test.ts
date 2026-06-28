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
        await EntryManifest.maintainDerivations(ctx);  // real embeddings stored via mimetypes-embeddings

        const r = await new Known().find(semanticStmt(url(""), "database connection error", 2), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0, mimetypes }));
        assert.equal(r.status, 200);
        // The two connection entries are returned, real-cosine-ranked; cake (no shared
        // keyword) is excluded by the FTS narrow, never reaching cosine.
        assert.deepEqual(r.results.map((f) => f.path).sort(), ["known:///db.md", "known:///sql.md"]);
        assert.ok(!r.results.some((f) => f.path === "known:///cake.md"), "the unrelated recipe never enters the ranking");
        assert.ok(r.results.every((row) => typeof row.channels === "object" && !("extent" in (row as object))), "~semantic FIND returns uniform catalog rows (no per-match extent) — the matched chunk's span is a READ, the ranking is the row order");
    } finally { db.close(); }
});

test("[#272] the derivation pump emits throttled embed_progress telemetry for a multi-entry corpus pass, silent for a single entry", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `progress-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const seed = makeSchemeCtx({ db, sessionId, runId, mimetypes });
        for (const name of ["a.md", "b.md", "c.md"]) await new Known().edit(editStmt(url(name), `content for ${name} with words to embed`), seed);

        type Tel = { source?: string; kind?: string; completed?: number; total?: number };
        const events: Tel[] = [];
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, sessionId, runId, mimetypes, pushTelemetry: (e) => events.push(e as Tel) }));

        const progress = events.filter((e) => e.source === "engine:derivation" && e.kind === "embed_progress");
        assert.ok(progress.length > 0, "a 3-entry corpus pass emits progress telemetry (the ingest is visible, not frozen)");
        assert.ok(progress.every((e) => e.total === 3), "total reflects the corpus size (3 changed entries)");
        assert.equal(progress.at(-1)?.completed, 3, "the final progress event reports completion");

        // A normal turn re-derives a single changed entry (total=1) → below the multi-entry
        // threshold → silent, so steady-state turns carry no per-turn progress noise.
        const events2: Tel[] = [];
        await new Known().edit(editStmt(url("d.md"), "a single new entry changed this turn"), seed);
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, sessionId, runId, mimetypes, pushTelemetry: (e) => events2.push(e as Tel) }));
        assert.equal(events2.filter((e) => e.kind === "embed_progress").length, 0, "a single-entry pass stays silent");
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
        await EntryManifest.maintainDerivations(ctx);
        const findCtx = (): ReturnType<typeof makeSchemeCtx> => makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0, mimetypes });

        // A low floor admits every FTS-matched candidate (cosine > 0.05) — same set
        // an integer top-K would, proving the decimal routes to the threshold path.
        const low = await new Known().find(thresholdStmt(url(""), "database connection error", 0.05), findCtx());
        assert.equal(low.status, 200);
        assert.deepEqual([...new Set(low.results.map((f) => f.path))].sort(), ["known:///db.md", "known:///sql.md"]);

        // A near-1 floor admits nothing — the threshold actually filters; it isn't a top-K in disguise.
        const high = await new Known().find(thresholdStmt(url(""), "database connection error", 0.999), findCtx());
        assert.equal(high.status, 200);
        assert.deepEqual([...new Set(high.results.map((f) => f.path))], [], "a 0.999 floor filters everything out");

        // <0.05,1> — threshold + result cap → at most one, the closest.
        const capped = await new Known().find(thresholdStmt(url(""), "database connection error", 0.05, 1), findCtx());
        assert.equal(capped.results.length, 1, "the ,N cap bounds the threshold set");

        // A fractional value outside (0,1) is a nonsense result-marker → 416, never coerced.
        const bad = await new Known().find(thresholdStmt(url(""), "database connection error", 1.5), findCtx());
        assert.equal(bad.status, 416, "a fractional marker outside (0,1) is 416");
    } finally { db.close(); }
});
