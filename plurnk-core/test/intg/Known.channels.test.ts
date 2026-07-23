// Tests for SPEC §scheme-manifest channel manifest + §channel-selection fragment-as-channel-selector.

import test from "node:test";
import assert from "node:assert/strict";
import Worker from "../../src/schemes/Worker.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, openStmt, foldStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

test("Known declares static channels manifest + defaultChannel", () => {
    assert.deepEqual(Worker.manifest.channels, { body: "text/markdown" });
    assert.equal(Worker.manifest.defaultChannel, "body");
});

test("Known.edit writes only the body channel; preview is render-time", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const r = await new Worker().edit(editStmt(urlPath("worker", "/x"), "hello"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 201);
        assert.equal(r.channel, "body");

        const channels = await (db.test_list_channels_for_entry as PrepMethod).all<{ name: string; content: string; mimetype: string }>({ entry_id: r.entryId });
        assert.equal(channels.length, 1);
        assert.equal(channels[0].name, "body");
        assert.equal(channels[0].content, "hello");
        assert.equal(channels[0].mimetype, "text/markdown");
    } finally { await db.close(); }
});

test("Known.edit with unknown channel returns 400", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const r = await new Worker().edit(editStmt(urlPath("worker", "/x", "not-a-channel"), "x"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 400);
        assert.equal(r.entryId, null);
    } finally { await db.close(); }
});

test("Known.read with no fragment returns body channel (default)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/x"), "body content"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await k.read(readStmt(urlPath("worker", "/x")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.equal(r.content, "body content");
        assert.equal(r.channel, "body");
    } finally { await db.close(); }
});

test("Known.read with unknown channel returns 400", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/x"), "body content"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await k.read(readStmt(urlPath("worker", "/x", "not-a-channel")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 400);
    } finally { await db.close(); }
});
