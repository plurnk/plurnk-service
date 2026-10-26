// Tests for SPEC {§scheme-manifest} channel manifest + {§channel-selection} fragment-as-channel-selector.

import test from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx } from "./_scheme.ts";
import { urlPath, editStmt, readStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

test("{§crud}: channel removal preserves siblings and removes only an empty entry", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const coordinate = { authority: "", pathname: "/channels" };
        const written = await EntryCrud.writeEntry(coordinate, {
            channels: {
                body: { content: "body", mimetype: "text/plain" },
                notes: { content: "retained", mimetype: "text/plain" },
            },
        }, ctx, "session");
        assert.equal(written.status, 201);
        assert.equal((await EntryCrud.deleteChannel(coordinate, "body", ctx, "session")).status, 200);
        const remaining = await EntryCrud.readEntry(coordinate, ctx, "session");
        assert.equal(remaining.status, 200);
        assert.deepEqual(Object.keys(remaining.entry!.channels), ["notes"]);
        assert.equal(remaining.entry!.channels.notes.content, "retained");
        const missing = await EntryCrud.deleteChannel(coordinate, "body", ctx, "session");
        assert.equal(missing.status, 404);
        assert.equal(missing.problem?.type, "https://problems.plurnk.xyz/scheme/session/channel-not-found");
        assert.equal((await EntryCrud.deleteChannel(coordinate, "notes", ctx, "session")).status, 200);
        assert.equal((await EntryCrud.readEntry(coordinate, ctx, "session")).status, 404);
    } finally { await db.close(); }
});

test("{§crud}: empty-entry pruning preserves a channel published after an empty observation", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const coordinate = { authority: "", pathname: "/concurrent" };
        const written = await EntryCrud.writeEntry(coordinate, {
            channels: { body: { content: "original", mimetype: "text/plain" } },
        }, ctx, "session");
        assert.equal(written.status, 201);
        await db.crud_delete_channel.get({ entry_id: written.entryId!, name: "body" });
        assert.deepEqual((await EntryCrud.readEntry(coordinate, ctx, "session")).entry!.channels, {});
        await db.test_seed_channel.run({
            entry_id: written.entryId!, name: "body", content: "new publication",
            mimetype: "text/plain", state: "static",
        });
        await db.crud_delete_empty_entry.run({ entry_id: written.entryId! });
        const retained = await EntryCrud.readEntry(coordinate, ctx, "session");
        assert.equal(retained.status, 200);
        assert.equal(retained.entry!.channels.body.content, "new publication");
    } finally { await db.close(); }
});

test("{§manifest} Session declares a dynamic body beside its typed readable projection", () => {
    assert.deepEqual(Workspace.manifest.channels, { readable: "text/markdown" });
    assert.equal(Workspace.manifest.defaultChannel, "body");
});

test("{§scheme-manifest} Session.edit writes only the body channel; preview is render-time", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const r = await new Workspace().edit(editStmt(urlPath("workspace", "/x"), "hello"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 201);
        assert.equal(r.channel, "body");

        const channels = await db.test_list_channels_for_entry.all<{ name: string; content: string; mimetype: string }>({ entry_id: r.entryId });
        assert.equal(channels.length, 1);
        assert.equal(channels[0].name, "body");
        assert.equal(channels[0].content, "hello");
        assert.equal(channels[0].mimetype, "text/markdown");
    } finally { await db.close(); }
});

test("{§channel-selection-missing} Session.edit with unknown channel returns 404", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const r = await new Workspace().edit(editStmt(urlPath("workspace", "/x", "not-a-channel"), "x"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 404);
        assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/channel-not-found");
        assert.equal(r.entryId, null);
    } finally { await db.close(); }
});

test("{§scheme-manifest} Session.read with no fragment returns body channel (default)", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/x"), "body content"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await readThroughScheme("workspace", null, readStmt(urlPath("workspace", "/x")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.content, "body content");
        assert.equal(r.channel, "body");
    } finally { await db.close(); }
});

test("{§channel-selection-missing} Session.read with unknown channel returns 404", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/x"), "body content"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await readThroughScheme("workspace", null, readStmt(urlPath("workspace", "/x", "not-a-channel")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 404);
        assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/channel-not-found");
    } finally { await db.close(); }
});
