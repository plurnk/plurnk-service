// Tests for SPEC §3.1 channel manifest + §5.5 fragment-as-channel-selector.

import test from "node:test";
import assert from "node:assert/strict";
import Known from "../../src/schemes/Known.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, openStmt, foldStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Known declares static channels manifest + defaultChannel", () => {
    assert.deepEqual(Known.manifest.channels, { body: "text/markdown" });
    assert.equal(Known.manifest.defaultChannel, "body");
});

test("[§5.1-edit-writes-only-body] Known.edit writes only the body channel; preview is render-time", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit(editStmt(urlPath("known", "x"), "hello"), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(r.status, 201);
        assert.equal(r.channel, "body");

        const channels = await (db.test_list_channels_for_entry as PrepMethod).all<{ name: string; content: string; mimetype: string }>({ entry_id: r.entryId });
        assert.equal(channels.length, 1);
        assert.equal(channels[0].name, "body");
        assert.equal(channels[0].content, "hello");
        assert.equal(channels[0].mimetype, "text/markdown");
    } finally { await db.close(); }
});

test("[§5.5-unknown-channel-400] Known.edit with unknown channel returns 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit(editStmt(urlPath("known", "x", "not-a-channel"), "x"), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(r.status, 400);
        assert.equal(r.entryId, null);
    } finally { await db.close(); }
});

test("[§5.5-fragmentless-targets-default-channel] Known.read with no fragment returns body channel (default)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit(editStmt(urlPath("known", "x"), "body content"), makeSchemeCtx({ db, sessionId, runId }));
        const r = await k.read(readStmt(urlPath("known", "x")), makeSchemeCtx({ db, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.content, "body content");
        assert.equal(r.channel, "body");
    } finally { await db.close(); }
});

test("Known.read with unknown channel returns 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit(editStmt(urlPath("known", "x"), "body content"), makeSchemeCtx({ db, sessionId, runId }));
        const r = await k.read(readStmt(urlPath("known", "x", "not-a-channel")), makeSchemeCtx({ db, sessionId }));
        assert.equal(r.status, 400);
    } finally { await db.close(); }
});
