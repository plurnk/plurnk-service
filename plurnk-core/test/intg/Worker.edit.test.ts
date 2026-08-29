import test from "node:test";
import assert from "node:assert/strict";
import type { LineMarker, ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, lookThroughScheme, makeSchemeCtx, seedStaticChannel } from "./_helpers.ts";
import { urlPath, fullReplace } from "./_dsl.ts";

const editStatement = (opts: {
    target?: ParsedPath | null; tags?: string[] | null; body?: string | null;
    lineMarker?: LineMarker | null; delimiter?: string;
}): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT",
    annotation: null,
    delimiter: opts.delimiter ?? "",
    signal: opts.tags ?? null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: { target?: ParsedPath | null }): ReadStatement => ({
    metadata: null,
    op: "READ",
    annotation: null,
    delimiter: "",
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

test("Worker.edit: new entry — inserts entries row and body channel", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const stmt = editStatement({
            target: urlPath("worker", "/countries/france/capital"),
            body: "Paris",
        });
        const result = await new Worker().edit(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const entry = await db.test_get_entry_by_id.get<{
            workspace_id: number;
            owner_id: number;
            scheme: string;
            pathname: string;
        }>({ id: result.entryId });
        assert.ok((entry?.owner_id ?? 0) >= 1, "owner stamped ({§entry-owner})");
        assert.equal(entry?.workspace_id, workspaceId);
        assert.equal(entry?.scheme, "worker");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const channel = await db.test_get_channel.get<{ content: string; mimetype: string; state: string }>({ entry_id: result.entryId, name: "body" });
        assert.equal(channel?.content, "Paris");
        assert.equal(channel?.mimetype, "text/markdown");
        assert.equal(channel?.state, "static");
    } finally { await db.close(); }
});

test("Worker.edit: a concurrent creator wins cleanly and the losing EDIT reports a collision", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const claim = new Proxy(db.ops_insert_workspace_entry_if_absent, {
            get(statement, property) {
                if (property !== "get") return Reflect.get(statement, property, statement) as unknown;
                return async <R = Record<string, unknown>>(params?: Record<string, unknown>): Promise<R | undefined> => {
                    const winner = await db.ops_insert_workspace_entry_if_absent.get<{ id: number }>(params);
                    await seedStaticChannel(db, winner?.id, {
                        name: "body",
                        content: "other worker",
                        mimetype: "text/markdown",
                    });
                    return db.ops_insert_workspace_entry_if_absent.get<R>(params);
                };
            },
        });
        const collisionDb = new Proxy(db, {
            get(subject, property) {
                if (property === "ops_insert_workspace_entry_if_absent") return claim;
                return Reflect.get(subject, property, subject) as unknown;
            },
        });
        const result = await new Worker().edit(
            editStatement({ target: urlPath("worker", "/create-race.md"), body: "authored edit" }),
            makeSchemeCtx({ db: collisionDb, workspaceId, workerId }),
        );
        assert.equal(result.status, 409);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(result.problem?.detail, "EDIT coordinates collided with another change.");
        assert.equal(result.problem?.target, "worker:///create-race.md");
        const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/create-race.md",
            scheme: "worker",
            name: "body",
        });
        assert.equal(channel?.content, "other worker");
    } finally { await db.close(); }
});

test("Worker.edit: second EDIT against same path — same entry id, body replaced, status 200", async () => {
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

test("Worker.edit: a representation change at atomic landing returns edit-collision without clobbering it", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const worker = new Worker();
        const target = urlPath("worker", "/cas.md");
        const created = await worker.edit(
            editStatement({ target, body: "original" }),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(created.status, 201);
        assert.notEqual(created.entryId, null);

        const update = new Proxy(db.ops_update_channel_if_content, {
            get(statement, property) {
                if (property !== "get") return Reflect.get(statement, property, statement) as unknown;
                return async <R = Record<string, unknown>>(params?: Record<string, unknown>): Promise<R | undefined> => {
                    await db.crud_delete_channels.run({ entry_id: created.entryId });
                    await seedStaticChannel(db, created.entryId ?? undefined, {
                        name: "body",
                        content: "other worker",
                        mimetype: "text/markdown",
                    });
                    return db.ops_update_channel_if_content.get<R>(params);
                };
            },
        });
        const collisionDb = new Proxy(db, {
            get(subject, property) {
                if (property === "ops_update_channel_if_content") return update;
                return Reflect.get(subject, property, subject) as unknown;
            },
        });
        const result = await worker.edit(
            editStatement({ target, body: "authored edit", lineMarker: fullReplace }),
            makeSchemeCtx({ db: collisionDb, workspaceId, workerId }),
        );
        assert.equal(result.status, 409);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(result.problem?.detail, "EDIT coordinates collided with another change.");
        assert.equal(result.problem?.target, "worker:///cas.md");
        const channel = await db.test_get_channel.get<{ content: string }>({
            entry_id: created.entryId,
            name: "body",
        });
        assert.equal(channel?.content, "other worker");
    } finally { await db.close(); }
});

test("EDIT that changes nothing returns 304; only a content change updates the entry", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const target = urlPath("worker", "/noop");
        const first = await k.edit(editStatement({ target, body: "same" }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(first.status, 201);
        const reWrite = await k.edit(editStatement({ target, body: "same", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(reWrite.status, 304, "identical content → no-op");
        assert.equal(
            reWrite.detail,
            "No change: EDIT body matches the selected content. Omit the body to delete the selection.",
        );
        assert.equal(reWrite.entryId, first.entryId, "entry id still returned on 304");
        const changed = await k.edit(editStatement({ target, body: "different", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(changed.status, 200, "content change is a real update");
        const newTag = await k.edit(editStatement({ target, body: "different", tags: ["+fresh"], lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(newTag.status, 304, "a model signal does not alter the resource");
        const sameTag = await k.edit(editStatement({ target, body: "different", tags: ["+fresh"], lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(sameTag.status, 304, "repeating the signal does not alter the resource");
    } finally { await db.close(); }
});

test("Worker.edit: empty body clears the channel content (does not delete the entry)", async () => {
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

test("Worker.edit: lineMarker on non-existent entry — body becomes content", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const stmt = editStatement({ target: urlPath("worker", "/new"), body: "first line\nsecond line", lineMarker: { marks: [0] } });
        const result = await new Worker().edit(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 201);
        const read = await lookThroughScheme("worker", null, { ...stmt, op: "READ", lineMarker: null, body: null } as never, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "first line\nsecond line");
    } finally { await db.close(); }
});

test("Worker.edit: lineMarker <N> on existing entry replaces line N", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/ed"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await k.edit(editStatement({ target: urlPath("worker", "/ed"), body: "BETA", lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        const read = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/ed") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("Worker.edit: lineMarker <0> on existing entry prepends", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/p"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target: urlPath("worker", "/p"), body: "zero", lineMarker: { marks: [0] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        const read = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/p") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "zero\none\ntwo");
    } finally { await db.close(); }
});

test("Worker.edit: lineMarker <-1> on existing entry appends", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/a"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target: urlPath("worker", "/a"), body: "three", lineMarker: { marks: [-1] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        const read = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/a") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "one\ntwo\nthree");
    } finally { await db.close(); }
});

test("Worker.edit: lineMarker <1,-1> empty body clears", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/c"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, workerId }));
        await k.edit(editStatement({ target: urlPath("worker", "/c"), body: "", lineMarker: { marks: [1, -1] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        const read = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/c") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal((read as { content: string }).content, "");
    } finally { await db.close(); }
});

test("Worker.edit: lineMarker out of range returns 416", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/r"), body: "only line" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await k.edit(editStatement({ target: urlPath("worker", "/r"), body: "x", lineMarker: { marks: [99] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("Worker.edit: null path returns 400", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const stmt = editStatement({ target: null, body: "x" });
        const result = await new Worker().edit(stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 400);
        assert.equal(result.entryId, null);
    } finally { await db.close(); }
});



test("Worker.edit: exact coordinates edit minified JSON as text", async () => {
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
        const read = await lookThroughScheme("worker", null,
            readStatement({ target: urlPath("worker", "/users.json") }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.deepEqual(JSON.parse(read.content ?? ""), [
            { name: "Alice" },
            { name: "Beth" },
            { name: "Carol" },
        ]);
    } finally { await db.close(); }
});

test("Worker.edit: line shorthand edits JSON physical lines and can replace the whole resource", async () => {
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
        const read1 = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/users.json") }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        assert.deepEqual(JSON.parse(read1.content ?? ""), [
            { name: "Alice" },
            { name: "Beth" },
            { name: "Carol" },
        ]);

        await k.edit(
            editStatement({ target: urlPath("worker", "/users.json"), body: "[]", lineMarker: { marks: [1, -1] } }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const read2 = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/users.json") }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        assert.deepEqual(JSON.parse(read2.content ?? ""), []);
    } finally { await db.close(); }
});

test("Worker.edit: line shorthand has the same meaning without a path suffix", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        // No delimiter → text/markdown → line EDIT.
        await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "BETA", lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        const noSuffixRead = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/notes") }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        assert.equal(noSuffixRead.content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("Worker.edit: textual JSON edits do not introduce a hidden parse gate", async () => {
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
        const read = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/users.json") }), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        assert.equal(read.content, '[1,2,3]\n{not valid json');
    } finally { await db.close(); }
});

test("Worker.edit result carries a bounded effect receipt with revision identity", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const k = new Worker();
        // New entry: the receipt states the resulting revision and bounded join context.
        const r1 = await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "alpha\nbeta\ngamma" }), ctx);
        assert.equal(r1.status, 201);
        assert.match(r1.editReceipt?.revision ?? "", /^[a-f0-9]{64}$/);
        assert.deepEqual({ unit: r1.editReceipt?.unit, before: r1.editReceipt?.before, after: r1.editReceipt?.after }, { unit: "lines", before: 0, after: 3 });
        assert.ok(r1.editReceipt !== null && r1.editReceipt !== undefined && "effects" in r1.editReceipt);
        assert.match(r1.editReceipt.effects[0]?.context ?? "", /1:alpha\n2:beta\n3:gamma/);
        const r2 = await k.edit(editStatement({ target: urlPath("worker", "/notes"), body: "alpha\nBETA\ngamma", lineMarker: fullReplace }), ctx);
        assert.equal(r2.status, 200);
        assert.ok(r2.editReceipt !== null && r2.editReceipt !== undefined && "effects" in r2.editReceipt);
        assert.deepEqual(
            r2.editReceipt.effects.map(({ requested, source, result, removed, inserted }) => ({ requested, source, result, removed, inserted })),
            [{ requested: "<1,-1>", source: "1-3", result: "1-3", removed: 3, inserted: 3 }],
        );
        assert.match(r2.editReceipt.effects[0]?.context ?? "", /1:alpha\n2:BETA\n3:gamma/);
    } finally { await db.close(); }
});
