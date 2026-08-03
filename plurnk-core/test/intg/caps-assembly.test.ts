// Conformance: SchemeCtxImpl (keystone PR-2, #180) assembles the full capability
// surface a sibling receives — identity off the PlurnkSchemeContext and the six
// consumer-backed caps wired + functional through the seam. `visibility` is
// intentionally absent.

import test from "node:test";
import assert from "node:assert/strict";
import SchemeCtxImpl from "../../src/core/caps/SchemeCtxImpl.ts";
import { openMigrated, insertWorkspace, makeSchemeCtx, schemeManifest } from "./_helpers.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";

test("SchemeCtxImpl: identity and the six capabilities are wired", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-asm-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId: 7, loopId: 8, turnId: 9, writer: "model" });
        const sctx = new SchemeCtxImpl(ctx, "notes", schemeManifest("notes"), new LiveSubscriptions());

        // identity lifted off the PlurnkSchemeContext
        assert.equal(sctx.workspaceId, workspaceId);
        assert.equal(sctx.workerId, 7);
        assert.equal(sctx.loopId, 8);
        assert.equal(sctx.turnId, 9);
        assert.equal(sctx.writer, "model");

        // all six caps present
        for (const cap of ["entries", "channels", "tags", "notify", "projection", "subscriptions"] as const) {
            assert.notEqual((sctx as unknown as Record<string, unknown>)[cap], undefined, `${cap} cap is wired`);
        }

        // and functional through the assembled seam — entries + tags round-trip
        const w = await sctx.entries.write("/e.md", { channels: { body: { content: "x", mimetype: "text/markdown" } }, tags: ["t"] });
        assert.equal(w.created, true);
        assert.equal((await sctx.entries.read("/e.md")).entry?.channels.body.content, "x");
        assert.deepEqual([...(await sctx.tags.list("/e.md")).tags], ["t"]);

        // visibility was dropped — it is not on the assembled ctx
        assert.equal((sctx as unknown as Record<string, unknown>).visibility, undefined);
    } finally { await db.close(); }
});
