// §tokenomics-derived-token-counts (#312) — token counts keyed on (content_hash, tokenizer_id):
// computed once per identity, shared across identical content, vocab-sharing model swaps recount
// nothing, and the catalog serves the ACTIVE gauge's number over the write-time stamp.

import test from "node:test";
import assert from "node:assert/strict";
import TokenGauge from "../../src/core/TokenGauge.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const fakeGauge = (tokenizerId: string, per: number): { gauge: { tokenizerId: string; exact: boolean; count: (t: string) => Promise<number> }; calls: () => number } => {
    let n = 0;
    return { gauge: { tokenizerId, exact: true, count: async () => { n++; return per; } }, calls: () => n };
};

test("[§tokenomics-derived-token-counts] keyed once per identity — a vocab-sharing swap recounts NOTHING, a real change recounts", async () => {
    const db = await openMigrated();
    try {
        const content = "the same content measured by different rulers";
        const hash = TokenGauge.contentHash(content);
        const a = fakeGauge("tok-A", 7);
        const b = fakeGauge("tok-B", 13);
        assert.equal(await TokenGauge.tokensFor(db, a.gauge, hash, content), 7, "identity A computes 7");
        assert.equal(await TokenGauge.tokensFor(db, a.gauge, hash, content), 7, "identity A again — served from the derivation row");
        assert.equal(a.calls(), 1, "ONE computation for identity A — the vocab-share semantics (same id, zero recounts)");
        assert.equal(await TokenGauge.tokensFor(db, b.gauge, hash, content), 13, "identity B computes ITS OWN count — a real tokenizer change recounts");
        assert.equal(b.calls(), 1);
    } finally { await db.close(); }
});

test("[§tokenomics-derived-token-counts] the catalog serves the ACTIVE gauge's count, falling back to the write-time stamp", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `gauge-${crypto.randomUUID()}`);
        await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId: 1, mimetypes: DEFAULT_MIMETYPES });
        const content = "measured content";
        await EntryCrud.writeEntry("/g.md", { channels: { body: { content, mimetype: "text/markdown" } }, tags: [] }, ctx, "known");
        const hash = TokenGauge.contentHash(content);
        const exact = fakeGauge("tok-exact", 999);
        await TokenGauge.tokensFor(db, exact.gauge, hash, content);
        const withGauge = await (db.engine_list_session_entries as PrepMethod).all<{ pathname: string; tokens: number }>({ session_id: sessionId, tokenizer_id: "tok-exact" });
        const row = withGauge.find((r) => r.pathname === "/g.md");
        assert.equal(row?.tokens, 999, "the catalog serves the keyed exact count for the active identity");
        const without = await (db.engine_list_session_entries as PrepMethod).all<{ pathname: string; tokens: number }>({ session_id: sessionId, tokenizer_id: "some-other-id" });
        const fallback = without.find((r) => r.pathname === "/g.md");
        assert.ok((fallback?.tokens ?? 0) > 0 && fallback?.tokens !== 999, "an unknown identity falls back to the write-time stamp — never a silent zero");
    } finally { await db.close(); }
});

test("[§tokenomics-derived-token-counts] an alias-fronted backend runs as a SURFACED upper bound until providers exposes servedModel", async () => {
    // providers#37: 'turboderp' (a local alias) maps to nothing in the seam — the provider's own
    // probe saw the real gguf name but the contract doesn't surface it. No service-side
    // reconstruction: the gauge consumes Provider.servedModel when the contract ships it, and
    // until then the upper bound runs LOUD (the tokenizer_unavailable warning is the alarm).
    const db = await openMigrated();
    try {
        const alias = { model: "turboderp", countTokens: (t: string) => Math.ceil(t.length / 2) } as never;
        const bare = await TokenGauge.resolve(DEFAULT_MIMETYPES, alias, undefined);
        assert.equal(bare.exact, false, "the bare alias is inexact — surfaced, never silent");
        const withContract = { model: "turboderp2", servedModel: "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf", countTokens: (t: string) => Math.ceil(t.length / 2) } as never;
        const exact = await TokenGauge.resolve(DEFAULT_MIMETYPES, withContract, undefined);
        assert.equal(exact.exact, true, "the moment the CONTRACT carries servedModel, resolution is exact from turn 1");
    } finally { await db.close(); }
});
