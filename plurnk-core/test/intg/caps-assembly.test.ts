// {§capability-ctx}: the public context, not the private orchestration context.

import test from "node:test";
import assert from "node:assert/strict";
import SchemeCtxImpl from "../../src/core/caps/SchemeCtxImpl.ts";
import { openMigrated, insertWorkspace, makeSchemeCtx, schemeManifest } from "./_helpers.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";

test("{§capability-ctx}: public identity and working capabilities exclude private service state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-asm-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId: 7, loopId: 8, turnId: 9, writer: "model" });

        const sctx = new SchemeCtxImpl(ctx, "notes", schemeManifest("notes"), new LiveSubscriptions(), {  });

        // identity lifted off the PlurnkSchemeContext
        assert.equal(sctx.workspaceId, workspaceId);
        assert.equal(sctx.workerId, 7);
        assert.equal(sctx.loopId, 8);
        assert.equal(sctx.turnId, 9);
        assert.equal(sctx.writer, "model");

        for (const cap of ["entries", "channels", "notify", "projection", "interactions", "subscriptions"] as const) {
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

        for (const privateField of ["db", "mimetypes", "executors", "weigh", "tokenize", "injectWorker", "wakeWorkerNotify", "streamEventNotify", "pushNotice", "visibility"]) {
            assert.equal(privateField in sctx, false, `${privateField} is not part of the public handler context`);
        }
    } finally { await db.close(); }
});
