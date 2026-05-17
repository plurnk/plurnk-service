import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, LocalPath, ParsedPath, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

// Constructing EditStatement objects directly rather than parsing via PlurnkParser.
// Node 25 refuses to strip types from files under node_modules/, and the grammar
// package ships .ts-only sources at 0.2.1. Type-only imports erase cleanly; value
// imports of PlurnkParser would fail at runtime. Surfaced in the PR description.

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const localPath = (raw: string): LocalPath => ({ kind: "local", raw });

const editStatement = (opts: {
    path?: ParsedPath | null; tags?: string[] | null; body?: string | null;
    lineMarker?: LineMarker | null; suffix?: string;
}): EditStatement => ({
    op: "EDIT",
    suffix: opts.suffix ?? "",
    signal: opts.tags ?? null,
    path: opts.path ?? null,
    lineMarker: opts.lineMarker ?? null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const setupContext = async () => {
    const db = await openMigrated();
    const sessionId = insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Known.edit: new entry — inserts entries row, body channel, tags, visibility", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({
            path: urlPath("known", "/countries/france/capital"),
            tags: ["france", "europe"],
            body: "Paris",
        });
        const result = await new Known().edit({ db, statement: stmt, sessionId, runId });
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const entry = db.prepare("SELECT scope, session_id, scheme, pathname FROM entries WHERE id = ?").get(result.entryId) as { scope: string; session_id: number; scheme: string; pathname: string };
        assert.equal(entry.scope, "session");
        assert.equal(entry.session_id, sessionId);
        assert.equal(entry.scheme, "known");
        assert.equal(entry.pathname, "/countries/france/capital");
        const channel = db.prepare("SELECT content, mimetype, state FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(result.entryId) as { content: string; mimetype: string; state: string };
        assert.equal(channel.content, "Paris");
        assert.equal(channel.mimetype, "text/markdown");
        assert.equal(channel.state, "static");
        const tags = db.prepare("SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag").all(result.entryId) as { tag: string }[];
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france"]);
        const vis = db.prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ? AND channel = 'body'").get(runId, result.entryId) as { indexed: number };
        assert.equal(vis.indexed, 1);
    } finally { db.close(); }
});

test("Known.edit: second EDIT against same path — same entry id, body replaced, status 200", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const first = await k.edit({ db, statement: editStatement({ path: urlPath("known", "/x"), body: "initial" }), sessionId, runId });
        assert.equal(first.status, 201);
        const second = await k.edit({ db, statement: editStatement({ path: urlPath("known", "/x"), body: "updated" }), sessionId, runId });
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId, "entry id is stable across edits");
        const body = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(first.entryId) as { content: string }).content;
        assert.equal(body, "updated");
    } finally { db.close(); }
});

test("Known.edit: empty body clears the channel content (does not delete the entry)", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const r1 = await k.edit({ db, statement: editStatement({ path: urlPath("known", "/y"), body: "initial body" }), sessionId, runId });
        await k.edit({ db, statement: editStatement({ path: urlPath("known", "/y"), body: null }), sessionId, runId });
        const body = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = ? AND name = 'body'").get(r1.entryId) as { content: string }).content;
        assert.equal(body, "");
        const entryStillThere = db.prepare("SELECT id FROM entries WHERE id = ?").get(r1.entryId) as { id: number };
        assert.equal(entryStillThere.id, r1.entryId);
    } finally { db.close(); }
});

test("Known.edit: tags merge additively across multiple EDITs", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const path = urlPath("known", "/z");
        const r = await k.edit({ db, statement: editStatement({ path, tags: ["france"], body: "a" }), sessionId, runId });
        await k.edit({ db, statement: editStatement({ path, tags: ["geography"], body: "b" }), sessionId, runId });
        await k.edit({ db, statement: editStatement({ path, tags: ["europe", "geography"], body: "c" }), sessionId, runId });
        const tags = db.prepare("SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag").all(r.entryId) as { tag: string }[];
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france", "geography"]);
    } finally { db.close(); }
});

test("Known.edit: null tags signal and empty tag array both produce no tag rows", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const r1 = await k.edit({ db, statement: editStatement({ path: urlPath("known", "/no-tags"), tags: null, body: "body" }), sessionId, runId });
        const r2 = await k.edit({ db, statement: editStatement({ path: urlPath("known", "/empty-tags"), tags: [], body: "body" }), sessionId, runId });
        const count1 = (db.prepare("SELECT COUNT(*) AS n FROM entry_tags WHERE entry_id = ?").get(r1.entryId) as { n: number }).n;
        const count2 = (db.prepare("SELECT COUNT(*) AS n FROM entry_tags WHERE entry_id = ?").get(r2.entryId) as { n: number }).n;
        assert.equal(count1, 0);
        assert.equal(count2, 0);
    } finally { db.close(); }
});

test("Known.edit: lineMarker present returns 501 without writing anything", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ path: urlPath("known", "/lined"), body: "line 5 content", lineMarker: { first: 5, last: null } });
        const result = await new Known().edit({ db, statement: stmt, sessionId, runId });
        assert.equal(result.status, 501);
        assert.equal(result.entryId, null);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
        assert.equal(count, 0, "no entry should have been created");
    } finally { db.close(); }
});

test("Known.edit: null path returns 400", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ path: null, body: "x" });
        const result = await new Known().edit({ db, statement: stmt, sessionId, runId });
        assert.equal(result.status, 400);
        assert.equal(result.entryId, null);
    } finally { db.close(); }
});

test("Known.edit: visibility row idempotent across multiple EDITs of same path", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const path = urlPath("known", "/vis");
        const r = await k.edit({ db, statement: editStatement({ path, body: "a" }), sessionId, runId });
        await k.edit({ db, statement: editStatement({ path, body: "b" }), sessionId, runId });
        await k.edit({ db, statement: editStatement({ path, body: "c" }), sessionId, runId });
        const count = (db.prepare("SELECT COUNT(*) AS n FROM visibility WHERE entry_id = ?").get(r.entryId) as { n: number }).n;
        assert.equal(count, 1, "INSERT OR IGNORE produces exactly one visibility row");
    } finally { db.close(); }
});

test("Known.edit: visibility is per-run — same entry edited in different runs gets two rows", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const runB = insertRun(db, sessionId);
        const k = new Known();
        const path = urlPath("known", "/multirun");
        const r = await k.edit({ db, statement: editStatement({ path, body: "a" }), sessionId, runId });
        await k.edit({ db, statement: editStatement({ path, body: "b" }), sessionId, runId: runB });
        const rows = db.prepare("SELECT run_id, indexed FROM visibility WHERE entry_id = ? ORDER BY run_id").all(r.entryId) as { run_id: number; indexed: number }[];
        assert.equal(rows.length, 2);
        assert.equal(rows.every((r) => r.indexed === 1), true);
    } finally { db.close(); }
});

test("Known.edit: bare local path is treated as the raw pathname", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ path: localPath("config/foo.json"), body: "{}" });
        const result = await new Known().edit({ db, statement: stmt, sessionId, runId });
        assert.equal(result.status, 201);
        const entry = db.prepare("SELECT pathname FROM entries WHERE id = ?").get(result.entryId) as { pathname: string };
        assert.equal(entry.pathname, "config/foo.json");
    } finally { db.close(); }
});
