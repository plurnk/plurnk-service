import test from "node:test";
import assert from "node:assert/strict";
import type { LineMarker, ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Workspace from "../../src/schemes/Workspace.ts";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx, seedStaticChannel } from "./_scheme.ts";
import { urlPath, fullReplace } from "./_dsl.ts";

const editStatement = (opts: {
    target?: ParsedPath | null; body?: string | null;
    lineMarker?: LineMarker | null;
}): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT",
    aside: null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    matcher: null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: { target?: ParsedPath | null }): ReadStatement => ({
    metadata: null,
    op: "READ",
    aside: null,
    target: opts.target ?? null,
    lineMarker: null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const setupContext = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

test("{§entry-owner} Session.edit: new entry — inserts entries row and body channel", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const stmt = editStatement({
            target: urlPath("workspace", "/countries/france/capital"),
            body: "Paris",
        });
        const result = await new Workspace().edit(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const entry = await db.test_get_entry_by_id.get<{
            workspace_id: number;
            scheme: string;
            pathname: string;
        }>({ id: result.entryId });
        assert.ok((entry?.workspace_id ?? 0) >= 1, "owner stamped ({§entry-owner})");
        assert.equal(entry?.workspace_id, workspaceId);
        assert.equal(entry?.scheme, "workspace");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const channel = await db.test_get_channel.get<{ content: string; mimetype: string; state: string }>({ entry_id: result.entryId, name: "body" });
        assert.equal(channel?.content, "Paris");
        assert.equal(channel?.mimetype, "text/markdown");
        assert.equal(channel?.state, "static");
    } finally { await db.close(); }
});

test("{§ext-mimetype-extension-mimetype}: EDIT preserves an existing channel's explicitly declared type", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const entryId = await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.txt", content: "before", mimetype: "text/plain" });
        const result = await new Workspace().edit(
            editStatement({ target: urlPath("workspace", "/notes.txt"), body: "after", lineMarker: fullReplace }),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        assert.equal(result.status, 200);
        const channel = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entryId, name: "body" });
        assert.equal(channel?.content, "after");
        assert.equal(channel?.mimetype, "text/plain");
    } finally { await db.close(); }
});

test("{§problems-dispatch} Session.edit: a concurrent creator wins cleanly and the losing EDIT reports a collision", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const claim = new Proxy(db.ops_insert_workspace_entry_if_absent, {
            get(statement, property) {
                if (property !== "get") return Reflect.get(statement, property, statement) as unknown;
                return async <R = Record<string, unknown>>(params?: Record<string, unknown>): Promise<R | undefined> => {
                    const winner = await db.ops_insert_workspace_entry_if_absent.get<{ id: number }>(params);
                    await seedStaticChannel(db, winner?.id, {
                        name: "body",
                        content: "other session",
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
        const result = await new Workspace().edit(
            editStatement({ target: urlPath("workspace", "/create-race.md"), body: "authored edit" }),
            makeSchemeCtx({ db: collisionDb, workspaceId, sessionId }),
        );
        assert.equal(result.status, 409);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(result.problem?.detail, "EDIT collided with the current resource state."); // {§problems-dispatch}
        assert.equal(result.problem?.target, "workspace:///create-race.md");
        const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/create-race.md",
            scheme: "workspace",
            name: "body",
        });
        assert.equal(channel?.content, "other session");
    } finally { await db.close(); }
});

test("{§edit-status-201-200} Session.edit: second EDIT against same path — same entry id, body replaced, status 200", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        const first = await k.edit(editStatement({ target: urlPath("workspace", "/x"), body: "initial" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(first.status, 201);
        const second = await k.edit(editStatement({ target: urlPath("workspace", "/x"), body: "updated", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(second.status, 200);
        assert.equal(second.entryId, first.entryId, "entry id is stable across edits");
        const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: first.entryId, name: "body" });
        assert.equal(channel?.content, "updated");
    } finally { await db.close(); }
});

test("{§problems-dispatch} Session.edit: a representation change at atomic landing returns edit-collision without clobbering it", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const session = new Workspace();
        const target = urlPath("workspace", "/cas.md");
        const created = await session.edit(
            editStatement({ target, body: "original" }),
            makeSchemeCtx({ db, workspaceId, sessionId }),
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
                        content: "other session",
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
        const result = await session.edit(
            editStatement({ target, body: "authored edit", lineMarker: fullReplace }),
            makeSchemeCtx({ db: collisionDb, workspaceId, sessionId }),
        );
        assert.equal(result.status, 409);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(result.problem?.detail, "EDIT collided with the current resource state."); // {§problems-dispatch}
        assert.equal(result.problem?.target, "workspace:///cas.md");
        const channel = await db.test_get_channel.get<{ content: string }>({
            entry_id: created.entryId,
            name: "body",
        });
        assert.equal(channel?.content, "other session");
    } finally { await db.close(); }
});

test("{§edit-noop-304} EDIT that changes nothing returns 304; only a content change updates the entry", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        const target = urlPath("workspace", "/noop");
        const first = await k.edit(editStatement({ target, body: "same" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(first.status, 201);
        const reWrite = await k.edit(editStatement({ target, body: "same", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(reWrite.status, 304, "identical content → no-op");
        assert.equal(
            reWrite.detail,
            "No change: EDIT body matches the selected content.",
        );
        assert.equal(reWrite.entryId, first.entryId, "entry id still returned on 304");
        const changed = await k.edit(editStatement({ target, body: "different", lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(changed.status, 200, "content change is a real update");
    } finally { await db.close(); }
});

test("{§edit-null-clears} Session.edit: empty body clears the channel content (does not delete the entry)", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        const r1 = await k.edit(editStatement({ target: urlPath("workspace", "/y"), body: "initial body" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStatement({ target: urlPath("workspace", "/y"), body: null, lineMarker: fullReplace }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: r1.entryId, name: "body" });
        assert.equal(channel?.content, "");
        const entryStillThere = await db.test_get_entry_by_id.get<{ pathname: string }>({ id: r1.entryId });
        assert.ok(entryStillThere !== undefined);
    } finally { await db.close(); }
});

test("{§text-scope-runtime} Session.edit: lineMarker on non-existent entry — body becomes content", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const stmt = editStatement({ target: urlPath("workspace", "/new"), body: "first line\nsecond line", lineMarker: { marks: [0] } });
        const result = await new Workspace().edit(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 201);
        const read = await readThroughScheme("workspace", null, { ...stmt, op: "READ", lineMarker: null, matcher: null, body: null } as never, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "first line\nsecond line");
    } finally { await db.close(); }
});

test("{§text-scope-runtime} Session.edit: lineMarker <N> on existing entry replaces line N", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/ed"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await k.edit(editStatement({ target: urlPath("workspace", "/ed"), body: "BETA", lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/ed") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("{§text-scope-runtime} Session.edit: lineMarker <0> on existing entry prepends", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/p"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStatement({ target: urlPath("workspace", "/p"), body: "zero", lineMarker: { marks: [0] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/p") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "zero\none\ntwo");
    } finally { await db.close(); }
});

test("{§text-scope-runtime} Session.edit: lineMarker <-1> on existing entry appends", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/a"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStatement({ target: urlPath("workspace", "/a"), body: "three", lineMarker: { marks: [-1] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/a") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "one\ntwo\nthree");
    } finally { await db.close(); }
});

test("{§text-scope-runtime} Session.edit: lineMarker <1,-1> empty body clears", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/c"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStatement({ target: urlPath("workspace", "/c"), body: "", lineMarker: { marks: [1, -1] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/c") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "");
    } finally { await db.close(); }
});

test("{§text-scope-runtime} Session.edit: lineMarker out of range returns 416", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/r"), body: "only line" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await k.edit(editStatement({ target: urlPath("workspace", "/r"), body: "x", lineMarker: { marks: [99] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("{§problems-dispatch} Session.edit: null path returns 400", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const stmt = editStatement({ target: null, body: "x" });
        const result = await new Workspace().edit(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 400);
        assert.equal(result.entryId, null);
    } finally { await db.close(); }
});



test("{§text-scope-runtime} Session.edit: exact coordinates edit minified JSON as text", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({
                target: urlPath("workspace", "/users.json"),
                body: '[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]',
            }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        const r = await k.edit(
            editStatement({
                target: urlPath("workspace", "/users.json"),
                body: "Beth",
                lineMarker: { marks: [1, 28, 1, 31] },
            }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(r.status, 200);
        const read = await readThroughScheme("workspace", null,
            readStatement({ target: urlPath("workspace", "/users.json") }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.deepEqual(JSON.parse(read.content ?? ""), [
            { name: "Alice" },
            { name: "Beth" },
            { name: "Carol" },
        ]);
    } finally { await db.close(); }
});

test("{§ext-mimetype-extension-mimetype} Session.edit: line shorthand edits JSON physical lines and can replace the whole resource", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({
                target: urlPath("workspace", "/users.json"),
                body: '[\n  {"name":"Alice"},\n  {"name":"Bob"},\n  {"name":"Carol"}\n]',
            }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        await k.edit(
            editStatement({
                target: urlPath("workspace", "/users.json"),
                body: '  {"name":"Beth"},',
                lineMarker: { marks: [3] },
            }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        const read1 = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/users.json") }), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        assert.deepEqual(JSON.parse(read1.content ?? ""), [
            { name: "Alice" },
            { name: "Beth" },
            { name: "Carol" },
        ]);

        await k.edit(
            editStatement({ target: urlPath("workspace", "/users.json"), body: "[]", lineMarker: { marks: [1, -1] } }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        const read2 = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/users.json") }), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        assert.deepEqual(JSON.parse(read2.content ?? ""), []);
    } finally { await db.close(); }
});

test("{§ext-mimetype-extension-mimetype} Session.edit: line shorthand has the same meaning without a path suffix", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        // No delimiter → text/markdown → line EDIT.
        await k.edit(editStatement({ target: urlPath("workspace", "/notes"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        await k.edit(editStatement({ target: urlPath("workspace", "/notes"), body: "BETA", lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        const noSuffixRead = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/notes") }), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        assert.equal(noSuffixRead.content, "alpha\nBETA\ngamma");
    } finally { await db.close(); }
});

test("{§ext-mimetype-extension-mimetype} Session.edit: textual JSON edits do not introduce a hidden parse gate", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/users.json"), body: '[1,2,3]' }), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        const r = await k.edit(
            editStatement({ target: urlPath("workspace", "/users.json"), body: "{not valid json", lineMarker: { marks: [-1] } }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(r.status, 200);
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/users.json") }), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));
        assert.equal(read.content, '[1,2,3]\n{not valid json');
    } finally { await db.close(); }
});

test("{§edit-result-receipt-truth} Session.edit result carries a bounded effect receipt with revision identity", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const k = new Workspace();
        // New entry: the receipt states the resulting revision and bounded join context.
        const r1 = await k.edit(editStatement({ target: urlPath("workspace", "/notes"), body: "alpha\nbeta\ngamma" }), ctx);
        assert.equal(r1.status, 201);
        assert.match(r1.editReceipt?.revision ?? "", /^[a-f0-9]{64}$/);
        assert.deepEqual({ unit: r1.editReceipt?.unit, before: r1.editReceipt?.before, after: r1.editReceipt?.after }, { unit: "lines", before: 0, after: 3 });
        assert.ok(r1.editReceipt !== null && r1.editReceipt !== undefined && "effects" in r1.editReceipt);
        assert.match(r1.editReceipt.effects[0]?.context ?? "", /1<@[0-9A-Za-z]{5}>alpha\n2<@[0-9A-Za-z]{5}>beta\n3<@[0-9A-Za-z]{5}>gamma/);
        const r2 = await k.edit(editStatement({ target: urlPath("workspace", "/notes"), body: "alpha\nBETA\ngamma", lineMarker: fullReplace }), ctx);
        assert.equal(r2.status, 200);
        assert.ok(r2.editReceipt !== null && r2.editReceipt !== undefined && "effects" in r2.editReceipt);
        assert.deepEqual(
            r2.editReceipt.effects.map(({ requested, source, result, removed, inserted }) => ({ requested, source, result, removed, inserted })),
            [{ requested: "<1,-1>", source: "<1,3>", result: "<1,3>", removed: 3, inserted: 3 }],
        );
        assert.match(r2.editReceipt.effects[0]?.context ?? "", /1<@[0-9A-Za-z]{5}>alpha\n2<@[0-9A-Za-z]{5}>BETA\n3<@[0-9A-Za-z]{5}>gamma/);
    } finally { await db.close(); }
});
