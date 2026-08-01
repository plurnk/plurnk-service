import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, LocalPath, ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, fullReplace } from "./_dsl.ts";

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
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

test("Known.edit: new entry — inserts entries row, body channel, tags", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const stmt = editStatement({
            target: urlPath("worker", "/countries/france/capital"),
            tags: ["france", "europe"],
            body: "Paris",
        });
        const result = await new Worker().edit(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const entry = await db.entry_read_lookup.get<{ workspace_id: number; owner_id: number; scheme: string; pathname: string }>({
            workspace_id: workspaceId, scheme: "worker", pathname: "/countries/france/capital",
        });
        assert.ok((entry?.owner_id ?? 0) >= 1, "owner stamped ({§entry-owner})");
        assert.equal(entry?.workspace_id, workspaceId);
        assert.equal(entry?.scheme, "worker");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const channel = await db.test_get_channel.get<{ content: string; mimetype: string; state: string }>({ entry_id: result.entryId, name: "body" });
        assert.equal(channel?.content, "Paris");
        assert.equal(channel?.mimetype, "text/markdown");
        assert.equal(channel?.state, "static");
        const tags = await db.test_list_entry_tags.all<{ tag: string }>({ entry_id: result.entryId });
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france"]);
    } finally { await db.close(); }
});

test("Known.edit: second EDIT against same path — same entry id, body replaced, status 200", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const first = await k.edit(editStatement({ target: urlPath("worker", "/x"), body: "initial" }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(first.status, 201);
        const second = await k.edit(editStatement({ target: urlPath("worker", "/x"), body: "updated", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId, "entry id is stable across edits");
        const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: first.entryId, name: "body" });
        assert.equal(channel?.content, "updated");
    } finally { await db.close(); }
});

test("EDIT that changes nothing returns 304; content change or new tag is still 200", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const target = urlPath("worker", "/noop");
        const first = await k.edit(editStatement({ target, body: "same" }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(first.status, 201);
        const reWrite = await k.edit(editStatement({ target, body: "same", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(reWrite.status, 304, "identical content, no tag → no-op");
        assert.equal(reWrite.entryId, first.entryId, "entry id still returned on 304");
        const changed = await k.edit(editStatement({ target, body: "different", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(changed.status, 200, "content change is a real update");
        const newTag = await k.edit(editStatement({ target, body: "different", tags: ["fresh"], lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(newTag.status, 200, "same content but a new tag is a real update");
        const sameTag = await k.edit(editStatement({ target, body: "different", tags: ["fresh"], lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(sameTag.status, 304, "same content and an already-present tag → no-op");
    } finally { await db.close(); }
});

test("Known.edit: empty body clears the channel content (does not delete the entry)", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const r1 = await k.edit(editStatement({ target: urlPath("worker", "/y"), body: "initial body" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target: urlPath("worker", "/y"), body: null, lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: r1.entryId, name: "body" });
        assert.equal(channel?.content, "");
        const entryStillThere = await db.test_get_entry_by_id.get<{ pathname: string }>({ id: r1.entryId });
        assert.ok(entryStillThere !== undefined);
    } finally { await db.close(); }
});

test("Known.edit: tags merge additively across multiple EDITs", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const target = urlPath("worker", "/z");
        const r = await k.edit(editStatement({ target, tags: ["france"], body: "a" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target, tags: ["geography"], body: "b", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target, tags: ["europe", "geography"], body: "c", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        const tags = await db.test_list_entry_tags.all<{ tag: string }>({ entry_id: r.entryId });
        assert.deepEqual(tags.map((t) => t.tag), ["europe", "france", "geography"]);
    } finally { await db.close(); }
});

test("Known.edit: null tags signal and empty tag array both produce no tag rows", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const r1 = await k.edit(editStatement({ target: urlPath("worker", "/no-tags"), tags: null, body: "body" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const r2 = await k.edit(editStatement({ target: urlPath("worker", "/empty-tags"), tags: [], body: "body" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const count1 = (await db.test_count_entry_tags.get<{ n: number }>({ entry_id: r1.entryId }))?.n;
        const count2 = (await db.test_count_entry_tags.get<{ n: number }>({ entry_id: r2.entryId }))?.n;
        assert.equal(count1, 0);
        assert.equal(count2, 0);
    } finally { await db.close(); }
});

test("Known.edit: lineMarker on non-existent entry — body becomes content", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const stmt = editStatement({ target: urlPath("worker", "/new"), body: "first line\nsecond line", lineMarker: { marks: [0] } });
        const result = await new Worker().edit(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 201);
        const read = await new Worker().read({ ...stmt, op: "READ", lineMarker: null, body: null } as never, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "first line\nsecond line");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <N> on existing entry replaces line N", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/ed"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await k.edit(editStatement({ target: urlPath("worker", "/ed"), body: "BETA", lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        const read = await k.read(readStatement({ target: urlPath("worker", "/ed") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <0> on existing entry prepends", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/p"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target: urlPath("worker", "/p"), body: "zero", lineMarker: { marks: [0] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        const read = await k.read(readStatement({ target: urlPath("worker", "/p") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "zero\none\ntwo");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <-1> on existing entry appends", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/a"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target: urlPath("worker", "/a"), body: "three", lineMarker: { marks: [-1] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        const read = await k.read(readStatement({ target: urlPath("worker", "/a") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "one\ntwo\nthree");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker <1,-1> empty body clears", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/c"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target: urlPath("worker", "/c"), body: "", lineMarker: { marks: [1, -1] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        const read = await k.read(readStatement({ target: urlPath("worker", "/c") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "");
    } finally { await db.close(); }
});

test("Known.edit: lineMarker out of range returns 416", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/r"), body: "only line" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await k.edit(editStatement({ target: urlPath("worker", "/r"), body: "x", lineMarker: { marks: [99] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("Known.edit: null path returns 400", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const stmt = editStatement({ target: null, body: "x" });
        const result = await new Worker().edit(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 400);
        assert.equal(result.entryId, null);
    } finally { await db.close(); }
});



test("Known.edit: exact coordinates edit minified JSON as text", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({
                target: urlPath("worker", "/users.json"),
                body: '[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]',
            }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const r = await k.edit(
            editStatement({
                target: urlPath("worker", "/users.json"),
                body: "Beth",
                lineMarker: { marks: [1, 28, 1, 31] },
            }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(r.status, 200);
        const read = await k.read(
            readStatement({ target: urlPath("worker", "/users.json") }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.deepEqual(JSON.parse(read.content ?? ""), [
            { name: "Alice" },
            { name: "Beth" },
            { name: "Carol" },
        ]);
    } finally { await db.close(); }
});

test("Known.edit: line shorthand edits JSON physical lines and can replace the whole resource", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({
                target: urlPath("worker", "/users.json"),
                body: '[\n  {"name":"Alice"},\n  {"name":"Bob"},\n  {"name":"Carol"}\n]',
            }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        await k.edit(
            editStatement({
                target: urlPath("worker", "/users.json"),
                body: '  {"name":"Beth"},',
                lineMarker: { marks: [3] },
            }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const read1 = await k.read(readStatement({ target: urlPath("worker", "/users.json") }), makeSchemeCtx({ db, workspaceId, mimetypes }));
        assert.deepEqual(JSON.parse(read1.content ?? ""), [
            { name: "Alice" },
            { name: "Beth" },
            { name: "Carol" },
        ]);

        await k.edit(
            editStatement({ target: urlPath("worker", "/users.json"), body: "[]", lineMarker: { marks: [1, -1] } }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const read2 = await k.read(readStatement({ target: urlPath("worker", "/users.json") }), makeSchemeCtx({ db, workspaceId, mimetypes }));
        assert.deepEqual(JSON.parse(read2.content ?? ""), []);
    } finally { await db.close(); }
});

test("Known.edit: line shorthand has the same meaning without a path suffix", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        // No suffix → text/markdown → line EDIT.
        await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "BETA", lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        const noSuffixRead = await k.read(readStatement({ target: urlPath("worker", "/notes") }), makeSchemeCtx({ db, workspaceId, mimetypes }));
        assert.equal(noSuffixRead.content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("Known.edit: textual JSON edits do not introduce a hidden parse gate", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/users.json"), body: '[1,2,3]' }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        const r = await k.edit(
            editStatement({ target: urlPath("worker", "/users.json"), body: "{not valid json", lineMarker: { marks: [-1] } }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(r.status, 200);
        const read = await k.read(readStatement({ target: urlPath("worker", "/users.json") }), makeSchemeCtx({ db, workspaceId, mimetypes }));
        assert.equal(read.content, '[1,2,3]\n{not valid json');
    } finally { await db.close(); }
});

test("Known.edit result carries a bounded effect receipt with revision identity", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const k = new Worker();
        // New entry: the receipt states the resulting revision and bounded join context.
        const r1 = await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "alpha\nbeta\ngamma" }), ctx);
        assert.equal(r1.status, 201);
        assert.match(r1.editReceipt?.revision ?? "", /^[a-f0-9]{64}$/);
        assert.deepEqual({ unit: r1.editReceipt?.unit, before: r1.editReceipt?.before, after: r1.editReceipt?.after }, { unit: "lines", before: 0, after: 3 });
        assert.match(r1.editReceipt?.effects[0]?.context ?? "", /1:alpha\n2:beta\n3:gamma/);
        const r2 = await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "alpha\nBETA\ngamma", lineMarker: fullReplace }), ctx);
        assert.equal(r2.status, 200);
        assert.deepEqual(
            r2.editReceipt?.effects.map(({ requested, source, result, removed, inserted }) => ({ requested, source, result, removed, inserted })),
            [{ requested: "<1,-1>", source: "1-3", result: "1-3", removed: 3, inserted: 3 }],
        );
        assert.match(r2.editReceipt?.effects[0]?.context ?? "", /1:alpha\n2:BETA\n3:gamma/);
    } finally { await db.close(); }
});
