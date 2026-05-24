import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, LocalPath, ParsedPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { urlPath } from "./_dsl.ts";

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
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
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
        const result = await new Known().edit(stmt, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const entry = await (db.entry_read_lookup as PrepMethod).get<{ scope: string; session_id: number; scheme: string; pathname: string }>({
            session_id: sessionId, scheme: "known", pathname: "/countries/france/capital",
        });
        assert.equal(entry?.scope, "session");
        assert.equal(entry?.session_id, sessionId);
        assert.equal(entry?.scheme, "known");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string; mimetype: string; state: string }>({ entry_id: result.entryId, name: "body" });
        assert.equal(channel?.content, "Paris");
        assert.equal(channel?.mimetype, "text/markdown");
        assert.equal(channel?.state, "static");
        const tags = await (db.test_list_entry_tags as PrepMethod).all<{ tag: string }>({ entry_id: result.entryId });
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france"]);
        const vis = await (db.test_get_visibility as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: result.entryId, channel: "body" });
        assert.equal(vis?.indexed, 1);
    } finally { await db.close(); }
});

test("Known.edit: second EDIT against same path — same entry id, body replaced, status 200", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const first = await k.edit(editStatement({ path: urlPath("known", "/x"), body: "initial" }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(first.status, 201);
        const second = await k.edit(editStatement({ path: urlPath("known", "/x"), body: "updated" }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId, "entry id is stable across edits");
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: first.entryId, name: "body" });
        assert.equal(channel?.content, "updated");
    } finally { await db.close(); }
});

test("Known.edit: empty body clears the channel content (does not delete the entry)", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const r1 = await k.edit(editStatement({ path: urlPath("known", "/y"), body: "initial body" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ path: urlPath("known", "/y"), body: null }), makeSchemeCtx({ db, sessionId, runId }));
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: r1.entryId, name: "body" });
        assert.equal(channel?.content, "");
        const entryStillThere = await (db.test_get_entry_by_id as PrepMethod).get<{ pathname: string }>({ id: r1.entryId });
        assert.ok(entryStillThere !== undefined);
    } finally { await db.close(); }
});

test("Known.edit: tags merge additively across multiple EDITs", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const path = urlPath("known", "/z");
        const r = await k.edit(editStatement({ path, tags: ["france"], body: "a" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ path, tags: ["geography"], body: "b" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ path, tags: ["europe", "geography"], body: "c" }), makeSchemeCtx({ db, sessionId, runId }));
        const tags = await (db.test_list_entry_tags as PrepMethod).all<{ tag: string }>({ entry_id: r.entryId });
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france", "geography"]);
    } finally { await db.close(); }
});

test("Known.edit: null tags signal and empty tag array both produce no tag rows", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const r1 = await k.edit(editStatement({ path: urlPath("known", "/no-tags"), tags: null, body: "body" }), makeSchemeCtx({ db, sessionId, runId }));
        const r2 = await k.edit(editStatement({ path: urlPath("known", "/empty-tags"), tags: [], body: "body" }), makeSchemeCtx({ db, sessionId, runId }));
        const count1 = (await (db.test_count_entry_tags as PrepMethod).get<{ n: number }>({ entry_id: r1.entryId }))?.n;
        const count2 = (await (db.test_count_entry_tags as PrepMethod).get<{ n: number }>({ entry_id: r2.entryId }))?.n;
        assert.equal(count1, 0);
        assert.equal(count2, 0);
    } finally { await db.close(); }
});

test("Known.edit: lineMarker present returns 501 without writing anything", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ path: urlPath("known", "/lined"), body: "line 5 content", lineMarker: { first: 5, last: null } });
        const result = await new Known().edit(stmt, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(result.status, 501);
        assert.equal(result.entryId, null);
        const count = (await (db.test_count_entries as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 0, "no entry should have been created");
    } finally { await db.close(); }
});

test("Known.edit: null path returns 400", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ path: null, body: "x" });
        const result = await new Known().edit(stmt, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(result.status, 400);
        assert.equal(result.entryId, null);
    } finally { await db.close(); }
});

test("Known.edit: visibility rows idempotent across multiple EDITs of same path", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const path = urlPath("known", "/vis");
        const r = await k.edit(editStatement({ path, body: "a" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ path, body: "b" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ path, body: "c" }), makeSchemeCtx({ db, sessionId, runId }));
        const count = (await (db.test_count_visibility_for_entry as PrepMethod).get<{ n: number }>({ entry_id: r.entryId }))?.n;
        assert.equal(count, 1, "INSERT OR IGNORE produces exactly one visibility row per channel (body)");
    } finally { await db.close(); }
});

test("Known.edit: visibility is per-run — same entry edited in different runs gets fresh rows", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const runB = await insertRun(db, sessionId);
        const k = new Known();
        const path = urlPath("known", "/multirun");
        const r = await k.edit(editStatement({ path, body: "a" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ path, body: "b" }), makeSchemeCtx({ db, sessionId, runId: runB }));
        const count = (await (db.test_count_visibility_for_entry as PrepMethod).get<{ n: number }>({ entry_id: r.entryId }))?.n;
        assert.equal(count, 2, "2 runs × 1 channel (body) = 2 visibility rows");
    } finally { await db.close(); }
});

test("Known.edit: bare local path is treated as the raw pathname", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ path: localPath("config/foo.json"), body: "{}" });
        const result = await new Known().edit(stmt, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(result.status, 201);
        const entry = await (db.test_get_entry_by_id as PrepMethod).get<{ pathname: string }>({ id: result.entryId });
        assert.equal(entry?.pathname, "config/foo.json");
    } finally { await db.close(); }
});
