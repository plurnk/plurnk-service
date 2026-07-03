// §semantic-cold-query-full-fidelity + §derivation-off-hot-path — a COLD session's first
// ~query returns bit-identical results to a fully-warmed corpus: the keyword half indexes
// at the write, and the ~dispatch derives its own FTS-narrowed candidate slice inline.
// The background pump owes nothing to any query. REAL embedder (this file re-enables it;
// the fast lane disables it in .env.test) — --test-isolation=process scopes the flip here.
process.env.PLURNK_EMBED_DISABLE = "0";

import test from "node:test";
import assert from "node:assert/strict";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { EditStatement, FindStatement, UrlPath, MatcherBody } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
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

const CORPUS: Array<[string, string]> = [
    ["db.md", "the database connection failed with a timeout error"],
    ["sql.md", "sql server connection could not be established"],
    ["cake.md", "preheat the oven and frost the birthday cake"],
];

const seedAndQuery = async (warm: boolean): Promise<string[]> => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `${warm ? "warm" : "cold"}-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId, mimetypes });
        for (const [path, body] of CORPUS) await new Known().edit(editStmt(url(path), body), ctx);
        if (warm) await EntryManifest.maintainDerivations(ctx); // the control: full pump
        // The cold arm queries with NO pump ever having run — the write-time FTS narrow
        // plus the dispatch-inline slice must deliver the identical ranking.
        const r = await new Known().find(semanticStmt(url(""), "database connection error", 2), makeSchemeCtx({ db, sessionId, runId, loopId: 0, turnId: 0, mimetypes }));
        assert.equal(r.status, 200);
        return (r.results as Array<{ path: string }>).map((f) => f.path);
    } finally { await db.close(); }
};

test("[§semantic-cold-query-full-fidelity] a cold session's first ~query equals the fully-warmed corpus, real embedder end to end", async () => {
    const warm = await seedAndQuery(true);
    const cold = await seedAndQuery(false);
    assert.deepEqual(cold, warm, "cold-vs-warm parity: the inline slice IS full fidelity");
    assert.deepEqual([...cold].sort(), ["known:///db.md", "known:///sql.md"], "and the ranking is the real semantic one");
});

test("[§derivation-off-hot-path] the queued pump completes on the background chain — drainDerivations awaits it", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `drain-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId, mimetypes });
        await new Known().edit(editStmt(url("note.md"), "alpha beta gamma delta"), ctx);
        const Engine = (await import("../../src/core/Engine.ts")).default;
        const SchemeRegistry = (await import("../../src/core/SchemeRegistry.ts")).default;
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
        await engine.warmSessionDerivations(sessionId); // routes through the chain; awaiting = draining
        const row = await (db.test_deep_hash as PrepMethod).get<{ deep_hash: string | null }>({ session_id: sessionId });
        assert.ok(row?.deep_hash !== null && row?.deep_hash !== undefined && row.deep_hash.length > 0, "the pump ran to completion on the chain and stamped the deep hash");
    } finally { await db.close(); }
});
