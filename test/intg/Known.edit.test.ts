import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, LocalPath, ParsedPath, ReadStatement } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Known from "../../src/schemes/Known.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { urlPath } from "./_dsl.ts";

const localPath = (raw: string): LocalPath => ({ kind: "local", raw });

const editStatement = (opts: {
    target?: ParsedPath | null; tags?: string[] | null; body?: string | null;
    lineMarker?: LineMarker | null; suffix?: string;
}): EditStatement => ({
    op: "EDIT",
    suffix: opts.suffix ?? "",
    signal: opts.tags ?? null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: { target?: ParsedPath | null }): ReadStatement => ({
    op: "READ",
    suffix: "",
    signal: null,
    target: opts.target ?? null,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 1 },
});

const setupContext = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Known.edit: new entry — inserts entries row, body channel, tags", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({
            target: urlPath("known", "/countries/france/capital"),
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
    } finally { await db.close(); }
});

test("[§edit-status-201-200] Known.edit: second EDIT against same path — same entry id, body replaced, status 200", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const first = await k.edit(editStatement({ target: urlPath("known", "/x"), body: "initial" }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(first.status, 201);
        const second = await k.edit(editStatement({ target: urlPath("known", "/x"), body: "updated" }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId, "entry id is stable across edits");
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: first.entryId, name: "body" });
        assert.equal(channel?.content, "updated");
    } finally { await db.close(); }
});

test("[§edit-noop-304] EDIT that changes nothing returns 304; content change or new tag is still 200", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const target = urlPath("known", "/noop");
        const first = await k.edit(editStatement({ target, body: "same" }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(first.status, 201);
        const reWrite = await k.edit(editStatement({ target, body: "same" }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(reWrite.status, 304, "identical content, no tag → no-op");
        assert.equal(reWrite.entryId, first.entryId, "entry id still returned on 304");
        const changed = await k.edit(editStatement({ target, body: "different" }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(changed.status, 200, "content change is a real update");
        const newTag = await k.edit(editStatement({ target, body: "different", tags: ["fresh"] }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(newTag.status, 200, "same content but a new tag is a real update");
        const sameTag = await k.edit(editStatement({ target, body: "different", tags: ["fresh"] }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(sameTag.status, 304, "same content and an already-present tag → no-op");
    } finally { await db.close(); }
});

test("[§edit-null-clears] Known.edit: empty body clears the channel content (does not delete the entry)", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const r1 = await k.edit(editStatement({ target: urlPath("known", "/y"), body: "initial body" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ target: urlPath("known", "/y"), body: null }), makeSchemeCtx({ db, sessionId, runId }));
        const channel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: r1.entryId, name: "body" });
        assert.equal(channel?.content, "");
        const entryStillThere = await (db.test_get_entry_by_id as PrepMethod).get<{ pathname: string }>({ id: r1.entryId });
        assert.ok(entryStillThere !== undefined);
    } finally { await db.close(); }
});

test("[§edit-tags-additive] Known.edit: tags merge additively across multiple EDITs", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const target = urlPath("known", "/z");
        const r = await k.edit(editStatement({ target, tags: ["france"], body: "a" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ target, tags: ["geography"], body: "b" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ target, tags: ["europe", "geography"], body: "c" }), makeSchemeCtx({ db, sessionId, runId }));
        const tags = await (db.test_list_entry_tags as PrepMethod).all<{ tag: string }>({ entry_id: r.entryId });
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france", "geography"]);
    } finally { await db.close(); }
});

test("Known.edit: null tags signal and empty tag array both produce no tag rows", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const r1 = await k.edit(editStatement({ target: urlPath("known", "/no-tags"), tags: null, body: "body" }), makeSchemeCtx({ db, sessionId, runId }));
        const r2 = await k.edit(editStatement({ target: urlPath("known", "/empty-tags"), tags: [], body: "body" }), makeSchemeCtx({ db, sessionId, runId }));
        const count1 = (await (db.test_count_entry_tags as PrepMethod).get<{ n: number }>({ entry_id: r1.entryId }))?.n;
        const count2 = (await (db.test_count_entry_tags as PrepMethod).get<{ n: number }>({ entry_id: r2.entryId }))?.n;
        assert.equal(count1, 0);
        assert.equal(count2, 0);
    } finally { await db.close(); }
});

test("Known.edit: lineMarker on non-existent entry — body becomes content", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ target: urlPath("known", "/new"), body: "first line\nsecond line", lineMarker: { first: 0, last: null } });
        const result = await new Known().edit(stmt, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(result.status, 201);
        const read = await new Known().read({ ...stmt, op: "READ", lineMarker: null, body: null } as never, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal((read as { content: string }).content, "first line\nsecond line");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <N> on existing entry replaces line N", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/ed"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, sessionId, runId }));
        const r = await k.edit(editStatement({ target: urlPath("known", "/ed"), body: "BETA", lineMarker: { first: 2, last: null } }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(r.status, 200);
        const read = await k.read(readStatement({ target: urlPath("known", "/ed") }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal((read as { content: string }).content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <0> on existing entry prepends", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/p"), body: "one\ntwo" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ target: urlPath("known", "/p"), body: "zero", lineMarker: { first: 0, last: null } }), makeSchemeCtx({ db, sessionId, runId }));
        const read = await k.read(readStatement({ target: urlPath("known", "/p") }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal((read as { content: string }).content, "zero\none\ntwo");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <-1> on existing entry appends", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/a"), body: "one\ntwo" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ target: urlPath("known", "/a"), body: "three", lineMarker: { first: -1, last: null } }), makeSchemeCtx({ db, sessionId, runId }));
        const read = await k.read(readStatement({ target: urlPath("known", "/a") }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal((read as { content: string }).content, "one\ntwo\nthree");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <1,-1> empty body clears", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/c"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStatement({ target: urlPath("known", "/c"), body: "", lineMarker: { first: 1, last: -1 } }), makeSchemeCtx({ db, sessionId, runId }));
        const read = await k.read(readStatement({ target: urlPath("known", "/c") }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal((read as { content: string }).content, "");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker out of range returns 416", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/r"), body: "only line" }), makeSchemeCtx({ db, sessionId, runId }));
        const r = await k.edit(editStatement({ target: urlPath("known", "/r"), body: "x", lineMarker: { first: 99, last: null } }), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("Known.edit: null path returns 400", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ target: null, body: "x" });
        const result = await new Known().edit(stmt, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(result.status, 400);
        assert.equal(result.entryId, null);
    } finally { await db.close(); }
});

test("Known.edit: bare local path is treated as the raw pathname", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const stmt = editStatement({ target: localPath("config/foo.json"), body: "{}" });
        const result = await new Known().edit(stmt, makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(result.status, 201);
        const entry = await (db.test_get_entry_by_id as PrepMethod).get<{ pathname: string }>({ id: result.entryId });
        assert.equal(entry?.pathname, "config/foo.json");
    } finally { await db.close(); }
});

// --- Structural <L> EDIT on JSON (M.8 / grammar 0.13.0 + 0.14.0) ---

test("[§json-edit-structural-json-edit] Known.edit: <-1> on `.json` path appends an item structurally (grammar 0.14.0 example)", async () => {
    const { db, sessionId, runId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Known();
        await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: '[{"name":"Alice"}]' }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        // The grammar example: <<EDIT(known://users.json)<-1>:{"name":"Eve"}:EDIT
        const r = await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: '{"name":"Eve"}', lineMarker: { first: -1, last: null } }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        assert.equal(r.status, 200);
        const read = await k.read(
            readStatement({ target: urlPath("known", "/users.json") }),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        assert.deepEqual(JSON.parse(read.content ?? ""), [
            { name: "Alice" },
            { name: "Eve" },
        ]);
    } finally { await db.close(); }
});

test("Known.edit: <N> on `.json` replaces position N; <1,-1>:[]:EDIT clears", async () => {
    const { db, sessionId, runId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Known();
        await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: '[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]' }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        // Replace position 2 (Bob) with a new item.
        await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: '{"name":"Beth"}', lineMarker: { first: 2, last: null } }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        const read1 = await k.read(readStatement({ target: urlPath("known", "/users.json") }), makeSchemeCtx({ db, sessionId, mimetypes }));
        assert.deepEqual(JSON.parse(read1.content ?? ""), [
            { name: "Alice" },
            { name: "Beth" },
            { name: "Carol" },
        ]);

        // <1,-1>:[]:EDIT clears the array.
        await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: "[]", lineMarker: { first: 1, last: -1 } }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        const read2 = await k.read(readStatement({ target: urlPath("known", "/users.json") }), makeSchemeCtx({ db, sessionId, mimetypes }));
        assert.deepEqual(JSON.parse(read2.content ?? ""), []);
    } finally { await db.close(); }
});

test("Known.edit: <L> on no-suffix path is line-based; .json siblings get structural", async () => {
    const { db, sessionId, runId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Known();
        // No suffix → text/markdown → line EDIT.
        await k.edit(editStatement({ target: urlPath("known", "/notes"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, sessionId, runId, mimetypes }));
        await k.edit(editStatement({ target: urlPath("known", "/notes"), body: "BETA", lineMarker: { first: 2, last: null } }), makeSchemeCtx({ db, sessionId, runId, mimetypes }));
        const noSuffixRead = await k.read(readStatement({ target: urlPath("known", "/notes") }), makeSchemeCtx({ db, sessionId, mimetypes }));
        assert.equal(noSuffixRead.content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("[§json-edit-json-parse-fail-400] Known.edit: <L> on JSON path with malformed body → 400", async () => {
    const { db, sessionId, runId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/users.json"), body: '[1,2,3]' }), makeSchemeCtx({ db, sessionId, runId, mimetypes }));
        const r = await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: "{not valid json", lineMarker: { first: -1, last: null } }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        assert.equal(r.status, 400);
        // Original content unchanged.
        const read = await k.read(readStatement({ target: urlPath("known", "/users.json") }), makeSchemeCtx({ db, sessionId, mimetypes }));
        assert.deepEqual(JSON.parse(read.content ?? ""), [1, 2, 3]);
    } finally { await db.close(); }
});

test("Known.edit result carries the edited span — post-edit state, line-numbered (§edit-result-render)", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        const k = new Known();
        // New entry: the whole body is the edit → span is the full body, 1-indexed.
        const r1 = await k.edit(editStatement({ target: urlPath("known", "/notes"), body: "alpha\nbeta\ngamma" }), ctx);
        assert.equal(r1.status, 201);
        assert.equal(r1.span, "1:\talpha\n2:\tbeta\n3:\tgamma", "new entry → span is the full body, line-numbered");
        // Re-edit changing one line: the diff finds it; span shows the edited region
        // plus context, in its post-edit state — not the input statement.
        const r2 = await k.edit(editStatement({ target: urlPath("known", "/notes"), body: "alpha\nBETA\ngamma" }), ctx);
        assert.equal(r2.status, 200);
        assert.equal(r2.span, "1:\talpha\n2:\tBETA\n3:\tgamma", "re-edit → span shows the change (BETA) with context, post-edit, line-numbered");
    } finally { await db.close(); }
});
