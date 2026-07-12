// Conformance: SchemeCtxImpl (keystone PR-2, #180) assembles the full capability
// surface a sibling receives — identity off the PlurnkSchemeContext, the five
// db-backed caps wired + functional through the seam, and the deferred
// crossScheme stub. `visibility` is intentionally absent (dropped in schemes 0.4.3).

import test from "node:test";
import assert from "node:assert/strict";
import SchemeCtxImpl from "../../src/core/caps/SchemeCtxImpl.ts";
import { openMigrated, insertSession, makeSchemeCtx } from "./_helpers.ts";

test("SchemeCtxImpl: identity + the five caps wired + crossScheme deferred stub", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `caps-asm-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, sessionId, runId: 7, loopId: 8, turnId: 9, writer: "model" });
        const sctx = new SchemeCtxImpl(ctx, "known");

        // identity lifted off the PlurnkSchemeContext
        assert.equal(sctx.sessionId, sessionId);
        assert.equal(sctx.runId, 7);
        assert.equal(sctx.loopId, 8);
        assert.equal(sctx.turnId, 9);
        assert.equal(sctx.writer, "model");

        // all five caps present
        for (const cap of ["entries", "channels", "tags", "notify", "subscriptions"] as const) {
            assert.notEqual((sctx as unknown as Record<string, unknown>)[cap], undefined, `${cap} cap is wired`);
        }

        // and functional through the assembled seam — entries + tags round-trip
        const w = await sctx.entries.write("/e.md", { channels: { body: { content: "x", mimetype: "text/markdown" } }, tags: ["t"] });
        assert.equal(w.created, true);
        assert.equal((await sctx.entries.read("/e.md")).entry?.channels.body.content, "x");
        assert.deepEqual([...(await sctx.tags.list("/e.md")).tags], ["t"]);

        // crossScheme is the deferred stub, not a live cap
        assert.match(sctx.crossScheme._deferred, /#180/);
        // visibility was dropped — it is not on the assembled ctx
        assert.equal((sctx as unknown as Record<string, unknown>).visibility, undefined);
    } finally { await db.close(); }
});
