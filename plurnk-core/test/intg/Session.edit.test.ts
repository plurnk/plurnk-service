import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import { type LineMarker, type ParsedPath, type ReadStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx, seedStaticChannel } from "./_scheme.ts";
import { urlPath, fullReplace } from "./_dsl.ts";
import { serverProposals } from "./_approval.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { packetSection } from "./_packet.ts";


describe("Session.edit", () => {
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

test("{§execution-output-identity} Session.edit: new entry — inserts entries row and body channel", async () => {
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
        assert.ok((entry?.workspace_id ?? 0) >= 1, "owner stamped ({§execution-output-identity})");
        assert.equal(entry?.workspace_id, workspaceId);
        assert.equal(entry?.scheme, "workspace");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const channel = await db.test_get_channel.get<{ content: string; mimetype: string; state: string }>({ entry_id: result.entryId, name: "body" });
        assert.equal(channel?.content, "Paris");
        assert.equal(channel?.mimetype, "text/markdown");
        assert.equal(channel?.state, "static");
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert}: EDIT preserves an existing channel's explicitly declared type", async () => {
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

test("{§operation-results} Session.edit: a concurrent creator wins cleanly and the losing EDIT reports a collision", async () => {
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
        assert.equal(result.problem?.detail, "EDIT collided with the current resource state."); // {§operation-results}
        assert.equal(result.problem?.target, "workspace:///create-race.md");
        const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/create-race.md",
            scheme: "workspace",
            name: "body",
        });
        assert.equal(channel?.content, "other session");
    } finally { await db.close(); }
});

test("{§edit} Session.edit: second EDIT against same path — same entry id, body replaced, status 200", async () => {
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

test("{§operation-results} Session.edit: a representation change at atomic landing returns edit-collision without clobbering it", async () => {
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
        assert.equal(result.problem?.detail, "EDIT collided with the current resource state."); // {§operation-results}
        assert.equal(result.problem?.target, "workspace:///cas.md");
        const channel = await db.test_get_channel.get<{ content: string }>({
            entry_id: created.entryId,
            name: "body",
        });
        assert.equal(channel?.content, "other session");
    } finally { await db.close(); }
});

test("{§edit} EDIT that changes nothing returns 304; only a content change updates the entry", async () => {
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

test("{§edit} Session.edit: empty body clears the channel content (does not delete the entry)", async () => {
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

test("{§zero-width-column-one-insert} Session.edit: lineMarker on non-existent entry — body becomes content", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const stmt = editStatement({ target: urlPath("workspace", "/new"), body: "first line\nsecond line", lineMarker: { marks: [0] } });
        const result = await new Workspace().edit(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 201);
        const read = await readThroughScheme("workspace", null, { ...stmt, op: "READ", lineMarker: null, matcher: null, body: null } as never, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "first line\nsecond line");
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} Session.edit: lineMarker <N> on existing entry replaces line N", async () => {
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

test("{§zero-width-column-one-insert} Session.edit: lineMarker <0> on existing entry prepends", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/p"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStatement({ target: urlPath("workspace", "/p"), body: "zero", lineMarker: { marks: [0] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/p") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "zero\none\ntwo");
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} Session.edit: lineMarker <-1> on existing entry appends", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/a"), body: "one\ntwo" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStatement({ target: urlPath("workspace", "/a"), body: "three", lineMarker: { marks: [-1] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/a") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "one\ntwo\nthree");
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} Session.edit: lineMarker <1,-1> empty body clears", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/c"), body: "alpha\nbeta\ngamma" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        await k.edit(editStatement({ target: urlPath("workspace", "/c"), body: "", lineMarker: { marks: [1, -1] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const read = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/c") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal((read as { content: string }).content, "");
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} Session.edit: lineMarker out of range returns 416", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/r"), body: "only line" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await k.edit(editStatement({ target: urlPath("workspace", "/r"), body: "x", lineMarker: { marks: [99] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("{§operation-results} Session.edit: null path returns 400", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const stmt = editStatement({ target: null, body: "x" });
        const result = await new Workspace().edit(stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 400);
        assert.equal(result.entryId, null);
    } finally { await db.close(); }
});



test("{§zero-width-column-one-insert} Session.edit: exact coordinates edit minified JSON as text", async () => {
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

test("{§zero-width-column-one-insert} Session.edit: line shorthand edits JSON physical lines and can replace the whole resource", async () => {
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

test("{§zero-width-column-one-insert} Session.edit: line shorthand has the same meaning without a path suffix", async () => {
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

test("{§zero-width-column-one-insert} Session.edit: textual JSON edits do not introduce a hidden parse gate", async () => {
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

test("{§edit-result-receipt-projection} Session.edit result carries a bounded effect receipt with revision identity", async () => {
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
});

describe("Engine.anchors-follow-shift", () => {
// {§line-anchors} {§line-anchors} {§op-methods-op-dispatch}











const execFileP = promisify(execFile);
const V1 = "one\ntwo\nthree\nfour\nfive\nsix\n";
const prefix = Array.from({ length: 10 }, (_, index) => `prefix-${index}\n`).join("");
const suffix = Array.from({ length: 10 }, (_, index) => `suffix-${index}\n`).join("");

for (const fixture of [
    { name: "unique", source: V1, first: 3, expected: "one\ntwo\nTHREE-FOUR\nFIVE\nsix\n" },
    { name: "repeated", source: `${prefix}${V1}${V1}${suffix}`, first: 13, expected: `${prefix}one\ntwo\nTHREE-FOUR\nFIVE\nsix\n${V1}${suffix}` },
]) test(`{§line-anchors}: ${fixture.name} file anchors survive a shift between loops and successive same-program edits`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-shift-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), fixture.source);
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        const pending: { batch: string | null } = { batch: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (doc.md) <1,-1>````\n````NOTE\nreading\n````", 50),
            makeMockResponse("````SEND [200]\nread\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`${pending.batch}

\`\`\`\`NOTE
editing
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````SEND [200]\nedited\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "anchors-shift", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: first.modelSessionId! }))
                    .find(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                const anchors = JSON.parse(readRow?.rx ?? "{}").lineAnchors as string[] | undefined;
                assert.ok(Array.isArray(anchors) && anchors.length === fixture.source.split("\n").length - 1, `the READ published one anchor per line; got ${JSON.stringify(anchors)}`);
                if (fixture.name === "repeated") assert.notEqual(anchors[fixture.first - 1], anchors[fixture.first + 5], "the two copies have distinct handles");
                await writeFile(join(root, "doc.md"), `zero-a\nzero-b\n${fixture.source}`);
                pending.batch = [
                    `\`\`\`\`EDIT (doc.md) <${anchors[fixture.first - 1]},${anchors[fixture.first]}>
THREE-FOUR
\`\`\`\``,
                    `\`\`\`\`EDIT (doc.md) <${anchors[fixture.first + 1]}>
FIVE
\`\`\`\``,
                ].join("\n\n");
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit" });
                assert.equal(second.result.status, 200);
                const edits = (await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: second.modelSessionId! }))
                    .filter(({ op }) => op === "EDIT");
                assert.deepEqual(edits.map(({ status_rx }) => status_rx), [200, 200], `both anchored edits applied; got ${edits.map(({ rx }) => rx).join(" | ")}`);
                assert.equal(await readFile(join(root, "doc.md"), "utf8"), `zero-a\nzero-b\n${fixture.expected}`, "the edits landed on the selected moved lines, leaving any twin intact");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});


describe("Engine.edit-batch-receipts", () => {
// {§op-methods-op-dispatch} {§edit}













const execFileP = promisify(execFile);
const V1 = "one\ntwo\nthree\nfour\nfive\nsix\n";
const BLOCK = "function f() {\n    return null;\n}\n\n";
const REPEATED = `${BLOCK}${BLOCK}${BLOCK}tail`;

type UnresolvedAnchor = { anchor: string; kind: "missing" | "ambiguous"; lines?: number[] };
const cases: readonly {
    name: string;
    source: string;
    current: string;
    hashCollision?: boolean;
    scopes: (anchors: string[]) => string[][];
    unresolved: (anchors: string[]) => UnresolvedAnchor[];
}[] = [
    {
        name: "a never-issued anchor has no match, not an invented history",
        source: V1,
        current: V1,
        scopes: () => [["@451ok"]],
        unresolved: () => [{ anchor: "@451ok", kind: "missing" }],
    },
    {
        name: "an actually stale anchor reports the same current absence",
        source: V1,
        current: V1.replace("six\n", "SIX\n"),
        scopes: (anchors) => [[anchors[4]]],
        unresolved: (anchors) => [{ anchor: anchors[4], kind: "missing" }],
    },
    {
        name: "a residual short-hash collision names its current matching lines",
        source: REPEATED,
        current: REPEATED,
        hashCollision: true,
        scopes: (anchors) => [[anchors[5]]],
        unresolved: (anchors) => [{ anchor: anchors[5], kind: "ambiguous", lines: [6, 10] }],
    },
    {
        name: "independent failures name their own range endpoints and anchors",
        source: REPEATED,
        current: REPEATED.replace("tail", "TAIL"),
        hashCollision: true,
        scopes: (anchors) => [["@451ok", anchors[5]], [anchors[12]]],
        unresolved: (anchors) => [
            { anchor: "@451ok", kind: "missing" },
            { anchor: anchors[5], kind: "ambiguous", lines: [6, 10] },
            { anchor: anchors[12], kind: "missing" },
        ],
    },
];

for (const fixture of cases) test(`{§op-methods-op-dispatch} ${fixture.name}`, async (t) => {
    serverProposals(t, "accept");
    if (fixture.hashCollision) {
        // {§line-anchors}: ordinary repetitions resolve;
        // force a residual truncated-hash collision at the derivation boundary.
        const tokens = LineAnchors.tokens.bind(LineAnchors);
        t.mock.method(LineAnchors, "tokens", (identity: string, content: string) => {
            const anchors = tokens(identity, content);
            return identity === "doc.md" ? anchors.with(9, anchors[5]) : anchors;
        });
    }
    const root = await mkdtemp(join(tmpdir(), "plurnk-batch-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), fixture.source);
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        // The batch is composed from the anchors the engine itself rendered in loop 1; the
        // mock's third response is filled in once those anchors are known.
        const pending: { batch: string | null } = { batch: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (doc.md) <1,-1>````\n````NOTE\nreading\n````", 50),
            makeMockResponse("````SEND [200]\nread\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`${pending.batch}

\`\`\`\`NOTE
editing
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````SEND [200]\nedited\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "batch-receipt", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: first.modelSessionId! }))
                    .find(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                const anchors = JSON.parse(readRow?.rx ?? "{}").lineAnchors as string[] | undefined;
                assert.ok(Array.isArray(anchors) && anchors.length >= 6, `the READ published its anchors; got ${JSON.stringify(anchors)}`);
                if (fixture.hashCollision) assert.equal(anchors[5], anchors[9], "the fixture injected an actual derivation collision");
                assert.equal(anchors.includes("@451ok"), false, "the unknown anchor was never published");
                await writeFile(join(root, "doc.md"), fixture.current);
                const unresolved = fixture.unresolved(anchors);
                const statements = [
                    `\`\`\`\`EDIT (doc.md) <${anchors[0]}>
ONE
\`\`\`\``,
                    `\`\`\`\`EDIT (doc.md) <${anchors[1]}>
TWO
\`\`\`\``,
                    "````EDIT (doc.md) <3>\nTHREE\n````",
                    ...fixture.scopes(anchors).map((marks) => `\`\`\`\`EDIT (doc.md) <${marks.join(",")}>
replacement
\`\`\`\``),
                ];
                pending.batch = statements.join("\n\n");
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit" });
                assert.equal(second.result.status, 200, "the model concludes after observing the individual failures");
                const rows = await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: second.modelSessionId! });
                const edits = rows.filter(({ op }) => op === "EDIT");
                assert.equal(edits.length, statements.length);
                assert.deepEqual(edits.slice(0, 3).map(({ status_rx }) => status_rx), [200, 200, 200], "valid earlier operations land independently");
                for (const [index, row] of edits.slice(3).entries()) {
                    const ownUnresolved: UnresolvedAnchor[] = unresolved.filter(({ anchor }) => fixture.scopes(anchors)[index].includes(anchor));
                    const problem = JSON.parse(row.rx).problem;
                    assert.equal(row.status_rx, 409);
                    assert.equal(problem.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
                    assert.equal(problem.detail, "EDIT collided with the current resource state."); // {§operation-results}
                    assert.deepEqual(problem.unresolvedAnchors, ownUnresolved, "each row diagnoses all of its own unresolved anchors");
                    assert.equal(problem.editCount, 1);
                    assert.equal(problem.applied, 0);
                    assert.equal(problem.recovery, "0 of 1 edits applied. READ the target for current coordinates."); // {§operation-results}
                    assert.equal(problem.retryable, false);
                }
                const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnIds!.at(-1)! }))!.packet);
                const log = packetSection(packet, "log");
                assert.ok(log.length > 0, "the next model packet contains the refused EDIT receipts");
                for (const anchor of unresolved) assert.ok(log.includes(JSON.stringify(anchor)), "the current-state diagnosis reaches the model");
                assert.ok(log.includes("0 of 1 edits applied."), "the packet reports only this operation's lack of effect");
                assert.equal(await readFile(join(root, "doc.md"), "utf8"), ["ONE", "TWO", "THREE", ...fixture.current.split("\n").slice(3)].join("\n"), "only the valid EDITs landed");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("Engine.edit-receipt-anchors", () => {
// {§edit-result-receipt-projection} — an applied EDIT's row shows the landed neighbourhood with
// anchors, and those anchors resolve in the next batch without a READ in between.












const execFileP = promisify(execFile);
const SOURCE = "var x int\n\nfunc requireFn(a int) int {\n\treturn a\n}\n\nfunc other() {}\n";

test("{§edit-result-receipt-projection} the EDIT row renders the landed lines with anchors that the next EDIT can cite without a READ", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-recanchor-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "f.go"), SOURCE);
        await execFileP("git", ["add", "f.go"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        const pending: { anchor: string | null } = { anchor: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <1>\nvar x int64\n````\n\n````NOTE\nfirst\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`\`\`\`\`EDIT (f.go) <${pending.anchor}>
func requireFn(a int) int { // anchored
\`\`\`\`

\`\`\`\`NOTE
second
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "recanchor", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(first.result.status, 200);
                const editRow = (await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ session_id: first.modelSessionId! }))
                    .find(({ op, status_rx }) => op === "EDIT" && status_rx === 200);
                const context = JSON.parse(editRow!.rx).receipt.effect.context as string;
                const lines = context.split("\n");
                assert.ok(lines.length >= 3, `bounded context around the landed line; got ${JSON.stringify(context)}`);
                for (const line of lines) assert.match(line, /^ *[1-9]\d*<@[0-9A-Za-z]{5}>/, `every context line is anchored: ${JSON.stringify(line)}`);
                // The packet the model saw carries the same anchored body.
                const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: first.turnIds![2] }))!.packet);
                const log = packetSection(packet, "log");
                assert.match(log, /3<@[0-9A-Za-z]{5}>func requireFn\(a int\) int \{/, "the model sees line 3 with its anchor on the EDIT row");
                const line3 = lines.find((line) => /^ *3<@[0-9A-Za-z]{5}>func requireFn/.test(line))!;
                pending.anchor = /<(@[0-9A-Za-z]{5})>/.exec(line3)![1]!;
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit again" });
                assert.equal(second.result.status, 200);
                // The session persists across loops: the first loop's one EDIT row precedes this loop's.
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ session_id: second.modelSessionId! });
                const edits = rows.filter(({ op }) => op === "EDIT").slice(1);
                assert.deepEqual(edits.map(({ status_rx }) => status_rx), [200], JSON.stringify(edits.map(({ rx }) => JSON.parse(rx).problem ?? null)));
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int64\n\nfunc requireFn(a int) int { // anchored\n\treturn a\n}\n\nfunc other() {}\n", "the anchor cited from the EDIT receipt resolved to line 3 with no READ in between");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

