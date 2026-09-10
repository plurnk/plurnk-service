// {§prompt-address} Prompt coordinates are literal and workspace-scoped.

import test from "node:test";
import assert from "node:assert/strict";
import Prompt from "../../src/schemes/Prompt.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { parsePath } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";
import { readStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
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

test("every Worker reads both literal prompt addresses, but another workspace cannot", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const sister = await insertWorker(db, workspaceId, null, "bob");
        const ctxSelf = makeSchemeCtx({ db, workspaceId, workerId });
        const ctxSister = makeSchemeCtx({ db, workspaceId, workerId: sister });

        for (const name of ["alice", "bob"]) {
            await EntryCrud.writeEntry({ authority: name, pathname: "/1/1" }, {
                channels: { body: { content: `${name} task`, mimetype: "text/markdown" } },
            }, ctxSelf, "prompt");
        }
        for (const ctx of [ctxSelf, ctxSister]) {
            for (const name of ["alice", "bob"]) {
                const result = await lookThroughScheme("prompt", null, readStmt(parsePath(`prompt://${name}/1/1`)!), ctx);
                assert.equal(result.status, 200);
                assert.equal(result.content, `${name} task`);
            }
        }
        const otherWorkspaceId = await insertWorkspace(db, crypto.randomUUID());
        const otherWorker = await insertWorker(db, otherWorkspaceId, null, "alice");
        const other = makeSchemeCtx({ db, workspaceId: otherWorkspaceId, workerId: otherWorker });
        assert.equal((await lookThroughScheme("prompt", null, readStmt(parsePath("prompt://alice/1/1")!), other)).status, 404);
    } finally { await db.close(); }
});

test("a missing prompt coordinate returns 404", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const missing = await lookThroughScheme("prompt", null, readStmt(parsePath("prompt://alice/9/9")!), ctx);
        assert.equal(missing.status, 404);
    } finally { await db.close(); }
});
