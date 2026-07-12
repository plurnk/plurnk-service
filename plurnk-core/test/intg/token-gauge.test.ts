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

test("[§tokenomics-derived-token-counts] a 416 range-miss states the entry's extent — ranges become aimable (run24: 24 blind re-guesses)", async () => {
    const { default: ReadResolve } = await import("../../src/content/read-resolve.ts");
    const r = await ReadResolve.resolve({ content: "a\nb\nc", mimetype: "text/plain", lineMarker: { marks: [50, 60] }, body: null, mimetypes: DEFAULT_MIMETYPES });
    assert.equal(r.status, 416);
    assert.match(r.content ?? "", /3 lines/, "the miss names the real extent — a fact, not advice");
});

test("[§semantic-entry-chunk-cap] the null-window lane (mimetypes#50): a window-less remote embedder fails LOUD naming the knob; a declared window chunks via the seam counter", async () => {
    const { default: EntrySemantic } = await import("../../src/schemes/_entry-semantic.ts");
    const prevDisable = process.env.PLURNK_SERVICE_EMBED_DISABLE; // the fast-lane gate would null the info before the stub is seen
    delete process.env.PLURNK_SERVICE_EMBED_DISABLE;
    try {
    const embed = async (texts: readonly string[]) => texts.map(() => new Uint8Array(new Float32Array([1, 0, 0]).buffer));
    const noWindow = { embedderInfo: async () => ({ dimension: 3, maxTokens: null, countTokens: null, model: "remote@x" }), embedBatch: embed, tokenizer: DEFAULT_MIMETYPES.tokenizer.bind(DEFAULT_MIMETYPES) } as never;
    await assert.rejects(
        EntrySemantic.deriveEmbeddings(noWindow, "line one\nline two", [], undefined, undefined),
        /PLURNK_MIMETYPES_EMBED_MAX_TOKENS/,
        "no window → refuse LOUD, naming the operator's knob — never a silent degrade");
    const declared = { embedderInfo: async () => ({ dimension: 3, maxTokens: 64, countTokens: null, model: "remote@x" }), embedBatch: embed, tokenizer: DEFAULT_MIMETYPES.tokenizer.bind(DEFAULT_MIMETYPES) } as never;
    const r = await EntrySemantic.deriveEmbeddings(declared, "line one\nline two\nline three", [], undefined, undefined);
    assert.ok(r.chunks.length > 0, "a declared window + the seam's counter fallback chunks and embeds — the remote embedder is PRESENT");
    } finally { if (prevDisable !== undefined) process.env.PLURNK_SERVICE_EMBED_DISABLE = prevDisable; }
});

test("[§derivation-off-hot-path] the pump NEVER re-embeds unchanged content — two passes, one embedBatch (the owner's re-embed suspicion, refuted deterministically)", async () => {
    const { default: EntryManifest } = await import("../../src/schemes/_entry-manifest.ts");
    const { default: EntryCrud } = await import("../../src/schemes/_entry-crud.ts");
    const prevDisable = process.env.PLURNK_SERVICE_EMBED_DISABLE;
    delete process.env.PLURNK_SERVICE_EMBED_DISABLE;
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `reembed-${crypto.randomUUID()}`);
        await insertRun(db, sessionId);
        let embedCalls = 0;
        const stub = {
            embedderInfo: async () => ({ dimension: 3, maxTokens: 1000, countTokens: async (t: string) => t.split(/\s+/).length, model: "stub@1" }),
            embedBatch: async (texts: readonly string[]) => { embedCalls++; return texts.map(() => new Uint8Array(new Float32Array([1, 0, 0]).buffer)); },
            process: async () => ({}),
            classify: async () => ({ noEmbed: false }),
            tokenizer: DEFAULT_MIMETYPES.tokenizer.bind(DEFAULT_MIMETYPES),
        } as never;
        const ctx = makeSchemeCtx({ db, sessionId, runId: 1, mimetypes: stub });
        await EntryCrud.writeEntry("/stable.md", { channels: { body: { content: "the same content every turn", mimetype: "text/markdown" } }, tags: [] }, ctx, "known");
        await EntryManifest.maintainDerivations(ctx);
        const after1 = embedCalls;
        await EntryManifest.maintainDerivations(ctx); // turn 2's pump — unchanged content
        await EntryManifest.maintainDerivations(ctx); // turn 3's pump
        assert.ok(after1 >= 1, "the first pass embedded");
        assert.equal(embedCalls, after1, `unchanged content is NEVER re-embedded — the deep_hash gate holds (calls stayed at ${after1} across two more pumps)`);
    } finally { await db.close(); if (prevDisable !== undefined) process.env.PLURNK_SERVICE_EMBED_DISABLE = prevDisable; }
});
