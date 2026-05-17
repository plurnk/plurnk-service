// Tests for SPEC §3.1 channel manifest + §5.5 fragment-as-channel-selector.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, ReadStatement, ShowStatement, HideStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const url = (pathname: string, fragment: string | null = null): UrlPath => ({
    kind: "url", raw: `known://${pathname}${fragment !== null ? `#${fragment}` : ""}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment,
});

const editStmt = (path: UrlPath, body: string | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const readStmt = (path: UrlPath): ReadStatement => ({
    op: "READ", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const showStmt = (path: UrlPath): ShowStatement => ({
    op: "SHOW", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const hideStmt = (path: UrlPath): HideStatement => ({
    op: "HIDE", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Known declares static channels manifest + defaultChannel", () => {
    assert.deepEqual(Known.channels, { body: "text/markdown", preview: "text/markdown" });
    assert.equal(Known.defaultChannel, "body");
});

test("Known.edit default channel writes body AND preview channels", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(url("x"), "hello"), sessionId, runId });
        assert.equal(r.status, 201);
        assert.equal(r.channel, "body");

        const channels = db.prepare("SELECT name, content, mimetype FROM entry_channels WHERE entry_id = ? ORDER BY name").all(r.entryId) as Array<{ name: string; content: string; mimetype: string }>;
        assert.equal(channels.length, 2);
        const body = channels.find((c) => c.name === "body");
        const preview = channels.find((c) => c.name === "preview");
        assert.ok(body !== undefined);
        assert.equal(body.content, "hello");
        assert.equal(body.mimetype, "text/markdown");
        assert.ok(preview !== undefined);
        assert.equal(preview.content, "hello", "v0: preview = body verbatim per SPEC §5.1");
        assert.equal(preview.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Known.edit default channel indexes BOTH body and preview in visibility", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(url("x"), "hello"), sessionId, runId });
        const channels = (db.prepare("SELECT channel FROM visibility WHERE run_id = ? AND entry_id = ? ORDER BY channel").all(runId, r.entryId) as { channel: string }[]).map((r) => r.channel);
        assert.deepEqual(channels, ["body", "preview"]);
    } finally { db.close(); }
});

test("Known.edit with #preview fragment writes ONLY preview channel", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        // First create the entry with default channel
        await k.edit({ db, statement: editStmt(url("x"), "default body"), sessionId, runId });
        // Now overwrite preview explicitly
        const r = await k.edit({ db, statement: editStmt(url("x", "preview"), "custom preview"), sessionId, runId });
        assert.equal(r.status, 200);
        assert.equal(r.channel, "preview");

        const body = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(r.entryId) as { content: string }).content;
        assert.equal(body, "default body", "body unchanged");

        const preview = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'preview'").get(r.entryId) as { content: string }).content;
        assert.equal(preview, "custom preview", "preview updated");
    } finally { db.close(); }
});

test("Known.edit with #preview on nonexistent entry returns 404", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(url("nope", "preview"), "x"), sessionId, runId });
        assert.equal(r.status, 404);
        assert.equal(r.entryId, null);
    } finally { db.close(); }
});

test("Known.edit with unknown channel returns 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Known().edit({ db, statement: editStmt(url("x", "not-a-channel"), "x"), sessionId, runId });
        assert.equal(r.status, 400);
        assert.equal(r.entryId, null);
    } finally { db.close(); }
});

test("Known.read with #preview fragment returns preview channel content", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, statement: editStmt(url("x"), "body content"), sessionId, runId });
        await k.edit({ db, statement: editStmt(url("x", "preview"), "preview content"), sessionId, runId });

        const r = await k.read({ db, statement: readStmt(url("x", "preview")), sessionId });
        assert.equal(r.status, 200);
        assert.equal(r.content, "preview content");
        assert.equal(r.channel, "preview");
    } finally { db.close(); }
});

test("Known.read with no fragment returns body channel (default)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, statement: editStmt(url("x"), "body content"), sessionId, runId });
        const r = await k.read({ db, statement: readStmt(url("x")), sessionId });
        assert.equal(r.status, 200);
        assert.equal(r.content, "body content");
        assert.equal(r.channel, "body");
    } finally { db.close(); }
});

test("Known.read with unknown channel returns 400", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, statement: editStmt(url("x"), "body content"), sessionId, runId });
        const r = await k.read({ db, statement: readStmt(url("x", "not-a-channel")), sessionId });
        assert.equal(r.status, 400);
    } finally { db.close(); }
});

test("Known.show/hide with no fragment flips ALL channels of the entry", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        const r = await k.edit({ db, statement: editStmt(url("x"), "body"), sessionId, runId });

        // Both body and preview should be indexed=1 after EDIT
        let rows = db.prepare("SELECT channel, indexed FROM visibility WHERE entry_id = ? ORDER BY channel").all(r.entryId) as Array<{ channel: string; indexed: number }>;
        assert.equal(rows.length, 2);
        assert.ok(rows.every((row) => row.indexed === 1));

        // HIDE (no fragment) flips both
        const h = await k.hide({ db, statement: hideStmt(url("x")), sessionId, runId });
        assert.equal(h.status, 200);
        rows = db.prepare("SELECT channel, indexed FROM visibility WHERE entry_id = ? ORDER BY channel").all(r.entryId) as Array<{ channel: string; indexed: number }>;
        assert.ok(rows.every((row) => row.indexed === 0), "both channels hidden");

        // SHOW (no fragment) flips both back
        const s = await k.show({ db, statement: showStmt(url("x")), sessionId, runId });
        assert.equal(s.status, 200);
        rows = db.prepare("SELECT channel, indexed FROM visibility WHERE entry_id = ? ORDER BY channel").all(r.entryId) as Array<{ channel: string; indexed: number }>;
        assert.ok(rows.every((row) => row.indexed === 1), "both channels shown");
    } finally { db.close(); }
});

test("Known.show/hide with #preview flips ONLY that channel", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();
        const r = await k.edit({ db, statement: editStmt(url("x"), "body"), sessionId, runId });

        // HIDE only preview
        const h = await k.hide({ db, statement: hideStmt(url("x", "preview")), sessionId, runId });
        assert.equal(h.status, 200);

        const body = (db.prepare("SELECT indexed FROM visibility WHERE entry_id = ? AND channel = 'body'").get(r.entryId) as { indexed: number }).indexed;
        const preview = (db.prepare("SELECT indexed FROM visibility WHERE entry_id = ? AND channel = 'preview'").get(r.entryId) as { indexed: number }).indexed;
        assert.equal(body, 1, "body still indexed");
        assert.equal(preview, 0, "only preview hidden");
    } finally { db.close(); }
});
