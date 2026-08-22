// prompt:// — the worker's own task frames ({§prompt-self-only}): prompt:///<loop>/<N>, owned via
// owner_id. Engine-authored (the model reads, never writes); SELF-ONLY — a worker resolves only
// its own frames, so no worker identity ever rides a pathname or a packet.

import test from "node:test";
import assert from "node:assert/strict";
import Prompt from "../../src/schemes/Prompt.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { openMigrated, insertWorkspace, insertWorker, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";
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
    assert.ok(!Prompt.manifest.writableBy.includes("model"), "the model never writes prompt:// — it is engine-authored");
    assert.ok(Prompt.manifest.writableBy.includes("client"));
    assert.ok(Prompt.manifest.writableBy.includes("_plurnk"));
    assert.equal(Prompt.manifest.documentation, undefined, "prompt:// needs no redundant pull document");
});

test("the engine writes prompt:///<loop>/<N> owner-keyed; each worker READs only ITS OWN frame at the shared coordinate", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const sister = await insertWorker(db, workspaceId);
        const ctxSelf = makeSchemeCtx({ db, workspaceId, workerId });
        const ctxSister = makeSchemeCtx({ db, workspaceId, workerId: sister });

        // Each worker's same loop-relative coordinate remains distinct because
        // prompt entries are owner-keyed. {§prompt-self-only}
        await EntryCrud.writeEntry({ authority: "", pathname: "/1/1" }, { channels: { body: { content: "fix the parser", mimetype: "text/markdown" } } }, ctxSelf, "prompt", workerId);
        await EntryCrud.writeEntry({ authority: "", pathname: "/1/1" }, { channels: { body: { content: "sister task", mimetype: "text/markdown" } } }, ctxSister, "prompt", sister);

        const own = await lookThroughScheme("prompt", null, readStmt(urlPath("prompt", "/1/1")), ctxSelf);
        assert.equal(own.status, 200);
        assert.equal(own.content, "fix the parser", "a worker's READ resolves its OWN frame");
        const sisterOwn = await lookThroughScheme("prompt", null, readStmt(urlPath("prompt", "/1/1")), ctxSister);
        assert.equal(sisterOwn.content, "sister task", "the sister's identical coordinate is her own frame — never the sibling's");
    } finally { await db.close(); }
});

test("a frame the worker doesn't hold is 404 — no cross-worker prompt address exists", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const missing = await lookThroughScheme("prompt", null, readStmt(urlPath("prompt", "/9/9")), ctx);
        assert.equal(missing.status, 404);
    } finally { await db.close(); }
});
