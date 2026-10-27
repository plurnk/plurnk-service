import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryScheme from "./_entry-scheme.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import File from "../../src/schemes/File.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { type LineMarker, type ParsedPath, type ReadStatement, type TextLineMarker, type EditStatement, type KillStatement, type NoteStatement, type MatcherBody, type UrlPath, type PlurnkStatement, type FindStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, type SchemeCtx, InvalidOperationResultError } from "@plurnk/plurnk-schemes";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel, insertOperationTurn, seedEnvelope, insertLoop, insertTurn } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx, seedStaticChannel, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { urlPath, fullReplace, sendStmt, copyStmt, moveStmt, localPath, editStmt } from "./_dsl.ts";
import { serverProposals, ownSession } from "./_approval.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications, waitFor } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors } from "./_mock.ts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { packetSection } from "./_packet.ts";
import { createHash } from "node:crypto";
import { type Db } from "../../src/core/Db.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { clientRead } from "./_client-read.ts";
import { resourceGroups, resourcePaths } from "./_find.ts";

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

describe("Engine.dispatch", () => {
const dispatchEditStmt = (opts: { target: ParsedPath; body?: string | null; marker?: TextLineMarker | null; aside?: string | null }): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: opts.aside ?? null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    matcher: null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStmt = (opts: { target: ParsedPath; marker?: ReadStatement["lineMarker"] }): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const killStmt = (opts: { target: ParsedPath; marker?: TextLineMarker | null; matcher?: MatcherBody | null }): KillStatement => ({
    metadata: null,
    op: "KILL", aside: null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    matcher: opts.matcher ?? null, body: null,
    position: { line: 1, column: 1 },
});

const continuationStmt = (opts: { body?: string | null }): NoteStatement => ({
    metadata: null,
    op: "NOTE", aside: null,
    target: null,
    lineMarker: null,
    body: opts.body ?? "Continue the task.",
    position: { line: 1, column: 1 },
});

test("{§op-invariants} Engine.dispatch: KILL against workspace:/// permanently deletes the entry (200, then READ 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/obsolete/note"), body: "stale" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("workspace", "/obsolete/note") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200);
        const read = await engine.dispatch({
            statement: readStmt({ target: urlPath("workspace", "/obsolete/note") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(read.status, 404);
    } finally { await db.close(); }
});

test("{§scheme-address} namespace fixture://x and fixture:///x address the same entry", async () => {
    const { db, engine, env } = await setup();
    try {
        // create via the path form: fixture:///config.json => /config.json
        const created = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("fixture", "/config.json"), body: "host=db.internal" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        // Namespace authority is folded into its path, unlike a resource authority.
        const authForm: UrlPath = { kind: "url", raw: "fixture://config.json", scheme: "fixture", username: null, password: null, hostname: "config.json", port: null, pathname: "", query: null, fragment: null };
        const read = await engine.dispatch({
            statement: readStmt({ target: authForm }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} Engine.dispatch: the KILL matcher survives into the log row's tx (even on a 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: killStmt({ target: urlPath("workspace", "/gone"), matcher: { dialect: "glob", raw: "superseded — see /final" } }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("KILL log_entry not found");
        assert.equal(log.op, "KILL");
        const tx = JSON.parse(log.tx) as { matcher: MatcherBody | null; body: null };
        assert.deepEqual(tx.matcher, { dialect: "glob", raw: "superseded — see /final" });
        assert.equal(tx.body, null);
    } finally { await db.close(); }
});

test("{§operation-aside}: the descriptive aside survives durable dispatch unchanged", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({
                target: urlPath("workspace", "/annotated"),
                body: "content",
                aside: "Create the shared note",
            }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("EDIT with an aside: log_entry not found");
        const tx = JSON.parse(log.tx) as { aside: unknown };
        assert.equal(tx.aside, "Create the shared note");
    } finally { await db.close(); }
});

test("{§log-history-projection} Engine.dispatch: KILL against a non-running exec:/// returns 404 (nothing to kill)", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("exec", "/sh/1/1/2") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 404);
    } finally { await db.close(); }
});

// {§log-history-projection}
test("{§log-history-projection} Engine.dispatch preserves log KILL's missing-coordinate failure", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/0") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "_plurnk",
        });
        assert.equal(kill.status, 404, "a missing log coordinate remains not found");
    } finally { await db.close(); }
});

test("{§log-history-projection} model-origin log KILL atomically retires its target and preserves exact history", async () => {
    const { db, engine, env } = await setup();
    try {
        // A real model-origin row at coordinate /1/1/1 (loop seq 1, turn seq 1, sequence 1).
        const plan = await engine.dispatch({
            statement: continuationStmt({ body: "obsolete goals to curate away" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200, "the model is authorized to retire its log item");
        assert.deepEqual(
            await db.test_get_log_projection.get({ session_id: env.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 }),
            { id: 1, active: 0, folded: "[]" },
            "KILL changes projection state rather than deleting the event",
        );
        assert.deepEqual(
            await db.test_log_curation_effects_by_session.all({ session_id: env.sessionId }),
            [{
                operation_log_entry_id: 2,
                target_log_entry_id: 1,
                active_before: 1,
                active_after: 0,
                folded_before: "[]",
                folded_after: "[]",
                op: "KILL",
                turn_id: env.turnId,
                operation_sequence: 2,
                target_sequence: 1,
            }],
            "the KILL row and exact target transition land as one durable curation event",
        );
        assert.equal(
            await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: env.turnId }).then((row) => row?.n),
            2,
            "both the target event and KILL event remain in chronological history",
        );
        const gone = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(gone.status, 404, "a killed exact coordinate is absent from the active address space");
    } finally { await db.close(); }
});

test("{§note-value} a NOTE retains its literal text and does not claim a lifecycle outcome", async () => {
    const { db, engine, env } = await setup();
    try {
        const plan = await engine.dispatch({
            statement: continuationStmt({ body: "The capital of France remains unverified." }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("NOTE log_entry not found");
        assert.equal(log.op, "NOTE");
        const tx = JSON.parse(log.tx) as { body: unknown };
        assert.equal(tx.body, "The capital of France remains unverified.");
    } finally { await db.close(); }
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    schemes.register("fixture", new EntryScheme());
    const engine = new Engine({ db, schemes });
    return { db, engine, env };
};

for (const op of ["READ", "FIND"] as const) {
    test(`{§problem-details}: ${op} without a path identifies the missing target, not a missing scheme`, async () => {
        const { db, engine, env } = await setup();
        try {
            const parsed = PlurnkParser.parse(`\`\`\`\`${op}\n*\n\`\`\`\``);
            const item = parsed.items.find((candidate) => candidate.kind === "statement" && candidate.statement.op === op);
            assert.ok(item?.kind === "statement");
            assert.ok(item.statement.op === "READ" || item.statement.op === "FIND");
            const result = await engine.dispatch({ statement: item.statement, ...env, sequence: 1, origin: "model" });
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/target-required");
            assert.equal(result.problem?.detail, `${op} requires a target path.`);
            const local = await engine.dispatch({ statement: { ...item.statement, target: { kind: "local", raw: "example.txt" } }, ...env, sequence: 2, origin: "model" });
            assert.equal(local.status, 404, "the bare path reaches file resolution rather than missing-target refusal");
            assert.equal(local.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        } finally { await db.close(); }
    });
}

test("{§completion-defers-to-results}: retiring a failed receipt does not make it observed", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.injectIntoLoop(env.loopId, "Report the result.", [], undefined, {}, "message://request/result");
        await engine.runTurn({ ...env, messages: [], provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: {
            content: "```NOTE\nInspect the result.\n```", reasoning: null,
        } }] }) });
        const { id: turnId } = await Turn.open(db, { loopId: env.loopId, producer: "model", kind: "inference" });
        const coordinates = await db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({ loop_id: env.loopId, turn_id: turnId });
        assert.ok(coordinates);
        const failed = await engine.dispatch({ ...env, turnId, sequence: 1, origin: "model",
            statement: readStmt({ target: urlPath("workspace", "/missing.md") }),
        });
        assert.equal(failed.status, 404);
        const result = await engine.executeAdmittedTurn({ ...env, turnId, fromSequence: 2, origin: "model",
            source: null, emission: null, statements: [
                killStmt({ target: urlPath("log", `/${coordinates.loop_seq}/${coordinates.turn_seq}/1/READ`) }),
                { ...sendStmt(null), metadata: ["200"] },
            ],
        });
        assert.equal(result.status, 102, "retiring the receipt cannot remove the observation barrier");
        assert.deepEqual(result.outcomes, [
            { op: "KILL", status: 200, problemType: null },
            { op: "SEND", status: 200, problemType: null },
        ], "curation and delivery succeed independently of continuation");
        const history = await db.test_log_entries_by_turn.all<{ op: string; origin: string; active: number; status_rx: number }>({ turn_id: turnId });
        const receipt = history.find(({ op, origin }) => op === "READ" && origin === "model");
        assert.equal(receipt?.active, 0, "the failed receipt was actually removed from the model's curated view");
        assert.equal(receipt?.status_rx, 404, "execution evidence retains the failure");
        assert.equal((await db.message_unanswered_count.get({ loop_id: env.loopId }))?.count, 0,
            "the failed result, not an unanswered or unpublished message, prevents settlement");
        assert.equal((await engine.runTurn({ ...env, messages: [], provider: new Mock({ contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null } }],
        }) })).status, 200);
    } finally { await db.close(); }
});

test("{§body-projection} a KILL line scope trims a NOTE like any other log body", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: continuationStmt({ body: "Verify the finding.\nThe finished action.\nThe open inquiry." }),
            ...env, sequence: 1, origin: "model",
        });
        const curated = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1/NOTE"), marker: { marks: [2, 2] } }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(curated.status, 200);
        const row = await db.test_get_log_folded.get<{ folded: string }>({
            session_id: env.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(row?.folded, "[[2,2]]", "the completed entry's line is suppressed; lines 1 and 3 stay visible");
    } finally { await db.close(); }
});
test("{§edit} Engine.dispatch: EDIT against workspace:/// routes to Session.edit, returns 201, writes entry", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/france/capital"), body: "Paris" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entryId = (result as unknown as { entryId: number }).entryId;
        assert.ok(entryId >= 1);
        const entry = await db.test_get_entry_by_id.get<{ pathname: string }>({ id: entryId });
        assert.equal(entry?.pathname, "/france/capital");
    } finally { await db.close(); }
});

test("{§problems-dispatch} Engine.dispatch: a current READ line anchor lowers to a numeric EDIT precondition", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/anchored.md");
    const identity = "workspace:///anchored.md";
    try {
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: "alpha\nbeta\ngamma" }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);

        const original = "alpha\nbeta\ngamma";
        const beta = LineAnchors.token(identity, 2, original);
        const gamma = LineAnchors.token(identity, 3, original);
        const edited = await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [beta] }, body: "BETA" }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(edited.status, 200);

        const read = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(read.status, 200);
        assert.equal((read as { content?: string }).content, "alpha\nBETA\ngamma");

        const stale = await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [gamma] }, body: "GAMMA" }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(stale.problem?.detail, "EDIT collided with the current resource state."); // {§problems-dispatch}
        assert.equal(stale.problem?.target, identity);
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} Engine.dispatch: an EDIT anchor offset applies the splice of the numeric line it names (#749)", async () => {
    const { db, engine, env } = await setup();
    const original = "alpha\nbeta\ngamma\ndelta";
    try {
        const contents: string[] = [];
        let sequence = 0;
        for (const [name, marks] of [["offset", (identity: string) => [`${LineAnchors.token(identity, 2, original)}+1`]], ["numeric", () => [3]]] as const) {
            const target = urlPath("workspace", `/${name}.md`);
            const identity = `workspace:///${name}.md`;
            assert.equal((await engine.dispatch({ statement: dispatchEditStmt({ target, body: original }), ...env, sequence: ++sequence, origin: "model" })).status, 201);
            const edited = await engine.dispatch({ statement: dispatchEditStmt({ target, marker: { marks: marks(identity) as [number | string] }, body: "GAMMA" }), ...env, sequence: ++sequence, origin: "model" });
            assert.equal(edited.status, 200, name);
            const read = await engine.dispatch({ statement: readStmt({ target }), ...env, sequence: ++sequence, origin: "model" });
            contents.push((read as { content?: string }).content ?? "");
        }
        assert.equal(contents[0], "alpha\nbeta\nGAMMA\ndelta");
        assert.equal(contents[0], contents[1]);
    } finally { await db.close(); }
});

test("{§read} Engine.dispatch: a READ range starting past the end is an empty page with its extent; a single line past it is still refused (#759)", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/thirteen.md");
    try {
        const content = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n");
        assert.equal((await engine.dispatch({ statement: dispatchEditStmt({ target, body: content }), ...env, sequence: 1, origin: "model" })).status, 201);
        let sequence = 1;
        for (const marks of [[90, -1], [85, 210], [14, -1]] as const) {
            const read = await engine.dispatch({ statement: readStmt({ target, marker: { marks: [...marks] } }), ...env, sequence: ++sequence, origin: "model" });
            assert.ok(read.status === 200 || read.status === 204, JSON.stringify(marks));
            assert.equal((read as { content?: string }).content ?? "", "", JSON.stringify(marks));
            assert.deepEqual((read as { range?: unknown }).range, { unit: "line", total: 13, requested: [...marks] }, JSON.stringify(marks));
        }
        for (const marks of [[90], [5, 3], [90, 50]] as const) {
            const refused = await engine.dispatch({ statement: readStmt({ target, marker: { marks: [...marks] } }), ...env, sequence: ++sequence, origin: "model" });
            assert.equal(refused.status, 416, JSON.stringify(marks));
        }
    } finally { await db.close(); }
});

test("{§line-anchors} Engine.dispatch: an EDIT anchor in a column slot names the accepted whole-line range", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/invalid-anchor-region.md");
    const identity = "workspace:///invalid-anchor-region.md";
    try {
        const content = "alpha\nbeta\ngamma";
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: content }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const first = LineAnchors.token(identity, 1, content);
        const third = LineAnchors.token(identity, 3, content);

        const invalid = await engine.dispatch({
            statement: dispatchEditStmt({
                target,
                marker: { marks: [first, third, first, third] },
                body: null,
            }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(invalid.status, 400);
        assert.equal(
            invalid.problem?.detail,
            "A line anchor occupies a column slot in <SL,SC,EL,EC>; columns must be numeric.",
        );
        assert.equal(
            invalid.problem?.recovery,
            "Use <@start,@end> for an inclusive whole-line anchor range.",
        );
    } finally { await db.close(); }
});

test("{§line-anchors} Engine.dispatch: READ accepts a current line anchor and rejects a stale one as a collision", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/anchor-read.md");
    try {
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: "alpha\nbeta\ngamma" }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const numeric = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [2] } }),
            ...env, sequence: 2, origin: "model",
        });
        const anchor = (numeric as { lineAnchors?: readonly string[] }).lineAnchors?.[0];
        assert.match(anchor ?? "", /^@[0-9A-Za-z]{5}$/);

        const anchored = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [anchor!] } }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(anchored.status, 200);
        assert.equal((anchored as { content?: string }).content, "beta");

        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [2] }, body: "BETA" }),
            ...env, sequence: 4, origin: "model",
        })).status, 200);
        const stale = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [anchor!] } }),
            ...env, sequence: 5, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/line-anchor-collision");
        assert.equal(stale.problem?.retryable, false, "stale coordinates require a new READ, not automatic replay");
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("{§log-kill-scope} Engine.dispatch: scoped KILL accepts body and log anchors, and READ respects the curated view", async () => {
    const { db, engine, env } = await setup();
    const content = "alpha\nbeta\ngamma";
    const target = urlPath("log", "/1/1/1/READ");
    const publishedAnchors = LineAnchors.tokens("workspace:///source.md", content);
    try {
        await db.engine_insert_log_entry.get({
            session_id: env.sessionId, loop_id: env.loopId, turn_id: env.turnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "READ",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/source.md", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({
                status: 200,
                content,
                mimetype: "text/plain",
                startLine: 17,
                lineAnchorIdentity: "workspace:///source.md",
                lineAnchors: publishedAnchors,
                lineNumberWidth: 2,
            }),
            mimetype_rx: "application/json", status_rx: 200, weight: content.length,
            state: "resolved", outcome: null, attrs: "{}",
        });

        const read = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
        const logAnchors = (read as { lineAnchors?: readonly string[] }).lineAnchors;
        assert.equal(logAnchors?.[1], LineAnchors.token("log:///1/1/1/READ", 2, content));

        const foldedFromBody = await engine.dispatch({
            statement: killStmt({ target, marker: { marks: [publishedAnchors[1]] } }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(foldedFromBody.status, 200);
        const foldedFromLogRead = await engine.dispatch({
            statement: killStmt({ target, marker: { marks: [logAnchors[2]] } }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(foldedFromLogRead.status, 200);
        const row = await db.test_get_log_folded.get<{ folded: string }>({
            session_id: env.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(row?.folded, "[[2,3]]");

        const recovered = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 5, origin: "model",
        });
        assert.equal(recovered.status, 200);
        assert.equal((recovered as { content?: string }).content, "alpha", "READ omits deliberately trimmed lines");
        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            op: string | null;
            active: 0 | 1;
            folded: string;
            rx: string;
        }>({ turn_id: env.turnId });
        const retrieval = rows.find(({ sequence }) => sequence === 5);
        assert.deepEqual(
            { op: retrieval?.op, active: retrieval?.active, folded: retrieval?.folded },
            { op: "READ", active: 1, folded: "[]" },
            "retrieval lands as a new visible READ occurrence instead of mutating the curated occurrence",
        );
        assert.equal((JSON.parse(retrieval?.rx ?? "null") as { content?: string }).content, "alpha");
        assert.equal(JSON.parse(rows.find(({ sequence }) => sequence === 1)!.rx).content, content, "scoped curation preserves the complete original receipt for forensics");
    } finally { await db.close(); }
});

test("{§problems-dispatch} Engine.dispatch: a scoped READ anchor includes nearby lines outside the returned slice", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/contextual-anchor.md");
    const content = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
    try {
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: content }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);

        const read = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [5] } }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
        assert.equal((read as { content?: string }).content, "line-5");
        const anchor = (read as { lineAnchors?: readonly string[] }).lineAnchors?.[0];
        assert.match(anchor ?? "", /^@[0-9A-Za-z]{5}$/);

        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [7] }, body: "changed-nearby" }),
            ...env, sequence: 3, origin: "model",
        })).status, 200);

        const stale = await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [anchor!] }, body: "changed-target" }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(stale.problem?.detail, "EDIT collided with the current resource state."); // {§problems-dispatch}
        assert.equal(stale.problem?.target, "workspace:///contextual-anchor.md");
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("{§resolved-edit-statement} Engine.dispatch: a mutation between anchor resolution and landing is an edit collision", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `anchor-race-${crypto.randomUUID()}`);
    const target = urlPath("racy", "/unit.md");
    const identity = "racy:///unit.md";
    let intervene = false;
    const schemes = new SchemeRegistry();
    schemes.register("racy", {
        manifest: {
            name: "racy",
            channels: { body: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
            textEditScopes: true,
        },
        async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx) {
            if (intervene) {
                const changed = await ctx.entries.write("/unit.md", {
                    channels: {
                        body: {
                            content: "alpha\nother session\ngamma",
                            mimetype: "text/markdown",
                        },
                    },
                });
                assert.equal(changed.status, 200);
            }
            return ctx.entries.operations.editBatch(statements);
        },
    });
    const engine = new Engine({ db, schemes });
    try {
        const original = "alpha\nbeta\ngamma";
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: original }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const read = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 2, origin: "model",
        });
        const anchor = (read as { lineAnchors?: readonly string[] }).lineAnchors?.[1];
        assert.equal(anchor, LineAnchors.token(identity, 2, original));

        intervene = true;
        const collided = await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [anchor] }, body: "authored edit" }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(collided.status, 409);
        assert.equal(collided.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(collided.problem?.detail, "EDIT collided with the current resource state."); // {§problems-dispatch}
        assert.equal(collided.problem?.target, identity);
        assert.equal(collided.problem?.anchor, undefined);

        const stored = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/unit.md",
            scheme: "racy",
            name: "body",
        });
        assert.equal(stored?.content, "alpha\nother session\ngamma");
    } finally { await db.close(); }
});

test("{§line-anchors} Engine.dispatch: an anchored EDIT retains the READ owner's canonical resource identity", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `anchor-alias-${crypto.randomUUID()}`);
    const alias = urlPath("aliased", "/alias.md");
    const canonical = urlPath("aliased", "/canonical.md");
    const schemes = new SchemeRegistry();
    schemes.register("aliased", {
        manifest: {
            name: "aliased",
            channels: { body: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
            textEditScopes: true,
        },
        async resolveEntryAddress() {
            return { authority: "", pathname: "/canonical.md" };
        },
        async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx) {
            return ctx.entries.operations.editBatch(statements.map((statement) => ({
                ...statement,
                target: canonical,
            })));
        },
    });
    const engine = new Engine({ db, schemes });
    try {
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target: alias, body: "alpha\nbeta\ngamma" }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const read = await engine.dispatch({
            statement: readStmt({ target: alias }),
            ...env, sequence: 2, origin: "model",
        });
        const anchor = (read as { lineAnchors?: readonly string[] }).lineAnchors?.[1];
        assert.equal((read as { lineAnchorIdentity?: string }).lineAnchorIdentity, "aliased:///canonical.md");
        assert.equal(anchor, LineAnchors.token("aliased:///canonical.md", 2, "alpha\nbeta\ngamma"));

        const edited = await engine.dispatch({
            statement: dispatchEditStmt({ target: alias, marker: { marks: [anchor] }, body: "BETA" }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(edited.status, 200);
    } finally { await db.close(); }
});

test("{§edit} Engine.dispatch: a scheme without textual EDIT scopes rejects an anchor before invocation", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `anchor-boundary-${crypto.randomUUID()}`);
    let invoked = false;
    const schemes = new SchemeRegistry();
    schemes.register("whole", {
        manifest: {
            name: "whole",
            channels: { body: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
        },
        async editBatch() {
            invoked = true;
            return { status: 200 };
        },
    });
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({
                target: urlPath("whole", "/unit"),
                marker: { marks: ["@aZ09b"] },
                body: "replacement",
            }),
            ...env,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/line-anchor-unsupported");
        assert.equal(invoked, false);
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} Engine.dispatch: writes log_entry with statement + result fields", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{
            session_id: number; loop_id: number; turn_id: number; sequence: number;
            origin: string; op: string; signal: string | null;
            scheme: string | null; pathname: string | null;
            tx: string; mimetype_tx: string; rx: string; mimetype_rx: string; status_rx: number;
        }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("log_entry not found");
        assert.equal(log.session_id, env.sessionId);
        assert.equal(log.loop_id, env.loopId);
        assert.equal(log.turn_id, env.turnId);
        assert.equal(log.sequence, 1);
        assert.equal(log.origin, "model");
        assert.equal(log.op, "EDIT");
        assert.equal(Object.hasOwn(log, "delimiter"), false);
        assert.equal(log.signal, null);
        assert.equal(log.scheme, "workspace");
        assert.equal(log.pathname, "/x");
        assert.equal(log.mimetype_tx, "application/json");
        assert.equal(log.mimetype_rx, "application/json");
        assert.equal(log.status_rx, 201);
        const tx = JSON.parse(log.tx) as { op: string };
        assert.equal(tx.op, "EDIT");
        const rx = JSON.parse(log.rx) as { status: number };
        assert.equal(rx.status, 201);
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: READ against workspace:/// routes to Session.read", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/r"), body: "value" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("workspace", "/r") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { content: string }).content, "value");
    } finally { await db.close(); }
});

test("{§unregistered-scheme-recovery} Engine.dispatch: unknown scheme returns 501 and still writes log row", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("wiki", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 501);
        assert.equal(log?.scheme, "wiki");
    } finally { await db.close(); }
});

test("{§problems-dispatch} Engine.dispatch: null path on path-required op returns 400 and logs", async () => {
    const { db, engine, env } = await setup();
    try {
        const stmt: EditStatement = {
            metadata: null,
            op: "EDIT", aside: null, target: null, lineMarker: null, matcher: null, body: "y",
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string | null; pathname: string | null }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 400);
        assert.equal(log?.scheme, null);
        assert.equal(log?.pathname, null);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} Engine.dispatch: multiple actions in one turn — log_entries sequence UNIQUE enforced", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/a"), body: "1" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/b"), body: "2" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; pathname: string }>({ turn_id: env.turnId });
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.sequence, 1);
        assert.equal(rows[0]?.pathname, "/a");
        assert.equal(rows[1]?.sequence, 2);
        assert.equal(rows[1]?.pathname, "/b");
    } finally { await db.close(); }
});
test("{§scheme-surface} Engine.dispatch: origin field captured in log", async () => {
    const { db, engine, env } = await setup();
    try {
        const turnIds: number[] = [];
        for (const [i, origin] of (["model", "client", "_plurnk"] as const).entries()) {
            const turnId = origin === "model"
                ? env.turnId
                : await insertOperationTurn(db, env.loopId, i + 1, origin);
            turnIds.push(turnId);
            await engine.dispatch({
                statement: dispatchEditStmt({ target: urlPath("workspace", `/o${i}`), body: "x" }),
                workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId,
                sequence: 1, origin,
            });
        }
        const origins = [];
        for (const turnId of turnIds) {
            const rows = await db.test_log_entries_by_turn.all<{ origin: string }>({ turn_id: turnId });
            origins.push(rows[0]?.origin);
        }
        assert.deepEqual(origins, ["model", "client", "_plurnk"]);
    } finally { await db.close(); }
});

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy or dispatch
// returns 403 without invoking the handler.

test("{§scheme-surface} Engine.dispatch: a writer outside writableBy is rejected 403 without invoking the handler", async () => {
    const { db, engine, env } = await setup();
    try {
        const turnId = await insertOperationTurn(db, env.loopId, 2, "client");
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("reasoning", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId,
            sequence: 1, origin: "client",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
        assert.equal(result.problem?.writer, "client");
        assert.equal(result.problem?.scheme, "reasoning");
        assert.deepEqual(result.problem?.allowedWriters, []);
        // 403 still writes a log row
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: turnId });
        assert.equal(log?.status_rx, 403);
        assert.equal(log?.scheme, "reasoning");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: log EDIT has no mutation surface; reasoning uses an ordinary data resource", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        assert.match(result.problem!.type, /operation-not-implemented$/);
        assert.equal(result.problem!.detail, "Scheme 'log' does not implement EDIT."); // {§problems-dispatch}
    } finally { await db.close(); }
});

test("{§turn-source-resources} Engine.dispatch: model EDIT of reasoning is rejected with 403 (turn sources are immutable)", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: { ...urlPath("reasoning", "/1/1"), hostname: "alice", raw: "reasoning://alice/1/1" }, body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    } finally { await db.close(); }
});

test("{§session-scheme} Engine.dispatch: an unrelated model writes named runtime scratch through ordinary EDIT", async () => {
    const { db, engine, env } = await setup();
    try {
        await RuntimeSession.ensure(db, env.workspaceId);
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: { kind: "url", raw: "session://_plurnk/private.md", scheme: "session", username: null, password: null, hostname: "_plurnk", port: null, pathname: "/private.md", query: null, fragment: null }, body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201, "runtime scratch has the same workspace access as any named scratch");
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: model READ log:/// is NOT gated by writableBy (read-side op)", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log scheme has no read() handler yet, so this returns 501 — proves
        // the writableBy gate did NOT intercept (would have returned 403).
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("log", "/x") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: _plurnk EDIT log:/// is allowed by writableBy", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log has no edit() handler — so this returns 501 (not 403) when allowed.
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "_plurnk",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: an instance manifest enforces writableBy like a static manifest", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    let invoked = false;
    class Dynamic {
        get manifest() {
            return {
                name: "dynamic",
                channels: {},
                defaultChannel: "",
                category: "data" as const,
                writableBy: [],
                volatile: false,
                modelVisible: true,
            };
        }
        async editBatch() {
            invoked = true;
            return { status: 200 };
        }
    }
    schemes.register("dynamic", new Dynamic());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("dynamic", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
        assert.equal(invoked, false, "the handler is not invoked after its manifest denies the writer");
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: a model reply needs no external capability", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.injectIntoLoop(env.loopId, "Reply.", [], undefined, {}, "message://request/reply");
        const result = await engine.dispatch({
            statement: sendStmt(parsePath("message://request/reply")),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

// {§scheme-surface} Scheme-handler
// exceptions finalize the action-entry at 500, not bubble up.

test("{§problems-dispatch} Engine.dispatch: scheme handler that throws → action-entry at status 500 (action-entry-as-outcome)", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class Boom {
        static manifest = {
            name: "boom", channels: {}, defaultChannel: "",
            category: "data" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async editBatch(): Promise<never> { throw new Error("scheme handler deliberately threw"); }
    }
    schemes.register("boom", new Boom());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("boom", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.detail, "The 'boom' scheme did not produce a result for EDIT."); // {§problems-dispatch}
        assert.equal(result.problem?.stage, "scheme-dispatch");
        assert.equal(result.problem?.scheme, "boom");
        assert.equal(result.problem?.operation, "EDIT");
        assert.doesNotMatch(JSON.stringify(result), /scheme handler deliberately threw/);
        // action-entry preserved at status 500 with error in rx
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; rx: string; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 500);
        assert.equal(log?.scheme, "boom");
        const rx = JSON.parse(log?.rx ?? "{}");
        assert.equal(rx.status, 500);
        assert.equal(rx.problem.detail, "The 'boom' scheme did not produce a result for EDIT."); // {§problems-dispatch}
        assert.doesNotMatch(log?.rx ?? "", /scheme handler deliberately threw/);
    } finally { await db.close(); }
});

test("{§problems-dispatch} Engine.dispatch: non-Error throw becomes the same generic contract Problem", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class BoomString {
        static manifest = {
            name: "boomstr", channels: {}, defaultChannel: "",
            category: "data" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async editBatch(): Promise<never> { throw "raw string thrown"; }
    }
    schemes.register("boomstr", new BoomString());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("boomstr", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-handler-threw");
        assert.equal(result.problem?.detail, "The 'boomstr' scheme did not produce a result for EDIT."); // {§problems-dispatch}
        assert.doesNotMatch(JSON.stringify(result), /raw string thrown/);
    } finally { await db.close(); }
});

test("{§problems-dispatch} Engine.dispatch: COPY rejects a non-entry destination at resource resolution", async () => {
    const { db, engine, env } = await setup();
    try {
        // Source first: model creates an entry in workspace:///.
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/src"), body: "v" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        // Attempt copy workspace:///src → log:///dst — destination scheme rejects.
        const result = await engine.dispatch({
            statement: {
                op: "COPY", aside: null,
                source: { target: urlPath("workspace", "/src"), metadata: null, lineMarker: null, matcher: null },
                destination: { target: urlPath("log", "/dst"), metadata: null, lineMarker: null, matcher: null },
                position: { line: 1, column: 1 },
            },
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(
            result.problem?.type,
            "https://problems.plurnk.xyz/engine/dispatcher/entry-operation-unsupported",
        );
        assert.equal(result.problem?.scheme, "log");
        assert.equal(result.problem?.category, "logging");
    } finally { await db.close(); }
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
                    assert.equal(problem.detail, "EDIT collided with the current resource state."); // {§problems-dispatch}
                    assert.deepEqual(problem.unresolvedAnchors, ownUnresolved, "each row diagnoses all of its own unresolved anchors");
                    assert.equal(problem.editCount, 1);
                    assert.equal(problem.applied, 0);
                    assert.equal(problem.recovery, "0 of 1 edits applied. READ the target for current coordinates."); // {§problems-dispatch}
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

describe("File.reviewed-batch", () => {
const execFileP = promisify(execFile);

test("{§scheme-edit-proposal-receipt} {§edit-result-receipt-projection} {§op-methods-op-dispatch}: reviewer replacement supersedes only its EDIT; the next scope addresses the landed content", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-reviewed-batch-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "fixture"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "reviewed.md"), "one\ntwo\nthree\nfour\n");
        await execFileP("git", ["add", "reviewed.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP(
            "git",
            ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"],
            { cwd: root, env: hermeticGitEnv() },
        );

        const mock = new Mock({
            contextWindow: 32768,
            responses: [makeMockResponse(
                "````EDIT (reviewed.md) <2>\nTWO\n````\n"
                + "````EDIT (reviewed.md) <4>\nFOUR\n````\n"
                + "````SEND\ndone\n````",
                20,
            ), makeMockResponse("````SEND [200]\ndone\n````", 10)], // {§send-premature-terminate} — the edit receipts force the second turn
        });
        const reviewed = "reviewer\nreplacement\n";
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const proposals = subscribeNotifications(ws, "loop/proposal");
                const terminated = subscribeNotifications(ws, "loop/terminated");
                await rpcCall(ws, 1, "workspace.create", {
                    name: `reviewed-batch-${crypto.randomUUID()}`,
                    projectRoot: root,
                });
                const started = await rpcCall(ws, 2, "loop.run", { prompt: "edit the file" });
                const loopId = (started.result as { loopId: number }).loopId;
                const pending = await waitFor(
                    () => proposals() as Array<{ logEntryId: number; op: string }>,
                    (items) => items.some((item) => item.op === "EDIT"),
                );
                const proposal = pending.find((item) => item.op === "EDIT");
                assert.ok(proposal !== undefined);
                await rpcCall(ws, 3, "loop.resolve", {
                    logEntryId: proposal.logEntryId,
                    decision: "accept",
                    body: reviewed,
                });
                await waitFor(
                    () => terminated() as Array<{ loopId: number }>,
                    (items) => items.some((item) => item.loopId === loopId),
                );

                assert.equal(await readFile(join(root, "reviewed.md"), "utf8"), reviewed);
                const rows = await db.test_log_entries_by_loop.all<{
                    op: string;
                    origin: string;
                    tx: string;
                    rx: string;
                }>({ loop_id: loopId });
                const edits = rows
                    .filter((row) => row.op === "EDIT" && row.origin === "model")
                    .map((row) => ({
                        tx: JSON.parse(row.tx) as { lineMarker?: { marks?: number[] } },
                        rx: JSON.parse(row.rx) as {
                            status: number;
                            editReceipt?: unknown;
                            receipt?: {
                                revision?: string;
                                disposition?: string;
                                requested?: string;
                                replacement?: {
                                    requested?: string;
                                    source?: string;
                                    result?: string;
                                    context?: string;
                                };
                            };
                        },
                    }));
                assert.equal(edits.length, 2);
                assert.deepEqual(edits.map(({ tx }) => tx.lineMarker?.marks), [[2], [4]]);
                assert.deepEqual(edits.map(({ rx }) => rx.status), [200, 416], "the second EDIT independently rejects line 4 of the two-line replacement");
                assert.deepEqual(
                    edits.map(({ rx }) => ({
                        disposition: rx.receipt?.disposition,
                        requested: rx.receipt?.requested,
                    })),
                    [
                        { disposition: "superseded", requested: "<2>" },
                        { disposition: undefined, requested: undefined },
                    ],
                );
                const { context: replacementContext, ...replacement } = edits[0]?.rx.receipt?.replacement ?? {};
                assert.deepEqual(replacement, { requested: "<1,-1>", source: "<1,4>", result: "<1,2>", removed: 4, inserted: 2 });
                assert.match(String(replacementContext), /^1<@[0-9A-Za-z]{5}>reviewer\n2<@[0-9A-Za-z]{5}>replacement$/, "{§edit-result-receipt-projection} the landed context is anchored");
                assert.equal(edits[1]?.rx.receipt?.replacement, undefined);
                assert.equal(edits[1]?.rx.receipt, undefined, "a rejected operation has no landed effect receipt");
                assert.equal(edits[0]?.rx.editReceipt, undefined);
                assert.equal(edits[1]?.rx.editReceipt, undefined);
            } finally {
                ws.close();
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("File.scheme.proposal", () => {
// File scheme as the canonical proposal consumer (SPEC.md {§engine-rails} + {§methods}
// + {§membership} D3 — disk co-location). EDIT against a file returns status=202 with a udiff body
// and {path, canonical, patch, patched} attrs; on accept the engine calls
// File.applyResolution which writes patched content to disk.























const fileEditStmt = (pathname: string, body: string, marker: LineMarker | null = null): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: { kind: "local", raw: pathname },
    lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 },
});

const fileReadStmt = (pathname: string): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "local", raw: pathname },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

// Bare-path edit — the form the sysprompt actually trains the model to
// emit. plurnk.md: "Bare paths (no scheme) default to local relative
// project file paths." Engine.#schemeNameOf routes LocalPath → 'file'.
const bareEditStmt = (relPath: string, body: string, marker: LineMarker | null = null): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: { kind: "local", raw: relPath },
    lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Set up a temp workspace + a workspace whose project_root points at it.
// Returns the temp root for body assertions + a cleanup fn.
const withWorkspaceRoot = async <T>(fn: (root: string, ctx: { db: Db; engine: Engine; workspaceId: number; sessionId: number; loopId: number; turnId: number }) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-test-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `file-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "file edit test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn(root, { db, engine, workspaceId, sessionId, loopId, turnId });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("{§configuration-repair-path}: invalid file creation policy refuses the EDIT without creating a file or proposal", async (t) => {
    const key = "PLURNK_SERVICE_FILE_CREATE_SCOPE";
    const before = process.env[key];
    process.env[key] = "invalid";
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    await withWorkspaceRoot(async (root, ctx) => {
        const result = await ctx.engine.dispatch({ ...ctx, statement: bareEditStmt("new.txt", "must not appear"), sequence: 1, origin: "model" });
        assert.equal(result.status, 503);
        assert.equal(result.problem?.key, key);
        assert.deepEqual(await ctx.engine.pendingProposals(ctx.workspaceId), []);
        await assert.rejects(stat(join(root, "new.txt")), { code: "ENOENT" });
    });
});

for (const decision of ["accept", "reject", "drift"] as const) test(`{§slice-semantics-compose-pattern}: exact attribute EDIT through a ${decision} file proposal`, async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const original = '<root><item id = "old" class="kept"/></root>';
        const seed = deferred<number>();
        const creating = ctx.engine.dispatch({ ...ctx, statement: fileEditStmt("source.xml", original), sequence: 1, origin: "model", onDispatch: seed.resolve });
        ctx.engine.resolveProposal(await seed.promise, { decision: "accept" });
        assert.equal((await creating).status, 200);
        const pending = deferred<number>();
        const editing = ctx.engine.dispatch({ ...ctx, sequence: 2, origin: "model", onDispatch: pending.resolve,
            statement: { ...fileEditStmt("source.xml", 'id="new"'), matcher: { dialect: "xpath" as const, raw: "//item/@id" } } });
        const id = await pending.promise;
        if (decision === "drift") await writeFile(join(root, "source.xml"), original.replace("old", "external"));
        ctx.engine.resolveProposal(id, decision === "reject" ? { decision: "reject", outcome: "declined" } : { decision: "accept" });
        const result = await editing;
        assert.equal(result.status, decision === "accept" ? 200 : decision === "reject" ? 400 : 409, JSON.stringify(result));
        assert.equal(await readFile(join(root, "source.xml"), "utf8"), decision === "accept"
            ? '<root><item id="new" class="kept"/></root>' : decision === "drift" ? original.replace("old", "external") : original);
        if (decision !== "accept") assert.match(String(result.problem?.type), decision === "reject" ? /\/rejected$/ : /\/edit-collision$/);
    });
});

test("{§binary-parity}: a deferred byte MOVE cannot remove a source that changed during destination review", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const source = { authority: "", pathname: "/source.png" };
        const schemeCtx = makeSchemeCtx(ctx);
        const original = new Uint8Array([0, 1, 2, 3, 4]);
        const updated = new Uint8Array([0, 9, 9, 3, 4]);
        assert.equal((await EntryCrud.writeEntry(source, { channels: { body: { content: "", bytes: original, mimetype: "image/png" } } }, schemeCtx, "workspace")).status, 201);
        const pending = deferred<number>();
        const moving = ctx.engine.dispatch({ ...ctx, sequence: 1, origin: "model", onDispatch: pending.resolve,
            statement: moveStmt(urlPath("workspace", "/source.png"), localPath("destination.png"), { marks: [2, 3] }) });
        const id = await pending.promise;
        assert.equal((await EntryCrud.writeEntry(source, { channels: { body: { content: "", bytes: updated, mimetype: "image/png" } } }, schemeCtx, "workspace")).status, 200);
        ctx.engine.resolveProposal(id, { decision: "accept" });
        const result = await moving;
        assert.equal(result.status, 409, JSON.stringify(result));
        assert.match(String(result.problem?.type), /\/edit-collision$/);
        assert.deepEqual(await readFile(join(root, "destination.png")), Buffer.from([1, 2]));
        const read = await EntryCrud.readEntry(source, schemeCtx, "workspace");
        assert.equal(read.entry?.channels.body?.content, Buffer.from(updated).toString("base64"));
    });
});

for (const transfer of [copyStmt, moveStmt]) {
    const op = transfer(urlPath("workspace", "/source"), localPath("destination")).op;
    for (const target of ["destination.bin", "destination", "destination.unknownext"]) {
        for (const shape of ["whole", "scoped", "empty"] as const) {
            test(`{§copy}: ${op} publishes ${shape} bytes at ${target} with the admitted type`, async () => {
                await withWorkspaceRoot(async (root, ctx) => {
                    const source = { authority: "", pathname: "/source" };
                    const schemeCtx = makeSchemeCtx(ctx);
                    const bytes = shape === "empty" ? Buffer.alloc(0) : Buffer.from([0, 0xff, 0x80, 42]);
                    assert.equal((await EntryCrud.writeEntry(source, {
                        channels: { body: { content: "", bytes, mimetype: "application/octet-stream" } },
                    }, schemeCtx, "workspace")).status, 201);
                    const pending = Promise.withResolvers<number>();
                    const applying = ctx.engine.dispatch({ ...ctx, sequence: 1, origin: "model", onDispatch: pending.resolve,
                        statement: transfer(urlPath("workspace", "/source"), localPath(target),
                            shape === "scoped" ? { marks: [2, 3] } : null,
                            shape === "scoped" ? { marks: [0] } : null) });
                    const id = await pending.promise;
                    const proposal = await ctx.db.test_get_log_entry_by_id.get<{ state: string; attrs: string }>({ id });
                    assert.equal(proposal?.state, "proposed", JSON.stringify(proposal));
                    assert.equal(JSON.parse(proposal.attrs).mimetype, "application/octet-stream");
                    await assert.rejects(readFile(join(root, target)), { code: "ENOENT" });
                    await ctx.engine.resolveProposal(id, { decision: "accept" });
                    const result = await applying;
                    assert.equal(result.status, 200, JSON.stringify(result));
                    assert.deepEqual(await readFile(join(root, target)), shape === "scoped" ? bytes.subarray(1, 3) : bytes);
                    const destination = await EntryCrud.readEntry({ authority: "", pathname: target }, schemeCtx, "file");
                    assert.equal(destination.entry?.channels.body?.mimetype, "application/octet-stream");
                    const remaining = await EntryCrud.readEntry(source, schemeCtx, "workspace");
                    if (op === "MOVE" && shape !== "scoped") assert.equal(remaining.status, 404);
                    else assert.equal(remaining.entry?.channels.body?.content,
                        (op === "MOVE" ? Buffer.from([0, 42]) : bytes).toString("base64"));
                });
            });
        }
    }
    test(`{§copy}: rejecting ${op} to an untyped file preserves its byte source`, async () => {
        await withWorkspaceRoot(async (root, ctx) => {
            const source = { authority: "", pathname: "/source" };
            const schemeCtx = makeSchemeCtx(ctx);
            const bytes = Buffer.from([0, 0xff, 42]);
            await EntryCrud.writeEntry(source, { channels: { body: { content: "", bytes, mimetype: "application/octet-stream" } } }, schemeCtx, "workspace");
            const pending = Promise.withResolvers<number>();
            const applying = ctx.engine.dispatch({ ...ctx, sequence: 1, origin: "model", onDispatch: pending.resolve,
                statement: transfer(urlPath("workspace", "/source"), localPath("destination.bin")) });
            const id = await pending.promise;
            const proposals = await ctx.engine.pendingProposals(ctx.workspaceId);
            assert.equal(proposals.length, 1);
            await ctx.engine.resolveProposal(id, { decision: "reject" });
            const result = await applying;
            assert.equal(result.status, 400);
            assert.match(String(result.problem?.type), /\/rejected$/);
            await assert.rejects(readFile(join(root, "destination.bin")), { code: "ENOENT" });
            assert.equal((await EntryCrud.readEntry(source, schemeCtx, "workspace")).entry?.channels.body?.content, bytes.toString("base64"));
        });
    });
}

for (const decision of ["accept", "reject", "replace", "drift"] as const) test(`{§op-methods-op-dispatch}: file proposals with ${decision} preserve the individual mutation boundary`, async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const original = "one\ntwo\nthree\nfour\nfive\n";
        const target = "sequence.md";
        const seed = deferred<number>();
        const creating = ctx.engine.dispatch({ ...ctx, statement: fileEditStmt(target, original), sequence: 1, origin: "model", onDispatch: seed.resolve });
        ctx.engine.resolveProposal(await seed.promise, { decision: "accept" });
        assert.equal((await creating).status, 200);
        const read = await clientRead(ctx.engine, ctx.db, { ...ctx, statement: { ...fileReadStmt(target), lineMarker: fullReplace } });
        assert.equal(read.status, 200);
        const anchors = read.lineAnchors as string[];
        assert.ok(anchors.length >= 3);
        const source = `\`\`\`\`EDIT (${target}) <2>
TWO
\`\`\`\`
\`\`\`\`EDIT (${target}) <${anchors[2]}>
THREE
\`\`\`\`
\`\`\`\`NOTE
Continue the task.
\`\`\`\``;
        const first = deferred<number>();
        const second = deferred<number>();
        let firstId = 0;
        let dispatched = 0;
        const turn = await Turn.open(ctx.db, { loopId: ctx.loopId, producer: "client", kind: "operation" });
        const execution = ctx.engine.executeAdmittedTurn({
            ...ctx, turnId: turn.id, origin: "client", source, emission: null,
            fromSequence: 1, statements: TurnOps.parseInternal(source),
            onDispatch: (id) => {
                dispatched++;
                if (dispatched === 1) { firstId = id; first.resolve(id); }
                if (dispatched === 2) second.resolve(id);
            },
            onSettled: async (id) => {
                if (id === firstId && decision === "drift") await writeFile(join(root, target), original.replace("two", "TWO").replace("four", "external"));
            },
        });
        ctx.engine.resolveProposal(await first.promise, decision === "reject"
            ? { decision: "reject", outcome: "declined" }
            : { decision: "accept", ...(decision === "replace" ? { body: "reviewer replacement\n" } : {}) });
        const secondId = await second.promise;
        if (decision !== "replace") ctx.engine.resolveProposal(secondId, { decision: "accept" });
        const result = await execution;
        const edits = result.outcomes.filter(({ op }) => op === "EDIT");
        assert.deepEqual(edits.map(({ status }) => status), [decision === "reject" ? 400 : 200, decision === "replace" || decision === "drift" ? 409 : 200]);
        const expected = decision === "replace" ? "reviewer replacement\n"
            : decision === "drift" ? original.replace("two", "TWO").replace("four", "external")
                : (decision === "reject" ? original : original.replace("two", "TWO")).replace("three", "THREE");
        assert.equal(await readFile(join(root, target), "utf8"), expected);
    });
});

test("{§fs-write-surface} file.edit: writes file on accept via applyResolution", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        // Pre-seed an existing file so the EDIT computes a real diff.
        const target = "src/hello.txt";
        // File.edit gates on membership (SPEC {§membership}): a pre-existing file must be a
        // member (git-tracked or client-added) to be editable — register it, the same
        // way READ's gate is satisfied below. A NEW path needs no prior member.
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, target), "hello\n", "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        // {§edit} — the file exists, so the deliberate
        // full-rewrite escape hatch (<1,-1>) is required; this also proves it works.
        const stmt = fileEditStmt(target, "hello world\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string; canonical: string; patch: string; patched: string };
        assert.equal(attrs.path, target); // bare canon ({§fs-namespace})
        assert.equal(attrs.patched, "hello world\n");
        assert.match(attrs.patch, /^Index: src\/hello\.txt/);
        assert.match(attrs.patch, /-hello/);
        assert.match(attrs.patch, /\+hello world/);

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "hello world\n");
        // The applied EDIT's rx carries the bounded structured receipt computed from what landed.
        const applied = await ctx.db.test_get_log_entry_by_id.get<{ status_rx: number; rx: string }>({ id: logEntryId });
        assert.equal(applied?.status_rx, 200);
        const appliedRx = JSON.parse(applied?.rx ?? "{}") as {
            receipt?: { revision?: string; effect?: { context?: string } };
        };
        assert.match(appliedRx.receipt?.revision ?? "", /^[a-f0-9]{64}$/);
        assert.match(appliedRx.receipt?.effect?.context ?? "", /1(?:<@[0-9A-Za-z]{5}>|:)hello world/, "applied EDIT rx shows bounded landed context");
    });
});

test("{§engine-rails} file.edit: a landed source receipt reports parser recovery against its preserved mimetype", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "broken.go";
        const id = deferred<number>();
        const dispatched = ctx.engine.dispatch({
            statement: fileEditStmt(target, "package sample\nfunc broken("),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
            onDispatch: (logEntryId) => id.resolve(logEntryId),
        });
        const logEntryId = await id.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatched;
        assert.equal(result.status, 200);

        const row = await ctx.db.test_get_log_entry_by_id.get<{ rx: string }>({ id: logEntryId });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            receipt?: { parseIssues?: { before: number; after: number } };
        };
        assert.equal(rx.receipt?.parseIssues?.before, 0, JSON.stringify(rx));
        assert.ok(Number.isSafeInteger(rx.receipt?.parseIssues?.after));
        assert.ok((rx.receipt?.parseIssues?.after ?? 0) > 0, JSON.stringify(rx));
        const channel = await ctx.db.test_get_channel_by_pathname_scheme.get<{ mimetype: string }>({
            pathname: target,
            scheme: "file",
            name: "body",
        });
        assert.equal(channel?.mimetype, "text/x-go");
        assert.equal(await readFile(join(root, target), "utf8"), "package sample\nfunc broken(");
    });
});

test("{§engine-rails} file.applyResolution: malformed accepted proposal state remains an internal invariant", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        await assert.rejects(
            new File().applyResolution(
                { attrs: {}, metadata: null },
                makeSchemeCtx({
                    db: ctx.db,
                    workspaceId: ctx.workspaceId,
                    sessionId: ctx.sessionId,
                    loopId: ctx.loopId,
                    turnId: ctx.turnId,
                }),
            ),
            InvalidOperationResultError,
        );
    });
});

test("{§engine-rails} file.edit: an unchanged file is a 304 no-op and never becomes a proposal", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "unchanged.txt";
        const original = "same\n";
        await writeFile(join(root, target), original, "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0,
            workspace_id: ctx.workspaceId,
            scheme: "file",
            authority: "",
            pathname: target,
        });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        const idDeferred = deferred<number>();
        const result = await ctx.engine.dispatch({
            statement: fileEditStmt(target, original, fullReplace),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        assert.equal(result.status, 304);
        assert.equal(
            result.detail,
            "No change: EDIT body matches the selected content.",
        );
        assert.equal(await readFile(join(root, target), "utf8"), original);

        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number }>({
            id: await idDeferred.promise,
        });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.status_rx, 304);
    });
});

test("{§proposal-outcome-terse-error} file.edit: rejection leaves file untouched; the rx carries a durable Problem Details result", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "untouched.txt";
        // pre-existing file must be a member to be editable (SPEC {§membership} edit gate)
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await writeFile(join(root, target), "original\n", "utf8");
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        const stmt = fileEditStmt(target, "should-not-land\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "reject", outcome: "reviewer_said_no" });
        const result = await dispatchPromise;
        assert.equal(result.status, 400);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "original\n", "rejected EDIT must not touch disk");
        // The model-facing rx carries the one-word why — a mute {"status":400} reads as a
        // phantom failure the model can't act on (the fan-out dead-park).
        const row = await ctx.db.test_get_log_entry_by_id.get<{ rx: string }>({ id: logEntryId });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            status?: number;
            outcome?: string;
            problem?: { type?: string; status?: number; detail?: string; instance?: string; stage?: string; retryable?: boolean };
        };
        assert.equal(rx.status, 400);
        assert.equal(rx.outcome, "reviewer_said_no");
        assert.deepEqual(rx.problem, {
            type: "https://problems.plurnk.xyz/proposal/rejected",
            title: "Rejected",
            status: 400,
            detail: "The proposal was rejected (reviewer_said_no).",
            instance: "log:///1/1/1/EDIT",
            stage: "proposal-settlement",
            retryable: false,
        });
    });
});

test("{§engine-rails} file.edit: creates a new file on accept (target doesn't exist)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "new-dir"), { recursive: true });
        const target = "new-dir/new-file.md";
        const stmt = fileEditStmt(target, "# Created via proposal\n");

        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "# Created via proposal\n");
    });
});

test("{§edit-result-receipt-projection}: reviewer-modified acceptance receipts the landed content", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "reviewed.md";
        const stmt = fileEditStmt(target, "model proposal\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const reviewed = "reviewer revision\n";
        ctx.engine.resolveProposal(logEntryId, { decision: "accept", body: reviewed });
        await dispatchPromise;
        assert.equal(await readFile(join(root, target), "utf8"), reviewed);
        const row = await ctx.db.test_get_log_entry_by_id.get<{ rx: string }>({ id: logEntryId });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            receipt?: {
                revision?: string;
                disposition?: string;
                requested?: string;
                replacement?: { context?: string };
            };
        };
        assert.equal(rx.receipt?.revision, createHash("sha256").update(reviewed).digest("hex"));
        assert.equal(rx.receipt?.disposition, "superseded");
        assert.equal(rx.receipt?.requested, "<1,-1>");
        assert.match(rx.receipt?.replacement?.context ?? "", /1(?:<@[0-9A-Za-z]{5}>|:)reviewer revision/);
        assert.doesNotMatch(rx.receipt?.replacement?.context ?? "", /model proposal/);
    });
});

test("{§membership}: accepted file creation creates missing parent directories", async () => {
    // The write-back edge creates the target's missing parent directories.
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "tasks/nested/extract_config_values.md";
        const stmt = fileEditStmt(target, "# task\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "the accept applies — never write_failed on a missing parent");
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "# task\n");
    });
});

test("{§unscoped-edit-create-only} {§edit}: markerless EDIT refuses an existing file", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "src/Engine.ts";
        await mkdir(join(root, "src"), { recursive: true });
        const original = "line one\nline two\nline three\n";
        await writeFile(join(root, target), original, "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        // A marker meant for the target landed inside the body text
        // instead (a model syntax slip), so the dispatched statement carries no marker at all.
        const stmt = fileEditStmt(target, "<2>:// AUDIT-OK\nline two");
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "no marker on an existing file is refused outright — never a proposal, never a silent replace");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/line-marker-required");
        assert.match(result.problem?.detail ?? "", /requires a line marker/);
        assert.match(result.problem?.recovery ?? "", /<1,-1>/, "the recovery names the explicit whole-file form");
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, original, "disk is untouched — the refusal happens before any proposal, let alone any write");
    });
});

test("{§engine-rails} file.edit: refuses traversal escape", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const stmt = fileEditStmt("../escape.txt", "nope\n");
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    });
});

test("{§membership} bare target: EDIT(relative/path) routes to file scheme (no scheme prefix)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "from-bare.txt";
        // pre-existing file must be a member to be editable (SPEC {§membership} edit gate);
        // materialize the body channel too — the marker math below reads `original`.
        await writeFile(join(root, target), "original\n", "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        // No file:/// prefix — the form the sysprompt teaches. The file exists, so the
        // marker is required ({§edit}).
        const stmt = bareEditStmt(target, "bare-path edit\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;

        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.status_rx, 202, "bare path EDIT must route to file scheme + propose");
        assert.equal(row?.state, "proposed");
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string };
        assert.equal(attrs.path, target); // bare canon ({§fs-namespace})

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "bare-path edit\n");
    });
});

test("{§engine-rails} file.read: reads the materialized entry beside the edit path", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "read-me.txt";
        await writeFile(join(root, target), "content\n", "utf8");
        // File.read serves the materialized entry — materialize the content
        // (production's git-membership pass does this), not just a membership marker.
        const writeCtx: PlurnkSchemeContext = {
            db: ctx.db, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            writer: "model", signal: undefined, weigh: (t: string) => t.length,
        };
        await EntryCrud.writeEntry({ authority: "", pathname: target }, { channels: { body: { content: "content\n", mimetype: "text/markdown" } } }, writeCtx, "file");

        const stmt = fileReadStmt(target);
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    });
});

test("{§engine-rails} file.edit: headless workspace (no project_root) → 400", async () => {
    // A workspace with no project_root returns 400 with a clear error naming
    // the contract: file ops need a workspace created with projectRoot
    // (headless is forever).
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `headless-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "headless");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = bareEditStmt("any.txt", "content\n");
        const result = await engine.dispatch({
            statement: stmt, workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    } finally { await db.close(); }
});
});

describe("auto-anti-clobber", () => {
// Hash-anchored stale-read anti-clobber. The model READs V1, the file changes to V2
// outside Plurnk, and its V1 anchor must reject the later EDIT before proposal.













const execFileP = promisify(execFile);

test("{§edit} a stale hash anchor rejects an EDIT before proposal — no silent clobber", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-clobber-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "doc.md"), "V1 original\n");
        await execFileP("git", ["add", "doc.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const staleAnchor = LineAnchors.token("doc.md", 1, "V1 original\n");
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (doc.md)````\n````NOTE\nReview the file.\n````", 50),
            makeMockResponse("````SEND [200]\nRead complete.\n````", 50),
            makeMockResponse(`\`\`\`\`EDIT (doc.md) <${staleAnchor}>
V3 model clobber
\`\`\`\`

\`\`\`\`SEND
done
\`\`\`\`
\`\`\`\`SEND
\`\`\`\``, 50),
            makeMockResponse("````SEND [200]\nStale edit rejected.\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "clobber", projectRoot: root });
                // Loop 1 publishes the exact V1 anchor into the model's log.
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200, "the V1 READ completed before the anti-clobber exercise");

                // The file changes out-of-band between turns.
                await writeFile(join(root, "doc.md"), "V2 ambient change\n");

                // Loop 2 reconciles V2 before the model attempts its V1-anchored edit.
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit it" });
                assert.equal(second.result.status, 200, "the stale EDIT was exercised and the model concluded normally");
                assert.equal(second.modelSessionId, first.modelSessionId, "both loops use the same session memory");
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({
                    session_id: second.modelSessionId!,
                });
                const rejected = rows.find(({ op, status_rx }) => op === "EDIT" && status_rx === 409);
                assert.equal(
                    JSON.parse(rejected?.rx ?? "null")?.problem?.type,
                    "https://problems.plurnk.xyz/engine/edit/edit-collision",
                    "the stale anchor produces the exact edit-collision result before any proposal",
                );

                const onDisk = await readFile(join(root, "doc.md"), "utf8");
                assert.match(onDisk, /V2 ambient change/, "the ambient on-disk change survives — the stale auto EDIT was rejected, never written");
                assert.doesNotMatch(onDisk, /V3 model clobber/, "the model's stale V3 EDIT did NOT reach disk (no silent clobber)");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("edit-pattern", () => {
// {§edit-pattern} — a pattern on an EDIT replaces each matching span, within its line, with the
// literal body; every touched line's anchor guards the batch. Zero matches change nothing.










const setup = async (content = "alpha foo\nfoo bar foo\nbeta\nfoo", pathname = "/notes.md") => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await new Workspace().edit(editStmt(urlPath("workspace", pathname), content), makeSchemeCtx({ db, workspaceId: env.workspaceId, sessionId: env.sessionId }));
    let sequence = 0;
    const dispatch = (statement: EditStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    const body = async () => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname, name: "body" }))?.content;
    return { db, dispatch, body };
};

const target = urlPath("workspace", "/notes.md");
const regex = (pattern: string, flags = ""): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/${flags}`, pattern, flags });

test("{§edit-pattern} selection runs on canonical source, including its original line separators", async () => {
    const { db, dispatch, body } = await setup("before\r\nneedle\r\nafter");
    try {
        const result = await dispatch(editStmt(target, " / ", null, regex("\\r\\n")));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.matched, 2);
        assert.equal(await body(), "before / needle / after");
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} authored insertion uses the source's separator, not its READ presentation", async () => {
    const { db, dispatch, body } = await setup("before\r\nafter");
    try {
        const result = await dispatch(editStmt(target, "inserted", { marks: [2, 1, 2, 1] }));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(await body(), "before\r\ninserted\r\nafter");
    } finally { await db.close(); }
});

test("{§edit-pattern} pattern replacement preserves the body's literal line endings", async () => {
    const { db, dispatch, body } = await setup("before\r\nneedle\r\nafter");
    try {
        const result = await dispatch(editStmt(target, "first\r\nsecond\rthird", null, regex("needle")));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(await body(), "before\r\nfirst\r\nsecond\rthird\r\nafter");
    } finally { await db.close(); }
});

test("{§edit-pattern} a literal pattern replaces every occurrence on every line with the literal body", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "baz", null, { dialect: "glob", raw: "foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4, "every occurrence counts, two on one line included");
        assert.equal(await body(), "alpha baz\nbaz bar baz\nbeta\nbaz");
        const receipt = r.receipt as { effect: { requested: string } };
        assert.equal(receipt.effect.requested, "<1,7,1,10>", "the receipt is the first span's coordinate edit");
        assert.equal((r.last as { requested: string }).requested, "<4,1,4,4>", "and the last span rides beside it");
    } finally { await db.close(); }
});

test("{§edit-pattern} a regex pattern replaces its spans; the body is literal, never a template", async () => {
    const { db, dispatch, body } = await setup("id: 12\nid: 345\nname: x");
    try {
        const r = await dispatch(editStmt(target, "$1-<0>", null, regex("\\d+")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 2);
        assert.equal(await body(), "id: $1-<0>\nid: $1-<0>\nname: x");
    } finally { await db.close(); }
});

test("{§edit-pattern} a scope bounds the lines a pattern may touch; a glob with metacharacters replaces whole lines", async () => {
    const { db, dispatch, body } = await setup("keep\nold value\nold thing\nkeep");
    try {
        const r = await dispatch(editStmt(target, "new", { marks: [2] }, { dialect: "glob", raw: "old*" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "keep\nnew\nold thing\nkeep");
    } finally { await db.close(); }
});

test("{§edit-pattern} zero matches change nothing and answer 204 with matched 0", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "baz", null, { dialect: "glob", raw: "absent" }));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(await body(), "alpha foo\nfoo bar foo\nbeta\nfoo");
    } finally { await db.close(); }
});

test("{§edit-pattern} an empty body deletes the matched spans and leaves the lines", async () => {
    const { db, dispatch, body } = await setup("a foo b\nfoo");
    try {
        const r = await dispatch(editStmt(target, "", null, { dialect: "glob", raw: "foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(await body(), "a  b\n", "spans go, lines stay");
    } finally { await db.close(); }
});

test("{§edit-pattern} a regex pattern replaces its exact region across a line break", async () => {
    const { db, dispatch, body } = await setup("one\ntwo");
    try {
        const r = await dispatch(editStmt(target, "x", null, regex("one\\ntwo")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "x");
    } finally { await db.close(); }
});

test("{§edit-pattern} a node-selecting pattern replaces each node's whole region, across lines", async () => {
    const xml = "<books>\n  <book>\n    <title>A</title>\n    <price>40</price>\n  </book>\n  <book>\n    <title>B</title>\n    <price>10</price>\n  </book>\n</books>";
    const { db, dispatch, body } = await setup(xml, "/books.xml");
    try {
        const r = await dispatch(editStmt(urlPath("workspace", "/books.xml"), "<book/>", null, { dialect: "xpath", raw: "//book[price > 35]" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "<books>\n  <book/>\n  <book>\n    <title>B</title>\n    <price>10</price>\n  </book>\n</books>", "surrounding indentation is not part of the element");
    } finally { await db.close(); }
});

test("{§edit-pattern} a jsonpath pattern with an empty body removes the selected nodes' text", async () => {
    const { db, dispatch, body } = await setup('{"items": [\n  {"name": "a", "price": 10},\n  {"name": "b", "price": 50}\n]}', "/data.json");
    try {
        const r = await dispatch(editStmt(urlPath("workspace", "/data.json"), "", null, { dialect: "jsonpath", raw: "$.items[?(@.price > 20)]" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), '{"items": [\n  {"name": "a", "price": 10},\n  \n]}');
    } finally { await db.close(); }
});

test("{§edit-pattern} a full-text pattern replaces SQLite's located token occurrences", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "x", null, { dialect: "fts", raw: "~foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4);
        assert.equal(await body(), "alpha x\nx bar x\nbeta\nx");
    } finally { await db.close(); }
});

for (const matcher of [{ dialect: "glob", raw: "foo" }, regex("foo"), { dialect: "fts", raw: "~foo" }] as const) {
    test(`{§edit-pattern} a four-coordinate scope bounds ${matcher.dialect} EDIT without broadening to the line`, async () => {
        const { db, dispatch, body } = await setup("foo foo foo");
        try {
            const r = await dispatch(editStmt(target, "bar", { marks: [1, 5, 1, 8] }, matcher));
            assert.equal(r.status, 200, JSON.stringify(r));
            assert.equal(r.matched, 1);
            assert.equal(await body(), "foo bar foo");
        } finally { await db.close(); }
    });
}

test("{§edit-pattern} a pattern on an existing empty entry is a no-match, not a missing resource", async () => {
    const { db, dispatch, body } = await setup("");
    try {
        const r = await dispatch(editStmt(target, "x", null, regex("foo")));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(await body(), "");
    } finally { await db.close(); }
});

// {§edit-pattern} {§channel-selection} — a regex splices the source channel's own coordinates: on
// HTML the markup, never the readable projection beside it.
test("{§edit-pattern} a regex pattern edits HTML source coordinates; the readable projection follows", async () => {
    const { db, dispatch, body } = await setup("<html>\n  <body>\n    <h1>Team Roster</h1>\n  </body>\n</html>", "/users.html");
    try {
        const r = await dispatch(editStmt(urlPath("workspace", "/users.html"), "<h2>Roster</h2>", null, { dialect: "regex", raw: "/<h1>.*<\\/h1>/", pattern: "<h1>.*<\\/h1>", flags: "" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "<html>\n  <body>\n    <h2>Roster</h2>\n  </body>\n</html>");
        const projection = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/users.html", name: "readable" });
        assert.match(String(projection?.content), /Roster/, "the derived projection followed the source write");
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} a multi-span pattern receipt renders as a packet row: both boundaries, every line framed", async () => {
    const { db, dispatch, body } = await setup("alpha\nbeta\ngamma\ndelta");
    try {
        const r = await dispatch(editStmt(target, "A", null, regex("a$", "gm")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4);
        assert.equal(await body(), "alphA\nbetA\ngammA\ndeltA");
        assert.ok("last" in r, "several spans: the receipt carries the last boundary beside the first");
        const entry = { coordinate: "1/1/1", origin: "model", op: "EDIT", status: 200, folded: [], target: { scheme: "workspace", pathname: "/notes.md" }, tx: { body: "A" }, rx: r };
        // The next packet renders this row; a body with an unframed line is a 500 on the whole loop.
        const rendered = PacketWire.renderLog([entry], (s: string) => Math.ceil(s.length / 4));
        assert.match(rendered, /alphA/u);
        assert.match(rendered, /deltA/u);
        assert.doesNotMatch(rendered, /\n\n *[1-9]\d*<@/u, "no blank line inside the receipt body");
    } finally { await db.close(); }
});
});

describe("floor-scope-capstone", () => {
// Floor-scope capstone — drives the non-execution entry DSL ops end-to-end through the
// canonical grammar parser, real Engine, real SchemeRegistry, real SqlRite.











const parse = (dsl: string): PlurnkStatement[] => {
    const result = PlurnkParser.parseStatements(dsl, { executors: fixtureExecutors(dsl) });
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => i.statement);
};

test("{§edit} Floor-scope capstone: full DSL surface exercised end-to-end", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, "capstone-ws", { producer: "client" });
    // FIND body matchers run content through the mimetypes framework,
    // so the end-to-end engine needs a real (discovering) Mimetypes — same as the
    // daemon wires in production; the bare default has no handlers.
    await DEFAULT_MIMETYPES.ready();
    const schemes = new SchemeRegistry();
    schemes.register("fixture", new EntryScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });

    const dispatch = async (statement: PlurnkStatement, sequence: number) =>
        engine.dispatch({ statement, ...env, sequence, origin: "client" });

    try {
        const [editQuestion] = parse("````EDIT (workspace:///france/capital)\nwhat is the capital of france?\n````");
        const r1 = await dispatch(editQuestion, 1);
        assert.equal(r1.status, 201);
        const questionEntryId = r1.entryId as number;
        assert.ok(typeof questionEntryId === "number");

        const channels1 = await db.test_list_channel_names.all<{ name: string }>({ entry_id: questionEntryId });
        assert.deepEqual(channels1.map((c) => c.name), ["body"]);

        // {§edit} — the entry already exists (created above), so
        // the re-edit needs a marker; <1,-1> states the deliberate full rewrite.
        const [editQuestionAgain] = parse("````EDIT (workspace:///france/capital) <1,-1>\nrephrased question\n````");
        const r2 = await dispatch(editQuestionAgain, 2);
        assert.equal(r2.status, 200);
        assert.equal(r2.entryId, questionEntryId);
        const body2 = (await db.test_get_channel.get<{ content: string }>({ entry_id: questionEntryId, name: "body" }))?.content;
        assert.equal(body2, "rephrased question");

        const [copyOp] = parse("````COPY (workspace:///france/capital) (fixture:///france/capital)````");
        const r3 = await dispatch(copyOp, 3);
        assert.equal(r3.status, 201);

        const skillEntry = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "fixture", pathname: "/france/capital" });
        const skillEntryId = skillEntry!.id;

        // The COPY above already created this entry, so the edit needs a marker too.
        const [editSkill] = parse("````EDIT (fixture:///france/capital) <1,-1>\nParis\n````");
        const r4 = await dispatch(editSkill, 4);
        assert.equal(r4.status, 200);
        const skillBody = (await db.test_get_channel.get<{ content: string }>({ entry_id: skillEntryId, name: "body" }))?.content;
        assert.equal(skillBody, "Paris");

        const [classifiedFind] = parse("````FIND (fixture:///)````");
        const r6 = await dispatch(classifiedFind, 5);
        assert.equal(r6.status, 200);
        assert.deepEqual((r6.results as Array<[{ path: string }]>).map(([resource]) => resource.path), ["fixture:///france/capital"]);

        // glob body matches CONTENT (the entry's body is "Paris"), not the pathname.
        const [findByGlob] = parse("````FIND (fixture:///) Paris*````");
        const r7 = await dispatch(findByGlob, 6);
        assert.equal(r7.status, 200);
        assert.deepEqual((r7.results as Array<[{ path: string }]>).map(([resource]) => resource.path), ["fixture:///france/capital"]);

        const [moveOp] = parse("````MOVE (workspace:///france/capital) (workspace:///archive/france/capital)````");
        const r10 = await dispatch(moveOp, 9);
        assert.equal(r10.status, 201);
        const oldGone = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname: "/france/capital" });
        assert.equal(oldGone, undefined);
        const archive = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname: "/archive/france/capital" });
        const archiveBody = (await db.test_get_channel.get<{ content: string }>({ entry_id: archive?.id, name: "body" }))?.content;
        assert.equal(archiveBody, "rephrased question"); // the commons original — Paris lives on the skill copy

        const [deleteOp] = parse("````KILL (fixture:///france/capital)````");
        const r11 = await dispatch(deleteOp, 10);
        assert.equal(r11.status, 200);
        const skillGone = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "fixture", pathname: "/france/capital" });
        assert.equal(skillGone, undefined);

        const [send] = parse("````SEND\nanswer delivered\n````");
        const r12 = await engine.executeAdmittedTurn({ ...env, statements: [send], source: null, emission: null, fromSequence: 11, origin: "client" });
        assert.equal(r12.status, 200);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: env.loopId }))?.status, 102, "delivering a message does not complete work");

        const allEntries = (await db.test_list_entries_by_workspace_workspace_pathname.all<{ scheme: string; pathname: string }>({ workspace_id: env.workspaceId })).map((r) => ({ scheme: r.scheme, pathname: r.pathname }));
        assert.deepEqual(allEntries, [{ scheme: "workspace", pathname: "/archive/france/capital" }]);

        const logCount = (await db.test_count_log_entries_by_session.get<{ n: number }>({ session_id: env.sessionId }))?.n;
        assert.equal(logCount, 9);

        const clientLogCount = (await db.test_count_log_entries_session_origin.get<{ n: number }>({ session_id: env.sessionId, origin: "client" }))?.n;
        assert.equal(clientLogCount, 9);
    } finally { await db.close(); }
});
});

describe("op-uri-contract", () => {
// Operation semantics coverage matrix: how each entry op resolves a model-typed path and how
// matchers render.
//
// {§fs-namespace} Every operation resolves filesystem spellings to project-relative keys.

















const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    readThroughScheme("file", null, statement, ctx);

// Parse one op the way production does, so a bare path carries its REAL parsed shape
// (LocalPath {kind:"local"}) — the exact thing the model emits, not a hand-built UrlPath.
const parseOp = <T extends PlurnkStatement>(dsl: string, op: T["op"]): T => {
    const found = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find((i) => i.kind === "statement" && i.statement.op === op);
    if (found === undefined) throw new Error(`no ${op} parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: T }).statement;
};

// Materialize a file as a readable member — mirrors the git-membership pass: disk
// content into the entry's body channel under its project-relative key.
const addMember = async (ctx: PlurnkSchemeContext, pathname: string): Promise<void> => {
    if (ctx.mimetypes === undefined) throw new Error("addMember: ctx.mimetypes required");
    const row = await ctx.db.envelope_get_workspace.get<{ project_root: string }>({ id: ctx.workspaceId });
    assert.ok(row?.project_root);
    await MembershipMaterialization.materializeMember(pathname, row.project_root, ctx, new Map());
};

const withWorkspaceRoot = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-uri-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `uri-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// ── Path resolution: every op normalizes a bare model path to the canonical member key ──

// CELL [FIND × bare local path]. The member is stored `/notes.md`; the model FINDs
// `notes.md`. FIND must canonicalize and select the member — exactly as READ does.
test("{§fs-namespace} contract: FIND(bare path) resolves the canonical-stored member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("````FIND (notes.md)````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200, "FIND succeeds");
        assert.ok(resourcePaths(result).includes("notes.md"), `FIND must find the member (catalog renders it bare: notes.md); got: ${JSON.stringify(resourcePaths(result))}`);
    });
});

// CONTROL [READ × bare local path]. Same condition — proves the harness reproduces the real path.
test("{§fs-namespace} contract: READ(bare path) resolves the canonical-stored member (control)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<ReadStatement>("````READ (notes.md)````", "READ");
        const result = await readFileScheme(stmt, ctx);
        assert.equal(result.status, 200, "READ canonicalizes the bare path and resolves the member");
        assert.match(result.content ?? "", /phoenix/, "READ returns the member content");
    });
});

// CONTROL [EDIT × bare local path]. EDIT canonicalizes (#resolveTarget) — a bare
// path resolves to the member and proposes (202).
test("{§edit} contract: EDIT(bare path) resolves the canonical-stored member and proposes (control)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        // {§edit} — notes.md already exists; <1,-1> states the rewrite.
        const stmt = parseOp<ResolvedEditStatement>("````EDIT (notes.md) <1,-1>\nthe codename is dragon\n````", "EDIT");
        const result = await new File().edit(stmt, ctx);
        assert.equal(result.status, 202, `EDIT canonicalizes the bare path → proposal; got ${result.status} ${result.problem?.detail ?? ""}`);
    });
});

test("{§fs-namespace} FIND of an absolute path resolves the member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>(PlurnkParser.frame(`FIND (${join(root, "notes.md")})`, null), "FIND");
        const result = await new File().find(stmt, ctx);
        assert.ok(resourcePaths(result).includes("notes.md"), `the leading-slash form finds it; got: ${JSON.stringify(resourcePaths(result))}`);
    });
});

// {§find-result-projection}: exact matcher FIND exposes navigation locations.

test("{§fs-namespace} an exact regex FIND returns its flat match location", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "heading\nthe codename is phoenix\ncontext\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("````FIND (notes.md) /phoenix/````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

test("{§fs-namespace} contract: an exact FIND returns every match as a flat location", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "log.md"), "alpha\ntarget one\nbeta\ngamma\ntarget two\n");
        await addMember(ctx, "log.md");
        const stmt = parseOp<FindStatement>("````FIND (log.md) *target*````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

test("{§path-syntax} contract: an exact jsonpath FIND returns flat structural locations", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "config.json"), '{\n  "host": "db.internal",\n  "pool": 5\n}\n');
        await addMember(ctx, "config.json");
        const stmt = parseOp<FindStatement>("````FIND (config.json) $.host````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

// CELL [FIND × file scheme glob] — the recursive tracked-file list. Confirm the explicit
// file URI and bare project-relative form expose the same view ({§path-syntax}).
test("{§fs-namespace} explicit file URI and bare FIND globs list the same members", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "a.md"), "alpha");
        await mkdir(join(root, "docs"), { recursive: true });
        await writeFile(join(root, "docs/b.md"), "beta");
        await addMember(ctx, "a.md");
        await addMember(ctx, "docs/b.md");
        for (const dsl of [PlurnkParser.frame(`FIND (file://${root}/**)`, null), "````FIND (**)````"]) {
            const r = await new File().find(parseOp<FindStatement>(dsl, "FIND"), ctx);
            assert.equal(r.status, 200, `${dsl} → 200`);
            assert.equal(r.results.length, 2, `${dsl} lists both tracked members`);
            const paths = resourcePaths(r).join(" ");
            assert.match(paths, /a\.md/, `${dsl} includes a.md`);
            assert.match(paths, /b\.md/, `${dsl} includes docs/b.md`);
        }
    });
});

test("{§fs-namespace} contract: bare FIND(*) is a shallow project map; FIND(**) is recursive", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, ".env.defaults"), "defaults");
        await mkdir(join(root, ".github"), { recursive: true });
        await writeFile(join(root, ".github/settings.yml"), "settings");
        await writeFile(join(root, "README.md"), "root");
        await mkdir(join(root, "src", "nested"), { recursive: true });
        await writeFile(join(root, "src/index.ts"), "direct");
        await writeFile(join(root, "src/nested/deep.ts"), "deep");
        for (const path of [".env.defaults", ".github/settings.yml", "README.md", "src/index.ts", "src/nested/deep.ts"]) await addMember(ctx, path);

        const shallow = await new File().find(parseOp<FindStatement>("````FIND (*)````", "FIND"), ctx);
        assert.deepEqual(resourcePaths(shallow), [".env.defaults", ".github/**", "README.md", "src/**"]);
        const scope = resourceGroups(shallow).find(([item]) => item.path === "src/**")?.[0];
        assert.ok(scope !== undefined && "items" in scope);
        assert.equal(scope.items, 2);

        const recursive = await new File().find(parseOp<FindStatement>("````FIND (**)````", "FIND"), ctx);
        assert.deepEqual(resourcePaths(recursive), [".env.defaults", ".github/settings.yml", "README.md", "src/index.ts", "src/nested/deep.ts"]);
    });
});

test("{§fs-namespace} directory and glob searches from filesystem ancestors retain only workspace members", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/a.ts"), "a");
        await addMember(ctx, "src/a.ts");

        await writeFile(join(root, "hidden.txt"), "not a member");
        for (const target of [".", root, `${root}/`, "file:///", "/", "../", "../../**", `${root}/../**/*.ts`]) {
            const result = await new File().find(parseOp<FindStatement>(PlurnkParser.frame(`FIND (${target})`, null), "FIND"), ctx);
            assert.equal(result.status, 200, target);
            assert.deepEqual(resourcePaths(result), ["src/a.ts"], target);
        }
    });
});
});

describe("pattern-contract", () => {
const TEXT = "spare\none needle end\nspare\nneedle";
const TEXT_LINES = [2, 4];

const cases = [
    { name: "literal", extension: "txt", pattern: "needle", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "glob", extension: "txt", pattern: "*needle*", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "extglob", extension: "txt", pattern: "@(one needle end|needle)", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "brace glob", extension: "txt", pattern: "{one needle end,needle}", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "regex", extension: "txt", pattern: "/needle/", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "full-text", extension: "txt", pattern: "~needle", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "XPath", extension: "xml", pattern: "//item", content: "<root>\n<item>needle</item>\n<other/>\n<item>needle</item>\n</root>", lines: TEXT_LINES, edited: "<root>\nreplacement\n<other/>\nreplacement\n</root>", copied: "<item>needle</item><item>needle</item>", removed: "<root>\n\n<other/>\n\n</root>" },
    { name: "JSONPath", extension: "json", pattern: '$[?(@ == "needle")]', content: '[\n"needle",\n"spare",\n"needle"\n]', lines: TEXT_LINES, edited: '[\nreplacement,\n"spare",\nreplacement\n]', copied: '"needle""needle"', removed: '[\n,\n"spare",\n\n]' },
    { name: "graph definition", extension: "js", pattern: "&needle", content: "function needle() {}\nconst spare = 2;", lines: [1], edited: "replacement\nconst spare = 2;", copied: "function needle() {}", removed: "\nconst spare = 2;" },
    { name: "graph reference", extension: "js", pattern: "&<needle", content: "const value = needle(input); record(value);", lines: [1], edited: "const value = replacement(input); record(value);", copied: "needle", removed: "const value = (input); record(value);" },
    { name: "inline XPath element", extension: "xml", pattern: "//item", content: "<root><item>A</item><other>B</other></root>", lines: [1], edited: "<root>replacement<other>B</other></root>", copied: "<item>A</item>", removed: "<root><other>B</other></root>" },
    { name: "inline XPath text", extension: "xml", pattern: "//item/text()", content: "<root><item>A</item><other>B</other></root>", lines: [1], edited: "<root><item>replacement</item><other>B</other></root>", copied: "A", removed: "<root><item></item><other>B</other></root>" },
    { name: "JSON member value", extension: "json", pattern: "$.host", content: '{"host":"old","port":80}', lines: [1], edited: '{"host":replacement,"port":80}', copied: '"old"', removed: '{"host":,"port":80}' },
    { name: "XPath attribute", extension: "xml", pattern: "//item/@id", content: '<item id="old" class="other"/>', lines: [1], edited: '<item replacement class="other"/>', copied: 'id="old"', removed: '<item  class="other"/>' },
    { name: "XPath entity text", extension: "xml", pattern: "//item/text()", content: '<item>A &amp; B</item>', lines: [1], edited: '<item>replacement</item>', copied: 'A &amp; B', removed: '<item></item>' },
    { name: "HTML attribute", extension: "html", pattern: "//input/@value", content: '<input value="old"><p>stay</p>', lines: [1], edited: '<input replacement><p>stay</p>', copied: 'value="old"', removed: '<input ><p>stay</p>' },
    { name: "CSV cell", extension: "csv", pattern: "$[0].name", content: 'name,age\n"old",42', lines: [2], edited: 'name,age\nreplacement,42', copied: '"old"', removed: 'name,age\n,42' },
    { name: "INI value", extension: "ini", pattern: "$.main.name", content: '[main]\nname = old', lines: [2], edited: '[main]\nname = replacement', copied: 'old', removed: '[main]\nname = ' },
    { name: "dotenv value", extension: "env", pattern: "$.NAME", content: 'NAME="old" # keep', lines: [1], edited: 'NAME=replacement # keep', copied: '"old"', removed: 'NAME= # keep' },
    { name: "JSONL value", extension: "jsonl", pattern: "$[1].name", content: '{"name":"first"}\n{"name":"old"}', lines: [2], edited: '{"name":"first"}\n{"name":replacement}', copied: '"old"', removed: '{"name":"first"}\n{"name":}' },
    { name: "Markdown block", extension: "md", pattern: "//heading", content: 'before\n\n# Title\n\nafter', lines: [3], edited: 'before\n\nreplacement\n\nafter', copied: '# Title', removed: 'before\n\n\n\nafter' },
    { name: "diff hunk", extension: "diff", pattern: "//hunk", content: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new', lines: [3, 4, 5], edited: '--- a/f\n+++ b/f\nreplacement', copied: '@@ -1 +1 @@\n-old\n+new', removed: '--- a/f\n+++ b/f\n' },
    { name: "zero-width regex", extension: "txt", pattern: "/^/", content: 'first\nsecond', lines: [1, 2], edited: 'replacementfirst\nreplacementsecond', copied: '', removed: 'first\nsecond' },
] as const;

// {§read} {§edit-pattern} {§kill-pattern} {§copy}
for (const specimen of cases) {
    for (const operation of ["FIND", "READ", "EDIT", "KILL", "COPY", "MOVE"] as const) {
        test(`{§mimetype-content-query} pattern composition: ${specimen.name} ${operation} selects the advertised content`, async () => {
            const db = await openMigrated();
            try {
                const env = await seedEnvelope(db, `patterns-${crypto.randomUUID()}`, { producer: "client" });
                const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
                const pathname = `/source.${specimen.extension}`;
                await new Workspace().edit(editStmt(urlPath("workspace", pathname), specimen.content), makeSchemeCtx({ db, ...env }));
                const source = `workspace://${pathname}`;
                const destination = "workspace:///selected.txt";
                const transfer = operation === "COPY" || operation === "MOVE";
                const findParsed = PlurnkParser.parseStatements(`\`\`\`FIND (${source}) ${specimen.pattern}\n\`\`\``);
                const findItem = findParsed.items[0];
                assert.equal(findItem?.kind, "statement");
                if (findItem?.kind !== "statement" || findItem.statement.op !== "FIND") throw new Error("Expected parsed FIND");
                const matcher = findItem.statement.matcher;
                const header = transfer
                    ? `${operation} (${source}) (${destination})`
                    : operation === "EDIT"
                        ? `${operation} (${source})`
                        : `${operation} (${source}) ${specimen.pattern}`;
                const parsed = PlurnkParser.parseStatements(`\`\`\`${header}\n${operation === "EDIT" ? "replacement\n" : ""}\`\`\``);
                assert.equal(parsed.items.length, 1, JSON.stringify(parsed));
                const [item] = parsed.items;
                assert.equal(item?.kind, "statement", JSON.stringify(parsed));
                if (item?.kind !== "statement") throw new Error("Expected one parsed operation");
                const statement = transfer && (item.statement.op === "COPY" || item.statement.op === "MOVE")
                    ? { ...item.statement, source: { ...item.statement.source, matcher } }
                    : item.statement.op === "EDIT"
                        ? { ...item.statement, matcher }
                        : item.statement;
                const result = await engine.dispatch({ ...env, statement, sequence: 1, origin: "client" });
                const body = async (path: string) => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: path, name: "body" }))?.content;
                const unchanged = operation === "KILL" && specimen.removed === specimen.content;
                assert.equal(result.status, transfer ? 201 : unchanged ? 304 : 200, JSON.stringify(result));
                const lines = specimen.content.split("\n");
                if (operation === "FIND") {
                    assert.deepEqual((result.results as { region: { startLine: number; endLine: number } }[])
                        .flatMap(({ region }) => Array.from({ length: region.endLine - region.startLine + 1 }, (_, index) => region.startLine + index)), specimen.lines);
                    assert.equal(await body(pathname), specimen.content);
                } else if (operation === "READ") {
                    assert.equal(result.content, specimen.lines.map((line) => lines[line - 1]).join("\n"));
                    assert.deepEqual(result.lineOrdinals, specimen.lines);
                    assert.equal(await body(pathname), specimen.content);
                } else if (operation === "EDIT") {
                    assert.equal(await body(pathname), specimen.edited);
                } else {
                    if (transfer) {
                        assert.equal(await body("/selected.txt"), specimen.copied);
                    }
                    assert.equal(await body(pathname), operation === "COPY" ? specimen.content : specimen.removed);
                }
            } finally {
                await db.close();
            }
        });
    }
}

for (const specimen of [
    { path: "source.md", content: "# Heading\n\nbody **strong** end", pattern: "//heading | //strong" },
    { path: "source.xml", content: "<root><item>value</item></root>", pattern: "$.type" },
]) for (const operation of ["EDIT", "KILL", "COPY", "MOVE"] as const) {
    test(`{§slice-semantics-compose-pattern} ${operation} refuses ${specimen.pattern} without partial writes`, async () => {
        const db = await openMigrated();
        try {
            const env = await seedEnvelope(db, `precision-${crypto.randomUUID()}`, { producer: "client" });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const target = `workspace:///${specimen.path}`;
            await new Workspace().edit(editStmt(urlPath("workspace", `/${specimen.path}`), specimen.content), makeSchemeCtx({ db, ...env }));
            const transfer = operation === "COPY" || operation === "MOVE";
            const findParsed = PlurnkParser.parseStatements(`\`\`\`FIND (${target}) ${specimen.pattern}\n\`\`\``);
            const findItem = findParsed.items[0];
            if (findItem?.kind !== "statement" || findItem.statement.op !== "FIND") throw new Error(JSON.stringify(findParsed));
            const matcher = findItem.statement.matcher;
            const parsed = PlurnkParser.parseStatements(`\`\`\`${operation} (${target})${transfer ? " (workspace:///destination.txt)" : ` ${specimen.pattern}`}\n${operation === "EDIT" ? "replacement\n" : ""}\`\`\``);
            assert.equal(parsed.items[0]?.kind, "statement");
            const item = parsed.items[0];
            if (item?.kind !== "statement") throw new Error(JSON.stringify(parsed));
            const statement = transfer && (item.statement.op === "COPY" || item.statement.op === "MOVE")
                ? { ...item.statement, source: { ...item.statement.source, matcher } }
                : item.statement;
            const result = await engine.dispatch({ ...env, statement, sequence: 1, origin: "client" });
            assert.equal(result.status, 422, JSON.stringify(result));
            assert.match(String(result.problem?.type), /\/pattern-source-unlocated$/);
            const source = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: `/${specimen.path}`, name: "body" });
            assert.equal(source?.content, specimen.content);
            assert.equal(await db.test_get_channel_by_pathname.get({ pathname: "/destination.txt", name: "body" }), undefined);
        } finally { await db.close(); }
    });
}
});

describe("pattern-dialects", () => {
// {§mimetype-query} {§find} — the pattern feature end to end, as the model
// drives it: one seeded corpus (markdown, JSON, XML, text), then one FIND per dialect and
// per cross-mapping, every answer read back from the dispatched rows. Regex carries its
// `matched` text, xpath selects markdown headings by level and by text, jsonpath walks the
// markdown deep tree, the universal mapping runs xpath over JSON and jsonpath over XML,
// an empty selection is 204, and an unbound xpath prefix is a 400 that names its dialect.





const GUIDE = "# Project\n\nIntro line.\n\n## Build\n\nRun npm ci.\nThen npm test.\n\n## Testing\n\nUse node --test.\n\n## Style\n\nDouble quotes.";
const CONFIG = "{\"items\":[{\"name\":\"alpha\",\"size\":3},{\"name\":\"beta\",\"size\":7}],\"host\":\"db.internal\"}";
const FEED = "<feed><item id=\"1\">alpha</item><item id=\"2\">beta</item></feed>";
const NOTES = "alpha line\nbeta line\nGAMMA line";

type Probe = { target: string; pattern: string; expect: (rx: string, status: number) => void };

const locations = (rx: string): number => {
    const m = /"matchLocationCount":(\d+)/.exec(rx);
    assert.ok(m, `matchLocationCount missing in ${rx.slice(0, 200)}`);
    return Number(m[1]);
};

const PROBES: Probe[] = [
    { target: "workspace:///notes.txt", pattern: "/^beta/m", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"beta"/, "regex carries the matched text");
        assert.equal(locations(rx), 1);
    } },
    { target: "workspace:///notes.txt", pattern: "/gamma/i", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"GAMMA"/, "regex flags apply");
    } },
    { target: "workspace:///notes.txt", pattern: "alpha*", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"alpha line"/, "glob matches the whole line");
    } },
    { target: "workspace:///notes.txt", pattern: "/zeta/", expect: (_rx, status) => {
        assert.equal(status, 204, "no selection is 204");
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[@level='2']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 3, "three level-2 headings");
        assert.match(rx, /"startLine":5/);
        assert.match(rx, /"startLine":10/);
        assert.match(rx, /"startLine":14/);
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[text='Testing']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1);
        assert.match(rx, /"startLine":10/, "the heading's own line is the location");
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[@pk:level='1']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1, "the provenance prefix is bound");
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[@zz:level='2']", expect: (rx, status) => {
        assert.equal(status, 400, rx.slice(0, 200));
        assert.match(rx, /xpath/, "the refusal names the dialect");
    } },
    { target: "workspace:///docs/guide.md", pattern: "$..[?(@.type=='heading' && @.level==2)]", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 3, "jsonpath walks the markdown deep tree");
        assert.match(rx, /"locator":"\$\['children'\]\[8\]","region":\{"startLine":10/, "a structural row keeps its locator and the heading's line");
    } },
    { target: "workspace:///data/config.json", pattern: "$.items[*].name", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2);
        assert.match(rx, /"locator":"\$\['items'\]\[0\]\['name'\]","region":\{"startLine":1,"startColumn":19,"endLine":1,"endColumn":26\}/, "exact columns of the first value");
        assert.match(rx, /"locator":"\$\['items'\]\[1\]\['name'\]"/);
    } },
    { target: "workspace:///data/config.json", pattern: "//items/name", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2, "xpath over JSON through the deep-xml projection");
        assert.match(rx, /"locator":"\(\/\/items\/name\)\[1\]","region":\{"startLine":1,"startColumn":19,"endLine":1,"endColumn":26\}/, "xpath rows carry the same exact columns as jsonpath rows");
        assert.match(rx, /"locator":"\(\/\/items\/name\)\[2\]","region":\{"startLine":1,"startColumn":45,"endLine":1,"endColumn":51\}/);
    } },
    { target: "workspace:///data/feed.xml", pattern: "//item[@id='2']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1);
        assert.match(rx, /"locator":"\/\/item\[@id='2'\]"/, "xpath over XML keeps its locator");
    } },
    { target: "workspace:///docs/guide.md", pattern: "&Project", expect: (rx, status) => {
        assert.notEqual(status, 503, `a graph FIND settles the index instead of refusing: ${rx.slice(0, 200)}`);
        assert.ok(status === 200 || status === 204, `graph FIND answers, got ${status}`);
    } },
    { target: "workspace:///data/feed.xml", pattern: "$..id", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2, "jsonpath over XML through the deep-json projection (attributes are keys)");
    } },
];

test("{§mimetype-query}: every pattern dialect answers the model from one seeded corpus", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const seed = [
        `\`\`\`\`EDIT (workspace:///docs/guide.md)
${GUIDE}
\`\`\`\``,
        `\`\`\`\`EDIT (workspace:///data/config.json)
${CONFIG}
\`\`\`\``,
        `\`\`\`\`EDIT (workspace:///data/feed.xml)
${FEED}
\`\`\`\``,
        `\`\`\`\`EDIT (workspace:///notes.txt)
${NOTES}
\`\`\`\``,
    ].join("\n\n");
    const finds = PROBES.map(({ target, pattern }) => `\`\`\`\`FIND (${target}) ${pattern}\`\`\`\``).join("\n\n");
    const mock = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse(`${seed}

\`\`\`\`NOTE
seeded
\`\`\`\``, 10),
        makeMockResponse(`${finds}

\`\`\`\`NOTE
searched
\`\`\`\``, 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "pattern-dialects" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go" });
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string; rx: string }>({ loop_id: loopId });
            const edits = rows.filter((r) => r.op === "EDIT" && r.origin === "model");
            assert.deepEqual(edits.map((r) => r.status_rx), [201, 201, 201, 201], "the corpus seeded");
            const findRows = rows.filter((r) => r.op === "FIND" && r.origin === "model");
            assert.equal(findRows.length, PROBES.length, "one dispatched row per FIND");
            for (const [index, probe] of PROBES.entries()) {
                const row = findRows[index];
                const tx = JSON.parse(row.tx) as { target?: { raw?: string }; matcher?: { raw?: string } };
                assert.equal(tx.target?.raw, probe.target, `probe ${index + 1} target`);
                assert.equal(tx.matcher?.raw, probe.pattern, `probe ${index + 1} pattern`);
                probe.expect(row.rx, row.status_rx);
            }
            assert.equal(finalStatus, 200);
        } finally { ws.close(); }
    });
});
});
