// prompt:// — the worker's own task frames ({§prompt-self-only}): prompt:///<loop>/<N>, owned via
// owner_id. Engine-authored (the model reads, never writes); SELF-ONLY — a worker resolves only
// its own frames, so no worker identity ever rides a pathname or a packet.

import test from "node:test";
import assert from "node:assert/strict";
import Prompt from "../../src/schemes/Prompt.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { openMigrated, insertWorkspace, insertWorker, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, readStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

test("prompt:// scheme manifest: engine-authored, model-READ-ONLY, body channel, text/markdown", () => {
    assert.deepEqual(Prompt.manifest.channels, { body: "text/markdown" });
    assert.equal(Prompt.manifest.defaultChannel, "body");
    assert.equal(Prompt.manifest.modelVisible, true, "the model READS its task frames");
    assert.ok(!Prompt.manifest.writableBy.includes("model"), "the model never WRITES prompt:// — it is engine-authored (#310 scratch sink)");
    assert.ok(Prompt.manifest.writableBy.includes("client"));
    assert.ok(Prompt.manifest.writableBy.includes("plurnk"));
});

test("the engine writes prompt:///<loop>/<N> owner-keyed; each worker READs only ITS OWN frame at the shared coordinate", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const sister = await insertWorker(db, workspaceId);
        const ctxSelf = makeSchemeCtx({ db, workspaceId, workerId });
        const ctxSister = makeSchemeCtx({ db, workspaceId, workerId: sister });

        // The engine writes each worker's frame at the SAME loop-relative coordinate (/1/1) —
        // the #382 collision surface, now distinct rows keyed on the owner ({§entry-owner}).
        await EntryCrud.writeEntry("/1/1", { channels: { body: { content: "fix the parser", mimetype: "text/markdown" } }, tags: [] }, ctxSelf, "prompt", workerId);
        await EntryCrud.writeEntry("/1/1", { channels: { body: { content: "sister task", mimetype: "text/markdown" } }, tags: [] }, ctxSister, "prompt", sister);

        const p = new Prompt();
        const own = await p.read(readStmt(urlPath("prompt", "/1/1")), makeHandlerCtx(ctxSelf, Prompt.manifest));
        assert.equal(own.status, 200);
        assert.equal(own.content, "fix the parser", "a worker's READ resolves its OWN frame");
        const sisterOwn = await p.read(readStmt(urlPath("prompt", "/1/1")), makeHandlerCtx(ctxSister, Prompt.manifest));
        assert.equal(sisterOwn.content, "sister task", "the sister's identical coordinate is her own frame — never the sibling's");
    } finally { await db.close(); }
});

test("a frame the worker doesn't hold is 404 — no cross-worker prompt address exists", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const p = new Prompt();
        const missing = await p.read(readStmt(urlPath("prompt", "/9/9")), makeHandlerCtx(ctx, Prompt.manifest));
        assert.equal(missing.status, 404);
    } finally { await db.close(); }
});
