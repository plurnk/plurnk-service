// Conformance: plurnk-schemes {§capability-ctx}. SchemeCtxImpl assembles the
// plugin-visible identity and five consumer-backed capabilities; `visibility`
// is intentionally absent.

import test from "node:test";
import assert from "node:assert/strict";
import SchemeCtxImpl from "../../src/core/caps/SchemeCtxImpl.ts";
import { openMigrated, insertWorkspace, makeSchemeCtx, schemeManifest } from "./_helpers.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";
import Owner from "../../src/core/Owner.ts";

test("SchemeCtxImpl: identity and the five capabilities are wired", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-asm-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId: 7, loopId: 8, turnId: 9, writer: "model" });
        const ownerId = await Owner.commonsId(db, workspaceId);
        const sctx = new SchemeCtxImpl(ctx, "notes", schemeManifest("notes"), new LiveSubscriptions(), { ownerId });

        // identity lifted off the PlurnkSchemeContext
        assert.equal(sctx.workspaceId, workspaceId);
        assert.equal(sctx.workerId, 7);
        assert.equal(sctx.loopId, 8);
        assert.equal(sctx.turnId, 9);
        assert.equal(sctx.writer, "model");

        // all five caps present
        for (const cap of ["entries", "channels", "notify", "projection", "subscriptions"] as const) {
            assert.notEqual((sctx as unknown as Record<string, unknown>)[cap], undefined, `${cap} cap is wired`);
        }

        // and functional through the assembled seam — content + private attributes round-trip
        const w = await sctx.entries.write("/e.md", {
            channels: { body: { content: "x", mimetype: "text/markdown" } },
            attributes: { kind: "specimen" },
        });
        assert.equal(w.created, true);
        const entry = (await sctx.entries.read("/e.md")).entry;
        assert.equal(entry?.channels.body.content, "x");
        assert.deepEqual(entry?.attributes, { kind: "specimen" });

        // visibility was dropped — it is not on the assembled ctx
        assert.equal((sctx as unknown as Record<string, unknown>).visibility, undefined);
    } finally { await db.close(); }
});
