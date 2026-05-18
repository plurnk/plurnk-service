// Tests for SPEC §3.1 channel manifest + §5.5 fragment-as-channel-selector.

import test from "node:test";
import assert from "node:assert/strict";
import Known from "../../src/schemes/Known.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, showStmt, hideStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Known declares static channels manifest + defaultChannel", () => {
    assert.deepEqual(Known.channels, { body: "text/markdown", preview: "text/markdown" });
    assert.equal(Known.defaultChannel, "body");
});

test("[§5.1-edit-writes-body-plus-preview] Known.edit default channel writes body AND preview channels", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(urlPath("known", "x"), "hello"), sessionId, runId });
        assert.equal(r.status, 201);
        assert.equal(r.channel, "body");

        const channels = await (db.test_list_channels_for_entry as PrepMethod).all<{ name: string; content: string; mimetype: string }>({ entry_id: r.entryId });
        assert.equal(channels.length, 2);
        const body = channels.find((c) => c.name === "body");
        const preview = channels.find((c) => c.name === "preview");
        assert.ok(body !== undefined);
        assert.equal(body.content, "hello");
        assert.equal(body.mimetype, "text/markdown");
        assert.ok(preview !== undefined);
        assert.equal(preview.content, "hello", "v0: preview = body verbatim per SPEC §5.1");
        assert.equal(preview.mimetype, "text/markdown");
    } finally { await db.close(); }
});

test("Known.edit default channel indexes BOTH body and preview in visibility", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(urlPath("known", "x"), "hello"), sessionId, runId });
        const rows = await (db.test_list_visibility_for_run as PrepMethod).all<{ entry_id: number; channel: string; indexed: number }>({ run_id: runId });
        const channels = rows.filter((r2) => r2.entry_id === r.entryId).map((r2) => r2.channel).sort();
        assert.deepEqual(channels, ["body", "preview"]);
    } finally { await db.close(); }
});

test("[§5.5-fragment-selects-named-channel] Known.edit with #preview fragment writes ONLY preview channel", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, statement: editStmt(urlPath("known", "x"), "default body"), sessionId, runId });
        const r = await k.edit({ db, statement: editStmt(urlPath("known", "x", "preview"), "custom preview"), sessionId, runId });
        assert.equal(r.status, 200);
        assert.equal(r.channel, "preview");

        const body = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: r.entryId, name: "body" }))?.content;
        assert.equal(body, "default body", "body unchanged");

        const preview = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: r.entryId, name: "preview" }))?.content;
        assert.equal(preview, "custom preview", "preview updated");
    } finally { await db.close(); }
});

test("[§5.5-fragment-on-nonexistent-404] Known.edit with #preview on nonexistent entry returns 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(urlPath("known", "nope", "preview"), "x"), sessionId, runId });
        assert.equal(r.status, 404);
        assert.equal(r.entryId, null);
    } finally { await db.close(); }
});

test("[§5.5-unknown-channel-400] Known.edit with unknown channel returns 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(urlPath("known", "x", "not-a-channel"), "x"), sessionId, runId });
        assert.equal(r.status, 400);
        assert.equal(r.entryId, null);
    } finally { await db.close(); }
});

test("Known.read with #preview fragment returns preview channel content", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, statement: editStmt(urlPath("known", "x"), "body content"), sessionId, runId });
        await k.edit({ db, statement: editStmt(urlPath("known", "x", "preview"), "preview content"), sessionId, runId });

        const r = await k.read({ db, statement: readStmt(urlPath("known", "x", "preview")), sessionId });
        assert.equal(r.status, 200);
        assert.equal(r.content, "preview content");
        assert.equal(r.channel, "preview");
    } finally { await db.close(); }
});

test("[§5.5-fragmentless-targets-default-channel] Known.read with no fragment returns body channel (default)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, statement: editStmt(urlPath("known", "x"), "body content"), sessionId, runId });
        const r = await k.read({ db, statement: readStmt(urlPath("known", "x")), sessionId });
        assert.equal(r.status, 200);
        assert.equal(r.content, "body content");
        assert.equal(r.channel, "body");
    } finally { await db.close(); }
});

test("Known.read with unknown channel returns 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, statement: editStmt(urlPath("known", "x"), "body content"), sessionId, runId });
        const r = await k.read({ db, statement: readStmt(urlPath("known", "x", "not-a-channel")), sessionId });
        assert.equal(r.status, 400);
    } finally { await db.close(); }
});

test("[§5.2-fragmentless-show-hide-flips-all] Known.show/hide with no fragment flips ALL channels of the entry", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        const r = await k.edit({ db, statement: editStmt(urlPath("known", "x"), "body"), sessionId, runId });

        let rows = (await (db.test_list_visibility_for_run as PrepMethod).all<{ entry_id: number; channel: string; indexed: number }>({ run_id: runId }))
            .filter((row) => row.entry_id === r.entryId);
        assert.equal(rows.length, 2);
        assert.ok(rows.every((row) => row.indexed === 1));

        const h = await k.hide({ db, statement: hideStmt(urlPath("known", "x")), sessionId, runId });
        assert.equal(h.status, 200);
        rows = (await (db.test_list_visibility_for_run as PrepMethod).all<{ entry_id: number; channel: string; indexed: number }>({ run_id: runId }))
            .filter((row) => row.entry_id === r.entryId);
        assert.ok(rows.every((row) => row.indexed === 0), "both channels hidden");

        const s = await k.show({ db, statement: showStmt(urlPath("known", "x")), sessionId, runId });
        assert.equal(s.status, 200);
        rows = (await (db.test_list_visibility_for_run as PrepMethod).all<{ entry_id: number; channel: string; indexed: number }>({ run_id: runId }))
            .filter((row) => row.entry_id === r.entryId);
        assert.ok(rows.every((row) => row.indexed === 1), "both channels shown");
    } finally { await db.close(); }
});

test("[§5.5-fragment-targeted-show-hide] Known.show/hide with #preview flips ONLY that channel", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        const r = await k.edit({ db, statement: editStmt(urlPath("known", "x"), "body"), sessionId, runId });

        const h = await k.hide({ db, statement: hideStmt(urlPath("known", "x", "preview")), sessionId, runId });
        assert.equal(h.status, 200);

        const body = (await (db.test_get_visibility as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: r.entryId, channel: "body" }))?.indexed;
        const preview = (await (db.test_get_visibility as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: r.entryId, channel: "preview" }))?.indexed;
        assert.equal(body, 1, "body still indexed");
        assert.equal(preview, 0, "only preview hidden");
    } finally { await db.close(); }
});
