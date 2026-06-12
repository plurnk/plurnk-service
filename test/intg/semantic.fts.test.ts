// ~semantic FTS half (#186) — the manifest-add hook indexes body content into
// entry_fts (the keyword/narrowing half of the fusion), gated by deep_hash so it
// re-indexes only on content change. (Cosine over embeddings — the precise half —
// lands when the embedding channel does.)

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import Known from "../../src/schemes/Known.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
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

const fts = async (db: Db, sessionId: number, query: string): Promise<string[]> => {
    const rows = await (db.test_fts_search as PrepMethod).all<{ pathname: string }>({ session_id: sessionId, query });
    return rows.map((r) => r.pathname);
};

test("[#186-fts] manifest-add indexes body content into entry_fts; re-indexes on change", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `fts-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        await new Known().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Known().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await EntryManifest.buildManifestBody(ctx);

        assert.deepEqual(await fts(db, sessionId, "processPayment"), ["pay.ts"]);
        assert.deepEqual(await fts(db, sessionId, "authenticate"), ["auth.ts"]);
        assert.deepEqual(await fts(db, sessionId, "nonexistent"), []);

        // Change pay.ts: re-index must drop the old term and add the new one;
        // auth.ts is unchanged (gate skips it) and stays indexed.
        await new Known().edit(editStmt(url("pay.ts"), "export function refund() {}\n"), ctx);
        await EntryManifest.buildManifestBody(ctx);
        assert.deepEqual(await fts(db, sessionId, "processPayment"), [], "old term gone after re-index");
        assert.deepEqual(await fts(db, sessionId, "refund"), ["pay.ts"], "new term indexed");
        assert.deepEqual(await fts(db, sessionId, "authenticate"), ["auth.ts"], "unchanged entry stays indexed");
    } finally { db.close(); }
});

test("[#186-cosine] the cosine SqlRite function ranks Float32-BLOB vectors", async () => {
    const db = await openMigrated();
    try {
        const blob = (arr: number[]) => Buffer.from(new Float32Array(arr).buffer);
        const sim = async (a: number[], b: number[]): Promise<number> => {
            const r = await (db.test_cosine as PrepMethod).get<{ sim: number }>({ a: blob(a), b: blob(b) });
            assert.ok(r, "cosine returned a row");
            return r.sim;
        };
        assert.equal(Math.round(await sim([1, 0, 0], [1, 0, 0])), 1, "identical → 1");
        assert.equal(await sim([1, 0, 0], [0, 1, 0]), 0, "orthogonal → 0");
        assert.ok((await sim([1, 0, 0], [0.9, 0.1, 0.05])) > 0.98, "near-parallel → ~1");
    } finally { db.close(); }
});
