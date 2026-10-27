import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Session from "../../src/schemes/Session.ts";
import Fork from "../../src/core/fork.ts";
import NativeContent from "../../src/core/NativeContent.ts";
import File from "../../src/schemes/File.ts";
import ByteView from "../../src/content/byte-view.ts";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import ReadResolve from "../../src/content/read-resolve.ts";
import LogVisibility from "../../src/core/LogVisibility.ts";
import { type LineMarker, type MatcherBody, type ParsedPath, type ReadStatement, type FindStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, Results, type SchemeHandler } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, insertOperationTurn, rootWorkspace, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx, DEFAULT_MIMETYPES, schemeManifest } from "./_scheme.ts";
import { Mimetypes, TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { contentWeight } from "../../src/core/content-weight.ts";
import { type AnchoredReadResult } from "../../src/content/read-projector.ts";
import { editStmt, readStmt, urlPath, copyStmt, findStmt, regex } from "./_dsl.ts";
import { fixtureExecutors, userText } from "./_mock.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { Mock, chatMessageText, type InputModality, ProviderError, type ChatMessage, type MockResponse } from "@plurnk/plurnk-providers";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import { viableWindow } from "./_provider.ts";
import { connect, rpcCall, waitForDb, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { pathToFileURL } from "node:url";
import { type Db } from "../../src/core/Db.ts";
import { RESULT_EXCEEDS_BUDGET } from "../../src/core/ContextFit.ts";
import { buildPdf } from "../../../plurnk-mimetypes-application-pdf/test/buildPdf.ts";
import { McpServer, createMcpHandler, fromJsonSchema, type ContentBlock } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";
import { namedModelSession } from "./_sessions.ts";
import { editReceipt, projectEditReceipt } from "../../src/content/edit-receipt.ts";
import { parseLogRecords } from "../LogRecords.ts";

describe("Session.read", () => {
const fullReplace: LineMarker = { marks: [1, -1] };
const editStatement = (opts: { target: ParsedPath; body?: string | null; lineMarker?: LineMarker | null }): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: opts.target,
    lineMarker: opts.lineMarker ?? null,
    matcher: null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: {
    target?: ParsedPath | null; lineMarker?: LineMarker | null;
}): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const findStatement = (opts: {
    target?: ParsedPath | null; matcher?: MatcherBody | null; lineMarker?: LineMarker | null;
}): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    matcher: opts.matcher ?? null, body: null,
    position: { line: 1, column: 1 },
});

const setupContext = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

test("{§read} Session.read: existing entry — returns body content and mimetype with status 200", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/france/capital"), body: "Paris" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/france/capital") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("{§read} Session.read: nonexistent path returns 404 with null content/mimetype", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/nope") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("{§operation-results} Session.read: null path returns 400", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const result = await readThroughScheme("workspace", null, readStatement({ target: null }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 400);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("{§read} Session.read: lineMarker <N> on text source returns raw line + text/markdown mimetype", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/lined"), body: "first\nsecond\nthird" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/lined"), lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "second");
        assert.equal((result as { startLine?: number }).startLine, 2);
        // <L> on a textual source returns the text primitive.
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("{§zero-width-column-one-insert} Session.read: four-coordinate scope returns an exact Unicode text region", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({
                target: urlPath("workspace", "/exact"),
                body: "a😀b\nsecond",
            }),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        const result = await readThroughScheme("workspace", null,
            readStatement({
                target: urlPath("workspace", "/exact"),
                lineMarker: { marks: [1, 2, 1, 3] },
            }),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.content, "😀");
        assert.equal(result.startLine, 1);
        assert.deepEqual(result.region, {
            startLine: 1,
            startColumn: 2,
            endLine: 1,
            endColumn: 3,
        });
    } finally { db.close(); }
});

test("{§find-result-projection} Session.find: exact regex matcher returns flat locations", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/match"), body: "alpha beta alpha gamma" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const matcher: MatcherBody = { dialect: "regex", raw: "/alpha/g", pattern: "alpha", flags: "g" };
        const result = await k.find(findStatement({ target: urlPath("workspace", "/match"), matcher }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("{§find-result-projection} Session.find: exact glob matcher returns flat match locations", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/g"), body: "TODO: one\nhello\nTODO: two\nworld" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const matcher: MatcherBody = { dialect: "glob", raw: "TODO*" };
        const result = await k.find(findStatement({ target: urlPath("workspace", "/g"), matcher }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("{§edit} Session.read: edited entry round-trips through read — content matches what edit wrote", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        const bodies = ["first", "second", "third"];
        const target = urlPath("workspace", "/rt");
        for (const [i, body] of bodies.entries()) {
            // First iteration creates (markerless); the rest re-edit an existing entry, which
            // needs the deliberate full-replace marker ({§edit}).
            await k.edit(editStatement({ target, body, lineMarker: i === 0 ? null : fullReplace }), makeSchemeCtx({ db, workspaceId, sessionId }));
            const result = await readThroughScheme("workspace", null, readStatement({ target }), makeSchemeCtx({ db, workspaceId, sessionId }));
            assert.equal(result.status, 200);
            assert.equal(result.content, body);
        }
    } finally { db.close(); }
});



test("{§execution-output-identity} Session.read: different workspaces see different entries at the same path", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-readiso-a");
        const workspaceB = await insertWorkspace(db, "ws-readiso-b");
        const sessionA = await insertSession(db, workspaceA);
        const sessionB = await insertSession(db, workspaceB);
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/x"), body: "from-A" }), makeSchemeCtx({ db, workspaceId: workspaceA, sessionId: sessionA }));
        await k.edit(editStatement({ target: urlPath("workspace", "/x"), body: "from-B" }), makeSchemeCtx({ db, workspaceId: workspaceB, sessionId: sessionB }));
        const a = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceA, sessionId: sessionA }));
        const b = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceB, sessionId: sessionB }));
        assert.equal(a.content, "from-A");
        assert.equal(b.content, "from-B");
    } finally { db.close(); }
});

test("{§execution-output-identity} Session.read: read against workspace A doesn't surface workspace B's entry", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-rd-a");
        const workspaceB = await insertWorkspace(db, "ws-rd-b");
        const sessionA = await insertSession(db, workspaceA);
        const sessionB = await insertSession(db, workspaceB);
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/only-b"), body: "B-only" }), makeSchemeCtx({ db, workspaceId: workspaceB, sessionId: sessionB }));
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/only-b") }), makeSchemeCtx({ db, workspaceId: workspaceA, sessionId: sessionA }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

// --- Extension-based mimetype ----------------------------------------

test("{§zero-width-column-one-insert} Session: path suffix `.json` declares mimetype; READ returns application/json", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({ target: urlPath("workspace", "/users.json"), body: '[{"name":"Alice"}]' }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        const result = await readThroughScheme("workspace", null,
            readStatement({ target: urlPath("workspace", "/users.json") }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.equal(result.content, '[{"name":"Alice"}]');
    } finally { db.close(); }
});

test("{§zero-width-column-one-insert} Session: extension `.json` does not change line shorthand semantics", async () => {
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
        const result = await readThroughScheme("workspace", null,
            readStatement({ target: urlPath("workspace", "/users.json"), lineMarker: { marks: [3] } }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, '  {"name":"Bob"},');
        assert.equal(result.startLine, 3);
    } finally { db.close(); }
});

test("{§zero-width-column-one-insert} Session: no path suffix → scheme default (text/markdown); <L> is line-based", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({ target: urlPath("workspace", "/users"), body: "alpha\nbeta\ngamma" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        // Without `.json` delimiter, mimetype falls back to manifest default
        // (text/markdown). <L><2> is line-based.
        const result = await readThroughScheme("workspace", null,
            readStatement({ target: urlPath("workspace", "/users"), lineMarker: { marks: [2] } }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, "beta");
    } finally { db.close(); }
});
});

describe("Engine.read-authority", () => {
const source = "first\nsecond\nthird";
const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `read-authority-${crypto.randomUUID()}`);
    const harnessTurn = await insertOperationTurn(db, ids.loopId, 2, "_plurnk");
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const run = async (program: string, origin: "model" | "_plurnk" = "model") => {
        const parsed = PlurnkParser.parseStatements(program, { executors: fixtureExecutors(program) });
        assert.equal(parsed.items.length, 1, program);
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement", program);
        if (item?.kind !== "statement") throw new Error("Expected one operation");
        return engine.dispatch({ ...ids, turnId: origin === "model" ? ids.turnId : harnessTurn,
            sequence: ++sequence, origin, statement: item.statement });
    };
    const read = async (target: string, origin: "model" | "_plurnk" = "model") =>
        Results.assertReadResult(await run(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``, origin)) as AnchoredReadResult;
    const seed = async (ownerId: number, target: string) => {
        const parsed = parsePath(target);
        const handler = target.startsWith("workspace:") ? new Workspace() : new Session();
        const result = await handler.edit(editStmt(parsed, source), makeSchemeCtx({
            db, workspaceId: ids.workspaceId, sessionId: ownerId, writer: "_plurnk",
        }));
        assert.equal(result.status, 201);
    };
    return { db, ids, schemes, run, read, seed };
};

const assertProjection = (read: AnchoredReadResult, editable: boolean) => {
    assert.equal(read.status, 200);
    assert.equal(read.content, source);
    assert.equal(Object.hasOwn(read, "lineAnchors"), editable);
    if (editable) assert.equal(read.lineAnchors?.length, 3);
    const wire = PacketWire.renderLog([{ coordinate: "1/1/1", op: "READ", origin: "_plurnk",
        status: read.status, rx: read, lineAnchors: read.lineAnchors, lineNumberWidth: read.lineNumberWidth }], contentWeight);
    assert.match(wire, /1(?:<@[0-9A-Za-z]{5}>|:)first/);
    if (editable) assert.match(wire, /1<@[0-9A-Za-z]{5}>first/);
    else assert.doesNotMatch(wire, /\d+<@[0-9A-Za-z]{5}>/);
};

for (const mode of ["writable", "read-only", "unresolved", "unavailable"] as const) {
    test(`{§line-anchors}: extension ${mode} resolution governs publication without hiding internal failure`, async (t) => {
        const { db, ids, schemes, read } = await runtime(t);
        const calls: unknown[] = [];
        const unavailable = Results.failure("scheme:authority", "authority-unavailable", 500, "Write authority could not be resolved.");
        assert.ok(unavailable.problem);
        const scheme: SchemeHandler = {
            manifest: {
                name: "authority", authority: "namespace", category: "data",
                channels: { body: "text/plain" }, defaultChannel: "body",
                writableBy: ["model", "_plurnk"], textEditScopes: true, volatile: false, modelVisible: true,
            },
            resolveEntryAddress: async (_target, ctx, access) => {
                calls.push([access, ctx.writer]);
                if (access === "write") {
                    if (mode === "read-only") return Results.failure("scheme:authority", "read-only", 403, "The resource is read-only.");
                    if (mode === "unresolved") return null;
                    if (mode === "unavailable") return unavailable;
                }
                return { authority: "", pathname: "/entry" };
            },
        };
        schemes.register("authority", scheme);
        await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "authority", pathname: "/entry",
            channel: "body", content: source, mimetype: "text/plain" });
        for (const origin of ["model", "_plurnk"] as const) {
            calls.length = 0;
            const result = await read("authority:///entry", origin);
            assert.deepEqual(calls, [["read", origin], ["write", "model"]]);
            if (mode === "unavailable") {
                assert.equal(result.status, 500);
                assert.equal(result.problem?.type, unavailable.problem.type);
                assert.equal(result.problem?.detail, unavailable.problem.detail);
                assert.equal(result.content, null, "a failed authority service is not disguised as a successful read-only projection");
            } else assertProjection(result, mode === "writable");
        }
    });
}

for (const { target, editable, problem } of [

    { target: "workspace:///note.md", editable: true, problem: null },
    { target: "session://peer/note.md", editable: true, problem: null },
    { target: "workspace:///_plurnk/tools/example.md", editable: true, problem: null },
    { target: "workspace:///_plurnk/tools/example.md", editable: true, problem: null },
]) {
    test(`{§line-anchors}: ${target} publishes only its resource's model edit authority`, async (t) => {
        const { db, ids, run, read, seed } = await runtime(t);
        const peer = await insertSession(db, ids.workspaceId, null, "peer");
        await seed(target.includes("//peer/") ? peer : ids.sessionId, target);
        for (const origin of ["model", "_plurnk"] as const) assertProjection(await read(target, origin), editable);
        if (editable) {
            const anchor = (await read(target)).lineAnchors![1];
            assert.equal((await run(`\`\`\`\`EDIT (${target}) <${anchor}>\nchanged\n\`\`\`\``)).status, 200);
            assert.equal((await read(target)).content, "first\nchanged\nthird");
        } else {
            for (const scope of ["<1>", "<@abcde>"]) {
                const denied = await run(`\`\`\`\`EDIT (${target}) ${scope}\nchanged\n\`\`\`\``);
                assert.equal(denied.status, 403);
                assert.equal(denied.problem?.type, `https://problems.plurnk.xyz/scheme/session/${problem}`);
            }
            assert.equal((await read(target)).content, source);
        }
    });
}

test("{§line-anchors}: harness edits retain internal coordinate validation and publish generated-document edit anchors", async (t) => {
    const { ids, seed, read, run } = await runtime(t);
    const target = "workspace:///_plurnk/tools/example.md";
    await seed(ids.sessionId, target);
    const original = await read(target);
    assertProjection(original, true);
    assert.equal(typeof original.lineAnchorIdentity, "string");
    const anchor = LineAnchors.tokens(original.lineAnchorIdentity!, source)[1];
    const changed = await run(`\`\`\`\`EDIT (${target}) <${anchor}>\nupdated\n\`\`\`\``, "_plurnk");
    assert.equal(changed.status, 200);
    const current = await read(target);
    assert.equal(current.content, "first\nupdated\nthird");
    assert.equal(Object.hasOwn(current, "lineAnchors"), true);
});

test("{§line-anchors}: file READ and EDIT share root and mounted-member write authority", async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "plurnk-read-authority-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, "project");
    await mkdir(root);
    const { db, ids, read, run } = await runtime(t);
    await rootWorkspace(db, ids.workspaceId, root);

    const ctx = makeSchemeCtx({ ...ids, db });
    for (const { path, origin, editable } of [
        { path: "local.md", origin: "git", editable: true },
        { path: "../mounted.md", origin: "git", editable: false },
        { path: "../picked.md", origin: "constraint", editable: true },
    ]) {
        await writeFile(join(root, path), source);
        await db.crud_register_workspace_member.get({ workspace_id: ids.workspaceId, scheme: "file", authority: "", pathname: path, membership_origin: origin });
        await EntryCrud.writeEntry({ authority: "", pathname: path }, { channels: {
            body: { content: source, mimetype: "text/markdown" },
        } }, ctx, "file");
        assertProjection(await read(path), editable);
        if (!editable) {
            const denied = await run(`\`\`\`\`EDIT (${path}) <@abcde>\nchanged\n\`\`\`\``);
            assert.equal(denied.status, 403);
            assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/scheme/file/member-read-only");
            const killed = await run(PlurnkParser.frame(`KILL (${path})`, null));
            assert.equal(killed.status, 403, JSON.stringify(killed));
            assert.equal(killed.problem?.type, denied.problem?.type, "the same member write authority governs deletion");
        }
        assert.equal(await readFile(join(root, path), "utf8"), source, "READ and refused EDIT have no disk effects");
    }
});
});

describe("READ.audio", () => {
process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
const next = "````NOTE\nInspect the audio.\n````";
const turn = (content: string) => ({ assistant: { content, reasoning: null } });

for (const modalities of [["audio"], []] as InputModality[][]) {
    test(`{§log-wire-format} audio READ, log READ, retention and scoped KILL on ${modalities.length ? "audio" : "text-only"} routes`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const root = await mkdtemp(join(tmpdir(), "plurnk-audio-"));
        const bytes = wav();
        await writeFile(join(root, "clip.wav"), bytes);
        const provider = new Mock({ contextWindow: viableWindow(), inputModalities: modalities, responses: [
            turn(`\`\`\`\`READ (clip.wav#bytes) <1,4>\`\`\`\`\n${next}`),
            turn(`\`\`\`\`KILL (clip.wav)\`\`\`\`\n${next}`),
            turn(`\`\`\`\`READ (log:///1/2/3/READ)\`\`\`\`\n${next}`),
            turn(`\`\`\`\`KILL (log:///1/2/3/READ) <42>\`\`\`\`\n${next}`),
            turn("````SEND [200]\nAudio inspection complete.\n````"),
        ] });
        try {
            await withDaemon(provider, async (db, _daemon, addr) => {
                const client = await connect(addr);
                try {
                    await rpcCall(client, 1, "workspace.create", { name: "audio-read", projectRoot: root });
                    const run = await rpcCall(client, 2, "loop.run", { prompt: "Inspect clip.wav." });
                    const loopId = (run.result as { loopId: number }).loopId;
                    await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20_000 });
                    await assert.rejects(readFile(join(root, "clip.wav")), { code: "ENOENT" });
                    const loop = await db.drain_message_source.get<{ session_id: number }>({ loop_id: loopId });
                    const fork = await Fork.fork(db, loop!.session_id, "audio-fork");
                    const rows = await db.engine_render_log.all<{ op: string; pathname: string; status_rx: number; rx: string }>({ session_id: fork });
                    const observation = rows.find((row) => row.op === "READ" && row.pathname === "/1/2/3/READ");
                    assert.ok(observation, "the fork inherits the explicit log READ");
                    assert.equal(typeof JSON.parse(observation.rx).nativeContentHash, "string", observation.rx);
                    assert.ok(Buffer.from(await NativeContent.read(db, JSON.parse(observation.rx).nativeContentHash)).equals(bytes), "the fork retains the exact audio bytes");
                } finally { client.close(); }
            });
            const files = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.deepEqual(files.map((parts) => parts.length), modalities.length ? [0, 1, 1, 2, 1] : [0, 0, 0, 0, 0]);
            for (const part of files.flat()) {
                assert.equal(part.mediaType, "audio/wav");
                assert.ok(Buffer.from(part.data).equals(bytes), "native input retains the complete bytes beside a scoped READ");
            }
            const packet = provider.received[1].map(chatMessageText).join("\n");
            assert.match(packet, /1:52\n2:49\n3:46\n4:46/u);
            if (modalities.length) assert.match(packet, /"tokensAttachment":32/u);
            else assert.doesNotMatch(packet, /tokensAttachment/u);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}
});

describe("READ.bytes", () => {
// {§binary-parity} {§binary-parity} — a binary member reads and searches as its bytes: one hexadecimal
// octet per line, the text coordinate algebra unchanged, evidence that pastes into a READ.













const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES ??= "104857600";

const bytesReadStmt = (root: string, pathname: string, lineMarker: LineMarker | null = null, fragment: string | null = null): ReadStatement => {
    const url = pathToFileURL(join(root, pathname));
    if (fragment !== null) url.hash = fragment;
    const target = parsePath(url.href);
    assert.ok(target);
    return { metadata: null, op: "READ", aside: null, target, lineMarker, matcher: null, body: null, position: { line: 1, column: 1 } };
};
const bytesFindStmt = (pathname: string, pattern: string) => ({
    op: "FIND", aside: null, lineMarker: null, metadata: null, position: { line: 1, column: 1 },
    target: { kind: "local", raw: pathname }, matcher: { dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" }, body: null,
}) as never;

// A PNG signature, a word, a NUL, and a tail: 40 bytes with a text line break inside them.
const BLOB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("testword02\x00tail-of-the-blob-1234")]);
assert.equal(BLOB.length, 40);

const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-bytes-"));
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `bytes-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });

    // The materializer's shape for a binary member with no readable projection: an empty body
    // under the source mimetype; the bytes live on disk only.
    await writeFile(join(root, "blob.bin"), BLOB);
    await EntryCrud.writeEntry({ authority: "", pathname: "blob.bin" }, { channels: { body: { content: "", mimetype: "application/octet-stream" } } }, ctx, "file");
    await writeFile(join(root, "notes.md"), "hello\nworld\n");
    await EntryCrud.writeEntry({ authority: "", pathname: "notes.md" }, { channels: { body: { content: "hello\nworld\n", mimetype: "text/markdown" } } }, ctx, "file");
    return { root, db, ctx };
};

test("{§binary-parity} a binary member reads as hex lines: the first page without a scope, ranges, and 416", async () => {
    const { root, db, ctx } = await setup();
    try {
        const head = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin"), ctx);
        assert.equal(head.status, 200, JSON.stringify(head.problem));
        assert.equal(head.content, ByteView.hexLines(BLOB), "without a scope, the first page of bytes: 40 fit it ({§packet})");
        assert.equal(head.startLine, 1);
        assert.equal(head.mimetype, "application/octet-stream", "the source mimetype is never relabelled");
        assert.deepEqual(head.range, { unit: "byte", total: 40, requested: [1, PAGE], returned: [1, 40] });
        assert.equal((head as { projection?: string }).projection, "hex");

        const tail = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [17, -1] }), ctx);
        assert.equal(tail.status, 200);
        assert.equal(tail.startLine, 17);
        assert.equal(tail.content, ByteView.hexLines(BLOB.subarray(16)));
        assert.deepEqual(tail.range?.returned, [17, 40]);

        const all = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [1, -1] }), ctx);
        assert.equal(all.content?.split("\n").length, 40, "<1,-1> is the whole resource");

        const word = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [9, 18] }), ctx);
        assert.equal(word.content, ByteView.hexLines(Buffer.from("testword02")), "a byte window pastes straight from FIND evidence");

        const beyond = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [41, 50] }), ctx);
        assert.equal(beyond.status, 416, "past the last byte is not satisfiable");
        assert.equal(beyond.range?.total, 40);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§binary-parity} #bytes is the raw view of any member the scheme can supply, text included", async () => {
    const { root, db, ctx } = await setup();
    try {
        const raw = await readThroughScheme("file", null, bytesReadStmt(root, "notes.md", { marks: [1, 5] }, "bytes"), ctx);
        assert.equal(raw.status, 200, JSON.stringify(raw.problem));
        assert.equal(raw.channel, "bytes");
        assert.equal(raw.content, ByteView.hexLines(Buffer.from("hello")));
        assert.equal(raw.mimetype, "text/markdown");
        const body = await readThroughScheme("file", null, bytesReadStmt(root, "notes.md"), ctx);
        assert.equal(body.content, "hello\nworld\n", "the text body is untouched by the byte view");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§binary-parity} a FIND over a binary member matches bytes and reports byte coordinates", async () => {
    const { root, db, ctx } = await setup();
    try {
        const file = new File();
        const word = await file.find(bytesFindStmt("blob.bin", "testword\\d+"), ctx);
        assert.equal(word.status, 200, JSON.stringify(word.problem));
        const rendered = JSON.stringify(word.results);
        assert.match(rendered, /"startLine":9/, `the word starts at byte 9: ${rendered.slice(0, 400)}`);
        assert.match(rendered, /"endLine":18/, "and ends at byte 18");
        assert.match(rendered, new RegExp(`"matched":"${ByteView.hex(Buffer.from("testword02"))}"`), "the matched bytes ride as hex");

        const signature = await file.find(bytesFindStmt("blob.bin", "\\x89PNG"), ctx);
        assert.equal(signature.status, 200, JSON.stringify(signature.problem));
        assert.match(JSON.stringify(signature.results), /"startLine":1,"startColumn":1,"endLine":4,"endColumn":3/, "a byte-escape pattern locates the signature");

        const miss = await file.find(bytesFindStmt("blob.bin", "absent-string"), ctx);
        assert.equal(miss.status, 204, "no hit over a present resource is 204, the text contract");
        assert.equal(miss.matchLocationCount, 0);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§packet} a retrieval without a scope is its first page, whatever its unit", async () => {
    const { root, db, ctx } = await setup();
    try {
        for (let n = 1; n <= 7; n += 1) {
            await writeFile(join(root, `page${n}.md`), "findable\n");
            await EntryCrud.writeEntry({ authority: "", pathname: `page${n}.md` }, { channels: { body: { content: "findable\n", mimetype: "text/markdown" } } }, ctx, "file");
        }

        const bytes = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin"), ctx);
        assert.deepEqual(bytes.range, { unit: "byte", total: 40, requested: [1, PAGE], returned: [1, 40] }, "the first page of a byte view, in bytes");

        const found = await new File().find(bytesFindStmt("page*.md", "findable"), ctx);
        assert.equal(found.status, 200, JSON.stringify(found.problem));
        assert.deepEqual(found.range?.requested, [1, PAGE], "the first page of results of a FIND");
        assert.deepEqual(found.range?.returned, [1, 7]);
        assert.equal(found.range?.total, 7, "the total counts every position");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("READ.image", () => {
// {§log-wire-format}: a native READ remains ordinary curatable context.













// The member tree is a plain directory: the service member definition admits it, as the harness does.
process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY = "1000";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF = "1";

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A complete, valid 1×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const nativeParts = (messages: readonly ChatMessage[]) => messages.flatMap((message) => message.role === "user" && Array.isArray(message.content) ? message.content : []);

class DropImageRequestOnce extends Mock {
    readonly attempts: string[] = [];

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.attempts.push(JSON.stringify(args[0].messages));
        if (this.attempts.length !== 2) return super.generate(...args);
        const accounting = {
            provider: "provider:mock",
            model: this.model,
            outcome: "error" as const,
            cost: { kind: "unknown" as const, reason: "simulated connection reset" },
        };
        const settle = await args[0].observeRequest?.({ provider: "provider:mock", model: this.model });
        await settle?.(accounting);
        throw new ProviderError("mock", "network_failure", "simulated connection reset", { accounting: [accounting] });
    }
}

const runLoop = async (
    modalities: readonly InputModality[],
    read = "````READ (logo.png)````",
    renew = false,
    responses?: MockResponse[],
    provider?: Mock,
    verify?: (root: string, db: Db, loopId: number) => Promise<void>,
) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-image-"));
    await writeFile(join(root, "logo.png"), PNG);
    const mock = provider ?? new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: responses ?? [
            mockTurn(`${read}

\`\`\`\`NOTE
looking
\`\`\`\``),
            renew
                ? mockTurn(`${read}

\`\`\`\`NOTE
keep looking
\`\`\`\``)
                : mockTurn("````NOTE\ncontinue inspecting\n````"),
            mockTurn("````SEND [200]\nseen\n````"),
        ],
    });
    try {
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `image-${modalities.join("-") || "blind"}`, projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "what is in logo.png?" });
                const loopId = (run.result as { loopId: number }).loopId;
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 200,
                    { timeoutMs: 20000 },
                );
                await verify?.(root, db, loopId);
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
    return mock.received;
};

test("{§log-wire-format} a seeing route receives the picture as a native part beside its READ row", async () => {
    const requests = await runLoop(["image"]);
    const second = requests[1];
    assert.ok(second !== undefined && second.length >= 2, "the request after READ reached the provider");
    assert.deepEqual(second.map(({ role }) => role), ["system", "user", "assistant", "user"]);
    assert.equal(second[2].content, "```READ (logo.png)\n```\n\n```NOTE\nlooking\n```", "the READ replays with its turn, before the native result");
    const user = second[3];
    assert.ok(user !== undefined && Array.isArray(user.content), `the user slot carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const text = userText(second);
    const image = user.content.find((part) => part.type === "file" && part.mediaType === "image/png");
    assert.match(text, /PNG image, 1×1 px, \d+ bytes/, "the READ row reads as the header line");
    assert.match(text, /"tokensAttachment":\d+/, "the row weighs the picture");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the picture itself rides as image media in the current file part");
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "native delivery adds no permanent hot-path teaching");
});

test("{§tokenomics}: a READ that does not fit is a bodiless receipt; native output that fits attaches, and another READ attaches it again", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-image-fit-"));
    try {
        await writeFile(join(root, "logo.png"), PNG);
        await writeFile(join(root, "large.txt"), "evidence ".repeat(100_000));
        const next = "````NOTE\nReview the evidence.\n````";
        const provider = new Mock({ contextWindow: 36_000, inputModalities: ["image"], responses: [
            mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n\`\`\`\`READ (large.txt) <1,-1>\`\`\`\`\n${next}`),
            mockTurn(next),
            mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
            mockTurn("````SEND [200]\nImage inspection complete.\n````"),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "native-context-fit", projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "Review logo.png and large.txt." });
                const loopId = (run.result as { loopId: number }).loopId;
                await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20_000 });
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; pathname: string | null; status_rx: number; rx: string }>({ loop_id: loopId });
                const images = rows.filter(({ op, pathname }) => op === "READ" && pathname === "logo.png");
                assert.equal(images.length, 2);
                assert.deepEqual(images.map(({ status_rx }) => status_rx), [200, 200], "the picture fits twice");
                assert.equal(JSON.parse(images[0].rx).nativeContentHash, JSON.parse(images[1].rx).nativeContentHash, "both observations retain the same immutable source bytes");
                const large = rows.find(({ op, pathname }) => op === "READ" && pathname === "large.txt");
                assert.ok(large, "the explicit READ of the large file has its row");
                assert.equal(large.status_rx, 413, "the whole file does not fit the remaining budget");
                const receipt = JSON.parse(large.rx) as { content: string | null; problem: { type: string; lines: number; tokens: number; remaining: number } };
                assert.equal(receipt.content, null, "a receipt carries no body: not a head, not a page");
                assert.equal(receipt.problem.type, RESULT_EXCEEDS_BUDGET);
                assert.equal(receipt.problem.lines, 1, "the size is stated in the projection's own units");
                assert.ok(receipt.problem.tokens > receipt.problem.remaining, "the receipt states what remained");
            } finally { ws.close(); }
        });
        assert.ok(nativeParts(provider.received[1]).some((part) => part.type === "file"), "the picture that fit rides natively in the next request");
        const text = userText(provider.received[1]);
        assert.match(text, /"status":413/u, "the receipt for the READ that did not fit is visible to the model");
        assert.doesNotMatch(text, /evidence evidence/u, "no part of a body that did not fit is shown");
        const gauge = /^## Context\n(.*)$/mu.exec(text)?.[1] ?? "";
        assert.match(gauge, /^\{"tokens":/u, "the gauge rides the request");
        assert.doesNotMatch(gauge, /\[!WARNING\]|YOU MUST/u, "no mandate rides the gauge ({§tokenomics})");
        const renewed = nativeParts(provider.received[3]);
        const image = renewed.find((part) => part.type === "file");
        assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "another READ attaches the picture again");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§log-wire-format} a blind route receives the same READ as text alone", async () => {
    const requests = await runLoop([]);
    assert.ok(requests[1].every((message) => typeof message.content === "string"), "a blind route receives text alone");
    const text = userText(requests[1]);
    assert.match(text, /PNG image, 1×1 px, \d+ bytes/);
    assert.doesNotMatch(text, /tokensAttachment/);
    const system = requests[1]?.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "no Attachments section on a blind route");
});

test("{§log-wire-format} completed responses retain native content alongside the READ text", async () => {
    const requests = await runLoop(["image"]);
    assert.ok(nativeParts(requests[2]).some((part) => part.type === "file" && Buffer.from(part.data).equals(PNG)), "the subsequent request retains native content");
    const text = userText(requests[2]);
    assert.match(text, /PNG image, 1×1 px, \d+ bytes/);
    assert.match(text, /tokensAttachment/);
});

test("{§log-wire-format} repeating READ creates a new native delivery for the following request", async () => {
    const requests = await runLoop(["image"], "````READ (logo.png)````", true);
    assert.equal(nativeParts(requests[2]).filter((part) => part.type === "file").length, 2, "both retained observations contribute native content");
});

test("{§log-wire-format} invalid-emission rerolls reuse the same materialized native request", async () => {
    const requests = await runLoop(["image"], "````READ (logo.png)````", false, [
        mockTurn("````READ (logo.png)````\n````NOTE\nlooking\n````"),
        { assistant: { content: "````READ (workspace:///not-a-plurnk-emission", reasoning: null }, assistantRaw: null },
        mockTurn("````NOTE\nrecovered\n````"),
        mockTurn("````SEND [200]\nseen\n````"),
    ]);
    const attempted = requests.slice(1, 3);
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every((messages) => nativeParts(messages).some((part) => part.type === "file")), "both physical attempts carry the native part");
    assert.deepEqual(attempted[0], attempted[1], "the reroll reuses the exact frozen request");
    assert.ok(nativeParts(requests[3]).some((part) => part.type === "file" && Buffer.from(part.data).equals(PNG)), "the next logical turn retains native content");
});

test("{§log-wire-format} a response-less network retry retains the same materialized native request", async () => {
    const provider = new DropImageRequestOnce({
        contextWindow: viableWindow(),
        inputModalities: ["image"],
        responses: [
            mockTurn("````READ (logo.png)````\n````NOTE\nlooking\n````"),
            mockTurn("````NOTE\nrecovered\n````"),
            mockTurn("````SEND [200]\nseen\n````"),
        ],
    });
    await runLoop(["image"], "````READ (logo.png)````", false, undefined, provider);
    assert.equal(provider.attempts.length, 4, "one initial call, the dropped image request, its retry, and the next turn");
    assert.equal(provider.attempts[1], provider.attempts[2], "the response-less retry receives the exact same image-bearing request");
    for (const index of [1, 3]) {
        assert.match(provider.attempts[index], /"mediaType":"image\/png"/u);
    }
});

test("{§binary-parity} {§log-wire-format} a ranged byte READ returns its hex slice and the complete native image", async () => {
    const requests = await runLoop(["image"], "````READ (logo.png#bytes) <1,16>````");
    const parts = nativeParts(requests[1]);
    const packetText = userText(requests[1] ?? []);
    const image = parts.find((part) => part.type === "file" && part.mediaType === "image/png");
    assert.match(packetText, new RegExp(`"range":"<1,16> of ${PNG.length} bytes"`, "u"));
    assert.match(packetText, /\n\s*1:\s*89\n/u, "the requested byte slice remains visible as hexadecimal");
    assert.match(packetText, /\n16:\s*52(?:\n|$)/u, "the byte projection stops at the requested endpoint");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the full source image rides beside the slice");
});

test("{§binary-parity} {§log-wire-format} a ranged byte READ remains the same hex slice on a text-only route", async () => {
    const requests = await runLoop([], "````READ (logo.png#bytes) <1,16>````");
    assert.ok(requests[1].every((message) => typeof message.content === "string"), "a text-only route receives no native part");
    const text = userText(requests[1]);
    assert.match(text, new RegExp(`"range":"<1,16> of ${PNG.length} bytes"`, "u"));
    assert.match(text, /\n\s*1:\s*89\n/u);
    assert.match(text, /\n16:\s*52(?:\n|$)/u);
});

test("{§log-wire-format} native content survives completed responses until scoped KILL retires its READ", async () => {
    const next = "````NOTE\nInspect the picture.\n````";
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
        mockTurn(next),
        mockTurn(`\`\`\`\`KILL (log:///*/*/*/READ) <42>\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ]);
    for (const index of [1, 2]) {
        const content = nativeParts(requests[index]);
        const image = content.find((part) => part.type === "file");
        assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG));
    }
    assert.ok(requests[3].every(({ content }) => typeof content === "string"), "even an irrelevant KILL scope releases the atomic native observation");
    assert.doesNotMatch(userText(requests[3]), /### log:\/\/\/\d+\/\d+\/\d+\/READ \(logo\.png\)/);
});

test("{§log-wire-format} retained and forked READs preserve original bytes after source deletion", async () => {
    const next = "````NOTE\nInspect the retained picture.\n````";
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (logo.png)\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ], undefined, async (root, db, loopId) => {
        await assert.rejects(readFile(join(root, "logo.png")), { code: "ENOENT" }, "the source was actually deleted");
        const loop = await db.drain_message_source.get<{ session_id: number }>({ loop_id: loopId });
        const forkId = await Fork.fork(db, loop!.session_id, "native-fork");
        const rows = await db.engine_render_log.all<{ op: string; pathname: string; rx: string }>({ session_id: forkId });
        const image = rows.find((row) => row.op === "READ" && row.pathname === "logo.png");
        assert.ok(image);
        const hash = JSON.parse(image.rx).nativeContentHash as string;
        assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG, "forked evidence references the same retained snapshot");
    });
    const content = nativeParts(requests[2]);
    const image = content.find((part) => part.type === "file");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the retained observation preserves the READ's bytes");
});

test("{§log-wire-format} explicit log READ preserves its own observation after source deletion and curation", async () => {
    const next = "````NOTE\nInspect history.\n````";
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (logo.png)\`\`\`\`\n\`\`\`\`READ (log:///1/2/3/READ)\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (log:///1/2/3/READ) <42>\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ]);
    const copied = nativeParts(requests[2]);
    assert.equal(copied.filter((part) => part.type === "file").length, 2);
    const content = nativeParts(requests[3]);
    assert.equal(content.filter((part) => part.type === "file").length, 1);
    const image = content.find((part) => part.type === "file");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "an explicit historical READ reacquires original bytes, not the missing pathname");
});

test("{§log-kill-scope} a text-only route preserves ordinary scoped trimming of a media READ", async () => {
    const next = "````NOTE\nInspect bytes.\n````";
    const requests = await runLoop([], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png#bytes) <1,16>\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (log:///1/2/3/READ) <1>\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ]);
    assert.ok(requests[2].every((message) => typeof message.content === "string"));
    const content = userText(requests[2]);
    assert.match(content, /### log:\/\/\/1\/2\/3\/READ \(logo\.png#bytes\) · \d+\n/, "the trimmed READ's receipt stays, naming its operand");
    assert.ok(requests[2].some((message) => message.role === "assistant" && message.content === "```READ (logo.png#bytes) <1,16>\n```\n\n```NOTE\nInspect bytes.\n```"), "trimming the result leaves the READ's replay whole");
    assert.doesNotMatch(content, /\n\s*1:89\n/u);
    assert.match(content, /\n\s*2:50\n/u);
});

// The specimen exercises results after server admission, not interactive approval.
process.env.PLURNK_SERVICE_PROPOSALS = "accept";
});

describe("READ.pdf", () => {
// {§log-wire-format} — a PDF READ retains one native observation. A document route gets
// the file alongside its receipt; a route that cannot take documents gets text alone.











process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

const PDF = Buffer.from(buildPdf({ title: "Contract" }));

const runLoop = async (modalities: readonly InputModality[]) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pdf-"));
    await writeFile(join(root, "contract.pdf"), PDF);
    const mock = new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: [mockTurn("````READ (contract.pdf)````\n````NOTE\nlooking\n````"), mockTurn("````SEND [200]\nseen\n````")],
    });
    try {
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `pdf-${modalities.join("-") || "blind"}`, projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "what is in contract.pdf?" });
                const loopId = (run.result as { loopId: number }).loopId;
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 200,
                    { timeoutMs: 30000 },
                );
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
    return mock.received;
};

test("{§log-wire-format} a document route receives the PDF as a native file part beside its READ row", async () => {
    const requests = await runLoop(["pdf"]);
    const second = requests.at(-1);
    assert.ok(second !== undefined && second.length >= 2, "two turns reached the provider");
    assert.deepEqual(second.map(({ role }) => role), ["system", "user", "assistant", "user"]);
    const user = second[3];
    assert.ok(user !== undefined && Array.isArray(user.content), `the log message carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const file = user.content.find((part) => part.type === "file");
    assert.match(userText(second), /"tokensAttachment":1500/, "one page weighs 1500 in the readout");
    assert.ok(file?.type === "file" && file.mediaType === "application/pdf" && Buffer.from(file.data).equals(PDF), "the document itself rides as the file part");
    const caption = user.content[user.content.indexOf(file) - 1];
    assert.ok(caption?.type === "text" && /^\n\nlog:\/\/\/\d+\/\d+\/\d+\/READ \(\S+\) \(application\/pdf, 1 pages\): the bytes of that READ row, retained until it is KILLed\. Not a new arrival\.$/u.test(caption.text), `the part is captioned as the model's own READ (#899): ${JSON.stringify(caption)}`);
    assert.deepEqual(user.content.slice(0, 3).map(({ type }) => type), ["text", "text", "file"], "the READ text, caption and native document remain together");
    assert.ok(user.content.slice(3).every(({ type }) => type === "text"), "later log records and the footer add no native deliveries");
    assert.match(chatMessageText(second[3]), /## Session/u, "the footer follows the turn's receipts and PDF");
    assert.doesNotMatch(userText(second), /1:looking/u, "the NOTE body appears only in assistant replay");
    assert.deepEqual(second[2], {
        role: "assistant",
        content: `${PlurnkParser.frame("READ (contract.pdf)", null)}\n\n${PlurnkParser.frame("NOTE", "looking")}`,
    }, "the READ's turn precedes its native result");
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "native delivery adds no permanent hot-path teaching");
});

test("{§log-wire-format} a picture-only route receives the PDF as text alone", async () => {
    const requests = await runLoop(["image"]);
    const last = requests.at(-1)!;
    assert.ok(last.every((message) => typeof message.content === "string"), "no part rides for a kind the route refuses");
    assert.doesNotMatch(userText(last), /tokensAttachment/);
});

// The specimen exercises results after server admission, not interactive approval.
process.env.PLURNK_SERVICE_PROPOSALS = "accept";
});

describe("caps-entries", () => {
// Conformance: the EntryCaps namespace in plurnk-schemes {§capability-ctx}
// round-trips write → read → delete against real SQLite through the public
// capability surface rather than core's private database context.








test("{§binary-parity} public entry writes retain bytes for ordinary byte READs", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-bytes-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        class Notes { static manifest = schemeManifest("notes"); }
        const caps = new DbEntryCaps(ctx, "notes", Notes.manifest, "");
        const bytes = Uint8Array.from([0, 255, 128, 65]);
        const written = await caps.write("/binary", {
            channels: { body: { content: "", bytes, mimetype: "application/octet-stream" } },
        });
        assert.equal(written.status, 201);
        const read = await readThroughScheme("notes", new Notes(), readStmt(parsePath("notes:///binary"), { marks: [1, -1] }), ctx);
        assert.equal(read.status, 200);
        assert.equal(read.content, "00\nff\n80\n41");
        assert.equal((await caps.read("/binary")).entry?.channels.body.mimetype, "application/octet-stream");
    } finally { await db.close(); }
});

test("{§capability-ctx} DbEntryCaps: write creates (201) → read round-trips → re-write updates (200) → delete (200→404)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-entries-${crypto.randomUUID()}`);
        const caps = new DbEntryCaps(makeSchemeCtx({ db, workspaceId }), "notes", schemeManifest("notes"), "");

        // write a new entry → 201 created, real entryId
        const w = await caps.write("/note.md", {
            channels: { body: { content: "hello", mimetype: "text/markdown", state: "active" } },
            attributes: { kind: "note", rank: 2 },
        });
        assert.equal(w.status, 201);
        assert.equal(w.created, true);
        assert.equal(typeof w.entryId, "number");

        // read round-trips content, mimetype, lifecycle state, and private attributes
        const r = await caps.read("/note.md");
        assert.equal(r.status, 200);
        assert.equal(r.entry?.channels.body.content, "hello");
        assert.equal(r.entry?.channels.body.mimetype, "text/markdown");
        assert.equal(r.entry?.channels.body.state, "active");
        assert.deepEqual(r.entry?.attributes, { kind: "note", rank: 2 });

        // re-write the same path → 200 (not created), content replaced
        const w2 = await caps.write("/note.md", {
            channels: { body: { content: "world", mimetype: "text/markdown", state: "closed" } },
        });
        assert.equal(w2.status, 200);
        assert.equal(w2.created, false);
        const updated = await caps.read("/note.md");
        assert.equal(updated.entry?.channels.body.content, "world");
        assert.equal(updated.entry?.channels.body.state, "closed");
        assert.deepEqual(updated.entry?.attributes, { kind: "note", rank: 2 }, "omitting private attributes preserves them");

        // read an absent path → 404, null entry
        const miss = await caps.read("/missing.md");
        assert.equal(miss.status, 404);
        assert.equal(miss.entry, null);

        // delete → 200, then read → 404, then delete-again → 404
        assert.equal((await caps.delete("/note.md")).status, 200);
        assert.equal((await caps.read("/note.md")).status, 404);
        assert.equal((await caps.delete("/note.md")).status, 404);
    } finally { await db.close(); }
});
});

describe("mcp-media-composition", () => {
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "Media inspected.");

class ResourceReader extends Mock {
    resource: string | undefined;
    beforeFirstRead: (() => void) | undefined;

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$RESOURCE")) return response;
        const packet = args[0].messages.map(chatMessageText).join("\n");
        if (this.resource === undefined) this.beforeFirstRead?.();
        this.resource = [...packet.matchAll(/<(fixture:\/\/[^>\s]+)>/gu)].at(-1)?.[1];
        return {
            ...response,
            assistant: { ...response.assistant, content: response.assistant.content.replace("$RESOURCE", this.resource ?? "fixture:///missing-resource") },
        };
    }
}

for (const media of [
    { kind: "image", bytes: PNG, mimeType: "image/png", name: "screenshot.png", hex: /1:89\n2:50\n3:4e/u },
    { kind: "audio", bytes: wav(), mimeType: "audio/wav", name: "clip.wav", hex: /1:52\n2:49\n3:46/u },
] as const) {
for (const form of ["inline", "embedded", "link", "multipart"] as const) {
for (const modalities of [[media.kind], []] as InputModality[][]) {
    test(`{§mcp-result-content} {§log-wire-format} ${media.kind}/${form}: MCP completion wakes; resource READ delivers ${modalities.length ? "native bytes" : "text only"}`, { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
        const release = Promise.withResolvers<void>();
        const called = Promise.withResolvers<void>();
        const uri = `fixture://media/${media.name}`;
        let resourceReads = 0;
        const content: ContentBlock[] = form === "inline"
            ? [{ type: media.kind, data: media.bytes.toString("base64"), mimeType: media.mimeType }]
            : form === "embedded"
                ? [{ type: "resource", resource: { uri, blob: media.bytes.toString("base64"), mimeType: media.mimeType } }]
                : [{ type: "resource_link", uri, name: media.name, mimeType: media.mimeType }];
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: "media-witness", version: "1.0.0" });
            server.registerResource("observation", uri, { mimeType: media.mimeType, cacheHint: { ttlMs: 60_000, cacheScope: "public" } }, async () => {
                resourceReads += 1;
                return { contents: [
                    ...(form === "multipart" ? [{ uri: "fixture://media/note.txt", mimeType: "text/plain", text: "Media attached." }] : []),
                    { uri, mimeType: media.mimeType, blob: media.bytes.toString("base64") },
                ] };
            });
            server.registerTool("observe", {
                inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async () => {
                called.resolve();
                await release.promise;
                return { content };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
        const served = await serveMcpHttp(t, handler);
        const provider = new ResourceReader({ contextWindow: 1_000_000, inputModalities: modalities, responses: [
            turn(`\`\`\`\`fixture (observe)\n{}\n\`\`\`\`\n\n${step("WAIT")}`),
            ...(form === "multipart" ? [turn(`\`\`\`\`READ ($RESOURCE)\`\`\`\`\n\n${step("NOTE")}`)] : []),
            turn(`\`\`\`\`READ ($RESOURCE${form === "inline" || form === "link" ? "#bytes" : ""}) <1,3>\`\`\`\`\n\n${step("NOTE")}`),
            turn(step("NOTE")),
            turn(step("SEND [200]")),
        ] });
        provider.beforeFirstRead = () => assert.equal(resourceReads, 0, "listing a resource link does not acquire its bytes");
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules"), hostPaths });
        daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "5000",
            PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        } }), "@plurnk/plurnk-mcp");
        let identity: { workspaceId: number; sessionId: number } | undefined;
        try {
            await daemon.start();
            const { workspaceId } = await daemon.createWorkspace({ name: "mcp-media-composition" });
            identity = { workspaceId, sessionId: await namedModelSession(daemon, workspaceId, "main") };
            const run = await daemon.runLoop({ ...identity, prompt: "Inspect the MCP media." });
            const lifecycle = new LoopLifecycle(db);
            await called.promise;
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 202, { timeoutMs: 5000 });
            assert.equal(provider.received.length, 1, "the session really parked before the MCP response");
            release.resolve();
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200, { timeoutMs: 8000 });
            const delivered = form === "multipart" ? 3 : 2;
            assert.equal(provider.received.length, delivered + 2, "completion woke exactly the waiting loop");
            assert.ok(provider.resource, "the result exposes an ordinary resource address");
            if (form === "inline") assert.match(provider.resource, /\/resources\/[a-f0-9]{8}$/u);
            if (form === "embedded" || form === "multipart") assert.ok(provider.resource.endsWith(`/resources/${media.name}`), "a supplied name survives");
            const texts = provider.received.map((messages) => messages.map(chatMessageText).join("\n"));
            assert.ok(texts.every((text) => !text.includes(media.bytes.toString("base64"))), "base64 evidence does not flood the ordinary body");
            const parts = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.equal(parts[1].length, 0, "listing a resource does not attach it");
            assert.equal(parts[delivered].length, modalities.length, "only READ creates supported native delivery");
            if (modalities.length) {
                assert.equal(parts[delivered][0]!.mediaType, media.mimeType);
                assert.ok(Buffer.from(parts[delivered][0]!.data).equals(media.bytes), "a scoped READ delivers the complete original media");
            }
            assert.equal(parts[delivered + 1].length, modalities.length, "later turns retain the READ's native content");
            if (modalities.length) assert.ok(Buffer.from(parts[delivered + 1][0]!.data).equals(media.bytes), "later turns retain the exact original media");
            if (form === "inline" || form === "link") assert.match(texts[delivered], media.hex, "byte scope still returns exactly the selected octets");
            assert.equal(resourceReads, form === "inline" || form === "embedded" ? 0 : 1, "embedded content needs no refetch; resource reads use the standard MCP cache");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; status_rx: number }>({ loop_id: run.loopId });
            assert.ok(rows.some((row) => row.op === "READ" && row.pathname.includes("/resources/") && row.status_rx === 200), "resource READ succeeded through the dispatcher");
            const output = rows.find((row) => row.op === "READ" && /^\/[a-f0-9]{8}$/.test(row.pathname));
            assert.ok(output, "the default channel has a terminal stream observation");
            const evidence = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: output.pathname, scheme: "fixture", name: "json" });
            assert.ok(evidence, "the original protocol result has an independently addressable #json channel");
            assert.deepEqual(JSON.parse(evidence.content).content, content, "the complete original protocol content remains in #json");
        } finally {
            release.resolve();
            if (identity !== undefined) await daemon.cancelSession(identity);
            await daemon.stop();
            await db.close();
        }
    });
}
}
}
});

describe("mcp-prompt-composition", () => {
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "Media inspected.");
const turn = (content: string) => ({ assistant: { content, reasoning: null } });

class PromptReader extends Mock {
    resource: string | undefined;

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$RESOURCE")) return response;
        const packet = args[0].messages.map(chatMessageText).join("\n");
        this.resource = [...packet.matchAll(/"uri":\s*"(fixture:[^"]+\/resources\/[^"]+)"/gu)].at(-1)?.[1];
        return { ...response, assistant: { ...response.assistant,
            content: response.assistant.content.replace("$RESOURCE", this.resource ?? "fixture:///missing-resource"),
        } };
    }
}

for (const media of [
    { kind: "image", bytes: png, mimeType: "image/png", hex: /1:89\n2:50\n3:4e/u },
    { kind: "audio", bytes: wav(), mimeType: "audio/wav", hex: /1:52\n2:49\n3:46/u },
] as const) {
for (const modalities of [[media.kind], []] as InputModality[][]) {
    test(`{§log-wire-format} MCP prompt ${media.kind} READ reaches ${modalities.length ? "native provider input" : "text-only fallback"} without injecting prompt roles`, { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
        let promptGets = 0;
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name: "prompt-media", version: "1" });
            server.registerPrompt("inspect", {}, async () => {
                promptGets += 1;
                return { messages: [
                    { role: "user", content: { type: "text", text: "Inspect the attached media." } },
                    { role: "assistant", content: { type: media.kind, data: media.bytes.toString("base64"), mimeType: media.mimeType } },
                ] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        const provider = new PromptReader({ contextWindow: 1_000_000, inputModalities: modalities, responses: [
            turn(`\`\`\`\`READ (fixture:///prompts/inspect) <1,-1>\n\`\`\`\`\n\n${step("NOTE")}`),
            turn(`\`\`\`\`READ ($RESOURCE#bytes) <1,3>\n\`\`\`\`\n\n${step("NOTE")}`),
            turn(step("NOTE")),
            turn(step("SEND [200]")),
        ] });
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules"), hostPaths });
        daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        } }), "@plurnk/plurnk-mcp");
        let identity: { workspaceId: number; sessionId: number } | undefined;
        try {
            await daemon.start();
            const { workspaceId } = await daemon.createWorkspace({ name: "mcp-prompt-media" });
            identity = { workspaceId, sessionId: await namedModelSession(daemon, workspaceId, "main") };
            const run = await daemon.runLoop({ ...identity, prompt: "Inspect the MCP prompt media." });
            const lifecycle = new LoopLifecycle(db);
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200, { timeoutMs: 10_000 });
            assert.equal(provider.received.length, 4);
            assert.match(provider.resource ?? "", /fixture:\/\/[^\s]*\/prompts\/inspect\/resources\/[a-f0-9]{8}$/u);
            assert.equal(promptGets, 1, "READ of a prompt's media snapshot never re-fetches the prompt");
            const texts = provider.received.map(userText);
            assert.ok(texts.every((text) => !text.includes(media.bytes.toString("base64"))));
            assert.match(texts[1], /"role": "assistant"/u, "the supplied role remains visible as prompt data");
            // {§emission-history}: only admitted model operations have assistant authorship.
            const noted = step("NOTE");
            const promptRead = PlurnkParser.frame("READ (fixture:///prompts/inspect) <1,-1>", null);
            const mediaRead = PlurnkParser.frame(`READ (${provider.resource}#bytes) <1,3>`, null);
            const previousPrograms = [
                [],
                [`${promptRead}\n\n${noted}`],
                [`${promptRead}\n\n${noted}`, `${mediaRead}\n\n${noted}`],
                [`${promptRead}\n\n${noted}`, `${mediaRead}\n\n${noted}`, noted],
            ];
            for (const [index, messages] of provider.received.entries()) {
                const expected = previousPrograms[index];
                assert.deepEqual(messages.map(({ role }) => role), ["system", "user", ...expected.flatMap(() => ["assistant", "user"])]);
                assert.deepEqual(messages.filter(({ role }) => role === "assistant"), expected.map((content) => ({ role: "assistant", content })),
                    "only admitted operations have assistant authorship; MCP prompt roles remain user data");
            }
            const parts = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.equal(parts[1].length, 0, "retrieving a prompt lists its media without attaching it");
            assert.equal(parts[2].length, modalities.length);
            assert.equal(parts[3].length, modalities.length, "native data follows the ordinary READ retention lifecycle");
            if (modalities.length) {
                assert.equal(parts[2][0]!.mediaType, media.mimeType);
                assert.ok(Buffer.from(parts[2][0]!.data).equals(media.bytes), "MCP prompt media retains the exact original bytes");
            }
            assert.match(texts[2], media.hex);
            const raw = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/prompts/inspect", scheme: "fixture", name: "json" });
            assert.equal(JSON.parse(raw?.content ?? "{}").messages.at(-1).content.data, media.bytes.toString("base64"));
        } finally {
            if (identity !== undefined) await daemon.cancelSession(identity);
            await daemon.stop();
            await db.close();
        }
    });
}
}
});

describe("packet-extents", () => {
const weigh = (text: string): number => Math.ceil(text.length / 4);
const content = Array.from({ length: 30 }, (_, index) => `source line ${index + 1}`).join("\n");

test("{§log-wire-format}: successful retrievals format typed extents without changing their evidence", async (t) => {
    for (const { unit, total, returned, expected } of [
        { unit: "line", total: 602, returned: [1, 16], expected: "<1,16> of 602 lines" },
        { unit: "line", total: 35, returned: [1, 35], expected: "35 lines" },
        { unit: "line", total: 1, returned: [1, 1], expected: "1 line" },
        { unit: "line", total: 35, expected: "none of 35 lines" },
        { unit: "resource", total: 40, returned: [17, 32], expected: "<17,32> of 40 resources" },
        { unit: "resource", total: 0, expected: "0 resources" },
        { unit: "matchLocation", total: 40, returned: [17, 17], expected: "<17> of 40 match locations" },
        { unit: "byte", total: 4096, returned: [1, 16], expected: "<1,16> of 4096 bytes" },
    ]) {
        await t.test(expected, () => {
            const range = { unit, total, requested: [1, -1], ...(returned === undefined ? {} : { returned }) };
            const row = { coordinate: "1/2/3", op: "READ", status: 200, target: { scheme: null, pathname: "sample" }, rx: { range, content: "" } };
            const original = structuredClone(row);
            const explicit = parseLogRecords(PacketWire.renderLog([row], weigh))[0];
            const automatic = parseLogRecords(PacketWire.renderLog([{ ...row, origin: "_plurnk" }], weigh))[0];
            assert.equal(explicit.range, expected);
            assert.equal(automatic.range, expected);
            assert.equal(explicit.region, undefined);
            assert.equal(explicit.lines, undefined);
            assert.deepEqual(row, original, "packet formatting does not mutate durable result facts");
        });
    }
});

test("{§log-wire-format}: a channel READ carrying its execution's failure formats its extent like any retrieval", () => {
    const problem = { type: "https://problems.plurnk.xyz/executor/subprocess/timeout", title: "Timeout", status: 504, detail: "'sh' timed out." };
    const range = { unit: "line", total: 3, requested: [1, 100], returned: [1, 3] };
    const row = { coordinate: "1/10/1", op: "READ", status: 504, origin: "_plurnk", target: { scheme: "sh", pathname: "/8d5808a1" }, rx: { range, content: "a\nb\nc", problem, terminal: true } };
    const rendered = parseLogRecords(PacketWire.renderLog([row], weigh))[0];
    assert.equal(rendered.range, "3 lines", "the retrieval succeeded; only the execution failed");
});

test("{§log-wire-format}: READ acquisition, receipt trimming, and READ of the log keep distinct coordinates", async () => {
    const rx = await ReadResolve.resolve({ content, mimetype: "text/plain", lineMarker: { marks: [17, 18] } });
    const entry = { coordinate: "1/2/3", op: "READ", status: rx.status, target: { scheme: null, pathname: "sample" }, rx };
    const original = structuredClone(rx);
    const whole = parseLogRecords(PacketWire.renderLog([entry], weigh))[0];
    assert.equal(whole.range, "<17,18> of 30 lines");
    assert.equal(whole.body, "17:source line 17\n18:source line 18\n");
    const scope = LogVisibility.resolveScope({ marks: [1] }, "log:///1/2/3/READ", rx.content!);
    assert.equal(scope.ok, true);
    const folded = LogVisibility.apply([], scope.range, TextCoordinates.lineCount(rx.content!));
    const rendered = PacketWire.renderLog([{ ...entry, folded }], weigh);
    const trimmed = parseLogRecords(rendered)[0];
    assert.equal(trimmed.range, whole.range, "curation does not rewrite acquisition evidence");
    assert.deepEqual(trimmed.trimmed, ["<1>"]);
    assert.equal(trimmed.folded, undefined);
    assert.equal(trimmed.body, "18:source line 18\n");
    assert.equal(trimmed.tokens, weigh(rendered), "the new metadata participates in exact row accounting");
    const reread = await ReadResolve.resolve({
        content: rx.content!, mimetype: "text/plain", lineMarker: { marks: [1, -1] },
        visibleLines: LogVisibility.visibleLineOrdinals(folded, TextCoordinates.lineCount(rx.content!)),
    });
    const observed = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/3/1", op: "READ", status: reread.status,
        target: { scheme: "log", pathname: "/1/2/3/READ" }, rx: reread,
    }], weigh))[0];
    assert.equal(observed.range, "<2> of 2 lines");
    assert.equal(observed.body, "2:source line 18\n");
    assert.deepEqual(rx, original, "the immutable acquisition retains both original source lines");
});

test("{§log-wire-format}: sparse acquisitions do not become complete merely by spanning both endpoints", async () => {
    const rx = await ReadResolve.resolve({ content, mimetype: "text/plain", lineMarker: { marks: [1, -1] }, visibleLines: [1, 15, 30] });
    const rendered = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/2/3", op: "READ", status: rx.status, target: { scheme: null, pathname: "sample" }, rx,
    }], weigh))[0];
    assert.equal(rendered.range, "<1,30> of 30 lines");
    assert.match(String(rendered.body), /1:source line 1\n15:source line 15\n30:source line 30/);
});

test("{§log-wire-format}: mutation scopes are resolved by the producer, not reverse-parsed by the packet", () => {
    const original = "first\nsecond\nthird";
    const updated = "first\nreplacement\nextra\nthird";
    const receipt = projectEditReceipt(editReceipt(original, updated, [{ marker: { marks: [2] }, body: "replacement\nextra" }]), 0);
    const retained = structuredClone(receipt);
    const row = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/2/3", op: "EDIT", status: 200, target: { scheme: null, pathname: "sample" }, rx: { receipt },
    }], weigh))[0];
    assert.equal(row.effect, "<2> -> <2,3>");
    assert.equal(row.range, undefined);
    assert.equal(row.change, "lines -1 +2");
    assert.equal(row.extent, "lines 3->4");
    assert.match(String(row.body), /2:replacement\n3:extra/);
    assert.deepEqual(receipt, retained);
});
});

describe("read-pattern", () => {
// {§read} — a pattern on a READ selects the lines it renders: every line a match touches,
// with the ordinary anchors, inside the scope. Zero matches is an empty read, never a failure.









const setup = async (content = "alpha\nTODO one\nbeta\nTODO two\ngamma") => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await new Workspace().edit(editStmt(urlPath("workspace", "/notes.md"), content), makeSchemeCtx({ db, workspaceId: env.workspaceId, sessionId: env.sessionId }));
    let sequence = 0;
    const dispatch = (statement: ReadStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    return { db, dispatch };
};

test("{§read} READ by pattern renders exactly the matching lines with their physical ordinals and anchors", async () => {
    const { db, dispatch } = await setup();
    try {
        const rxMatcher: MatcherBody = { dialect: "regex", raw: "/^TODO/", pattern: "^TODO", flags: "" };
        const r = await dispatch(readStmt(urlPath("workspace", "/notes.md"), null, rxMatcher));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.content, "TODO one\nTODO two");
        assert.deepEqual(r.lineOrdinals, [2, 4], "the lines keep their physical ordinals");
        assert.equal(r.matched, 2);
        assert.deepEqual(r.matches, [
            { region: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }, matched: "TODO" },
            { region: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 5 }, matched: "TODO" },
        ], "the readable lines do not replace the precise match evidence");
        assert.equal((r.lineAnchors as string[]).length, 2, "every rendered line carries its anchor");
        assert.deepEqual(r.range, { unit: "line", total: 5, requested: [2, 4], returned: [2, 4] });
    } finally { await db.close(); }
});

test("{§read} a scope bounds the lines a READ pattern may select; matched counts inside it", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(readStmt(urlPath("workspace", "/notes.md"), { marks: [1, 2] }, { dialect: "glob", raw: "TODO" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.content, "TODO one");
        assert.deepEqual(r.lineOrdinals, [2]);
        assert.equal(r.matched, 1);
        assert.deepEqual(r.matches, [
            { region: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }, matched: "TODO" },
        ], "the result does not advertise matches outside its returned text");
    } finally { await db.close(); }
});

test("{§read} zero matches read as empty (204) with matched 0", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(readStmt(urlPath("workspace", "/notes.md"), null, { dialect: "glob", raw: "DONE" }));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(r.content, "");
        assert.deepEqual(r.matches, []);
    } finally { await db.close(); }
});

test("{§packet} a whole-resource pattern READ returns every selected line, never the unselected ones", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? `keep ${index + 1}` : `skip ${index + 1}`);
    const { db, dispatch } = await setup(lines.join("\n"));
    try {
        const r = await dispatch(readStmt(urlPath("workspace", "/notes.md"), null, { dialect: "glob", raw: "keep" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 20, "every selected line counts");
        assert.deepEqual(r.lineOrdinals, Array.from({ length: 20 }, (_, index) => index * 2 + 1), "every selected line is returned, at its source ordinal");
        assert.doesNotMatch(String(r.content), /skip/);
        assert.equal((r.matches as unknown[]).length, 20, "match evidence covers every returned line");
    } finally { await db.close(); }
});

test("{§read} a full-text READ returns matching lines and exact token coordinates", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(readStmt(urlPath("workspace", "/notes.md"), null, { dialect: "fts", raw: "~TODO" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.content, "TODO one\nTODO two");
        assert.deepEqual(r.lineOrdinals, [2, 4]);
        assert.deepEqual(r.matches, [
            { region: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }, matched: "TODO" },
            { region: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 5 }, matched: "TODO" },
        ]);
    } finally { await db.close(); }
});

// {§read} — a pattern READ over a glob is grep: one ordinary exact pattern READ receipt per
// matching path, in the FIND's order; no match is one 204 on the glob.
test("{§read} a pattern READ over a glob fans out into one exact pattern READ receipt per matching path", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const ctx = makeSchemeCtx({ db, workspaceId: env.workspaceId, sessionId: env.sessionId });
    try {
        for (const [name, content] of [["pets_dogs.md", "cats\nbut I love dogs.\nfish\nHistorically, dogs have been..."], ["pets_cats.md", "Most cats are afraid of dogs."], ["pets_fish.md", "Fish are quiet."]] as const) {
            await new Workspace().edit(editStmt(urlPath("workspace", `/${name}`), content), ctx);
        }
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => {
            sequence += 1;
            const result = await engine.dispatch({ statement, workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
            sequence += ((result.rowsWritten as number | undefined) ?? 1) - 1;
            return result;
        };
        const rows = async () => (await db.test_log_entries_by_loop.all<{ op: string; pathname: string | null; status_rx: number; rx: string; attrs: string; sequence: number }>({ loop_id: env.loopId }))
            .filter((row) => row.op === "READ" || row.op === "FIND").toSorted((a, b) => a.sequence - b.sequence);

        const globTarget = urlPath("workspace", "/pets_*.md");
        const grep = await dispatch(readStmt(globTarget, null, { dialect: "regex", raw: "/dogs/i", pattern: "dogs", flags: "i" }));
        assert.equal(grep.status, 200, JSON.stringify(grep));
        assert.equal(grep.rowsWritten, 2, "one receipt per matching path; the fishless file writes none");
        const receipts = await rows();
        assert.deepEqual(receipts.map(({ op, pathname, status_rx }) => [op, pathname, status_rx]), [["READ", "/pets_cats.md", 200], ["READ", "/pets_dogs.md", 200]], "each receipt is an exact READ of one matching path, in the FIND's order");
        assert.deepEqual(receipts.map(({ attrs }) => (JSON.parse(attrs) as { fanout: unknown }).fanout), [
            { target: globTarget.raw, matched: 2, index: 0, count: 2 },
            { target: globTarget.raw, matched: 2, index: 1, count: 2 },
        ], "every fanned-out row names the authored glob and its place in the fan-out ({§read})");
        const dogs = JSON.parse(receipts[1].rx) as { content: string; lineOrdinals: number[]; matched: number; lineAnchors: string[] };
        assert.equal(dogs.content, "but I love dogs.\nHistorically, dogs have been...");
        assert.deepEqual(dogs.lineOrdinals, [2, 4], "the lines keep their physical ordinals inside their own file");
        assert.equal(dogs.matched, 2);
        assert.equal(dogs.lineAnchors.length, 2, "every rendered line carries its anchor, so the receipt is an EDIT coordinate source");
        const cats = JSON.parse(receipts[0].rx) as { content: string; matched: number };
        assert.deepEqual([cats.content, cats.matched], ["Most cats are afraid of dogs.", 1]);

        const none = await dispatch(readStmt(urlPath("workspace", "/pets_*.md"), null, { dialect: "glob", raw: "hamster" }));
        assert.equal(none.status, 204, JSON.stringify(none));
        assert.equal(none.matched, 0);
        const empty = (await rows()).at(-1)!;
        assert.deepEqual([empty.op, empty.pathname, empty.status_rx], ["READ", "/pets_*.md", 204], "no matching path is one 204 receipt on the authored glob");

        const scoped = await dispatch(readStmt(urlPath("workspace", "/pets_*.md"), { marks: [1, 2] }, { dialect: "glob", raw: "dogs" }));
        assert.equal(scoped.status, 200, JSON.stringify(scoped));
        assert.equal(scoped.rowsWritten, 2);
        const scopedDogs = JSON.parse((await rows()).at(-1)!.rx) as { content: string; matched: number };
        assert.deepEqual([scopedDogs.content, scopedDogs.matched], ["but I love dogs.", 1], "the authored scope bounds every fanned-out READ");

        const every = await dispatch(readStmt(urlPath("workspace", "/pets_*.md")));
        assert.equal(every.status, 200, JSON.stringify(every));
        assert.equal(every.rowsWritten, 3, "without a pattern every path under the glob is read");
        const previews = (await rows()).slice(-3);
        assert.deepEqual(previews.map(({ op, pathname }) => [op, pathname]), [["READ", "/pets_cats.md"], ["READ", "/pets_dogs.md"], ["READ", "/pets_fish.md"]]);
        assert.equal((JSON.parse(previews[2].rx) as { content: string }).content, "Fish are quiet.", "each path renders its ordinary preview");

        const fullText = await dispatch(readStmt(urlPath("workspace", "/pets_*.md"), null, { dialect: "fts", raw: "~dogs" }));
        assert.equal(fullText.status, 200, JSON.stringify(fullText));
        assert.equal(fullText.rowsWritten, 2);
        const fullTextRows = (await rows()).slice(-2);
        assert.deepEqual(fullTextRows.map(({ op, pathname }) => [op, pathname]), [["READ", "/pets_dogs.md"], ["READ", "/pets_cats.md"]], "FTS ranking retains the higher-relevance resource first");
        assert.deepEqual(fullTextRows.map(({ rx }) => JSON.parse(rx).content), ["but I love dogs.\nHistorically, dogs have been...", "Most cats are afraid of dogs."]);
    } finally { await db.close(); }
});
});

describe("skill-resources", () => {
class CapturingMock extends Mock {
    readonly packets: string[] = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.packets.push(args[0].messages.map(chatMessageText).join("\n\n"));
        return super.generate(...args);
    }
}

const turn = (ops: string, terminal = false) => ({
    assistant: { content: `${ops}\n${PlurnkParser.frame(terminal ? "SEND [200]" : "NOTE", terminal ? "Skill inspected." : null)}`, reasoning: null },
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("{§skills-sources} concurrent operations of independent people discover the shared skill tree", async (t) => {
    await withDaemon(new Mock({ contextWindow: 32768, responses: [] }), async (_db, daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        const created = await rpcCall(ws, 1, "workspace.create", { name: `skill-concurrency-${crypto.randomUUID()}` });
        const workspaceId = (created.result as { id: number }).id;
        const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => (await daemon.dispatchClientAction({
            workspaceId, actor: `test://person-${index}`,
            statements: [{ ...findStmt(parsePath("skill://*/SKILL.md")), lineMarker: { marks: [1, -1] } }],
        }))[0]));
        for (const result of results) {
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.ok(Array.isArray(result.results));
            assert.ok((result.results.flat() as Array<{ path: string }>).some(({ path }) => path === "skill://plurnk/SKILL.md"),
                "every caller receives the shared catalog, not a swallowed publication error");
        }
    });
});

test("{§skills-sources} live trees preserve authority isolation, pattern composition, withdrawal and read-only ownership", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ["alpha", "beta"]) {
        const dir = join(root, ".agents", "skills", name);
        await mkdir(join(dir, "references", "nested"), { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture\n---\nRead references/guide.md.\n`);
        await writeFile(join(dir, "references", "guide.md"), `${name} current guidance\n`);
        await writeFile(join(dir, "references", "nested", "rules.md"), `${name} deep rules\n`);
        await writeFile(join(dir, "binary.bin"), Buffer.from([0, 255, 128]));
        await writeFile(join(dir, "image.png"), PNG);
    }
    await withDaemon(new Mock({ contextWindow: 32768, responses: [] }), async (_db, daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        const created = await rpcCall(ws, 1, "workspace.create", { name: `skill-lifecycle-${crypto.randomUUID()}`, projectRoot: root });
        const workspaceId = (created.result as { id: number }).id;
        const dispatch = async (statement: PlurnkStatement) =>
            (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] }))[0];
        const find = async (target: string, body: ReturnType<typeof regex> | null = null) => {
            const result = await dispatch({ ...findStmt(parsePath(target), body), lineMarker: { marks: [1, -1] } });
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.ok(Array.isArray(result.results));
            return result.results.flat() as Array<{ path: string; items?: number; aside?: string; mimetype?: string; sourceMimetype?: string }>;
        };
        const catalog = await find("skill://*/SKILL.md");
        assert.ok(catalog.some(({ path, aside }) => path === "skill://plurnk/SKILL.md" && Boolean(aside)));
        assert.deepEqual(catalog.filter(({ path }) => path !== "skill://plurnk/SKILL.md").map(({ path, aside }) => ({ path, aside })), [
            { path: "skill://alpha/SKILL.md", aside: "alpha fixture" },
            { path: "skill://beta/SKILL.md", aside: "beta fixture" },
        ]);
        assert.deepEqual((await find("skill://*/references/*")).map(({ path }) => path), [
            "skill://alpha/references/guide.md", "skill://alpha/references/nested/**",
            "skill://beta/references/guide.md", "skill://beta/references/nested/**",
            "skill://plurnk/references/configuration.md", "skill://plurnk/references/copy-move.md", "skill://plurnk/references/extensibility.md", "skill://plurnk/references/models.md",
        ]);
        assert.deepEqual((await find("skill://{alpha,beta}/SKILL.md")).map(({ path }) => path), [
            "skill://alpha/SKILL.md", "skill://beta/SKILL.md",
        ]);
        const unknownType = await dispatch(copyStmt(parsePath("skill://alpha/binary.bin")!, parsePath("workspace:///copied.bin")!));
        assert.equal(unknownType.status, 201, JSON.stringify(unknownType));
        const unknownBytes = await dispatch(readStmt(parsePath("workspace:///copied.bin"), { marks: [1, -1] }));
        assert.equal(unknownBytes.status, 200);
        assert.equal(unknownBytes.content, "00\nff\n80", "{§copy} an untyped destination preserves every source byte");
        assert.equal((await find("workspace:///copied.bin"))[0]?.mimetype, "application/octet-stream");
        const copied = await dispatch(copyStmt(parsePath("skill://alpha/image.png")!, parsePath("workspace:///copied.png")!));
        assert.equal(copied.status, 201, JSON.stringify(copied));
        const bytes = await dispatch(readStmt(parsePath("workspace:///copied.png"), { marks: [1, -1] }));
        assert.equal(bytes.status, 200);
        assert.equal(bytes.content, [...PNG].map((byte) => byte.toString(16).padStart(2, "0")).join("\n"), "COPY preserves source bytes across schemes");
        assert.equal((await find("skill://alpha/binary.bin"))[0]?.mimetype, "application/octet-stream");
        await writeFile(join(root, ".agents", "skills", "alpha", "binary.bin"), "Now a textual source.\n");
        const changedType = (await find("skill://alpha/binary.bin"))[0];
        assert.equal(changedType?.mimetype, "text/markdown");
        assert.equal(changedType?.sourceMimetype, undefined, "a new textual representation cannot retain the old binary source metadata");
        assert.deepEqual((await find("skill://*/references/**", regex("beta"))).map(({ path }) => path), [
            "skill://beta/references/guide.md", "skill://beta/references/nested/rules.md",
        ]);
        const target = parsePath("skill://alpha/references/guide.md");
        assert.match(String((await dispatch(readStmt(target))).content), /alpha current guidance/);
        await writeFile(join(root, ".agents", "skills", "alpha", "references", "guide.md"), "Changed on disk.\n");
        assert.match(String((await dispatch(readStmt(target))).content), /Changed on disk/);
        for (const op of ["````EDIT (skill://alpha/references/guide.md) <1,-1>\nchanged\n````", "````KILL (skill://alpha/references/guide.md)````"]) {
            const parsed = PlurnkParser.parseStatements(op, { executors: fixtureExecutors(op) });
            const item = parsed.items.find((candidate) => candidate.kind === "statement");
            assert.ok(item?.kind === "statement");
            const result = await dispatch(item.statement);
            assert.equal(result.status, 403, JSON.stringify(result));
        }
        await rm(join(root, ".agents", "skills", "alpha", "references", "nested", "rules.md"));
        assert.deepEqual((await find("skill://alpha/references/*")).map(({ path }) => path), ["skill://alpha/references/guide.md"]);
        const context = { scope: "workspace" as const, workspaceId };
        await daemon.invokeModuleAction("workspace.skills.disable", { alias: "alpha" }, context);
        assert.equal((await dispatch(readStmt(target))).status, 404, "disabled resources cannot be read from cached entries");
        assert.deepEqual((await find("skill://*/SKILL.md")).map(({ path }) => path), ["skill://beta/SKILL.md", "skill://plurnk/SKILL.md"]);
        await daemon.invokeModuleAction("workspace.skills.enable", { alias: "alpha" }, context);
        assert.match(String((await dispatch(readStmt(target))).content), /Changed on disk/);
    });
});

for (const [proposals, withOptions] of [
    ["accept", false], ["accept", true], ["reject", false], ["reject", true],
] as const) {
    test(`{§skills-sources} native skill execution preserves siblings and cwd, options=${withOptions}, behind ${proposals} proposal policy`, async (t) => {
        serverProposals(t, proposals);
        const root = await mkdtemp(join(tmpdir(), "plurnk-skill-exec-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const directory = join(root, ".agents", "skills", "sample");
        await mkdir(join(directory, "scripts"), { recursive: true });
        await mkdir(join(directory, "assets"));
        await writeFile(join(directory, "SKILL.md"), "---\nname: sample\ndescription: Run the sample script\n---\nRun scripts/main.mjs.\n");
        await writeFile(join(directory, "scripts", "sibling.mjs"), 'export default "IMPORTED_SIBLING";\n');
        await writeFile(join(directory, "assets", "input.txt"), "RELATIVE_ASSET");
        const script = join(directory, "scripts", "main.mjs");
        const argv = withOptions ? ["--name", "two words", "", "$(touch unwanted)", 'quoted"value', "{", "\\}"] : [];
        const body = withOptions ? `--name "two words" "" "$(touch unwanted)" 'quoted"value' "{" "\\\\}"` : null;
        const marker = join(root, "ran.json");
        await writeFile(script, [
            'import { readFile, writeFile } from "node:fs/promises";',
            'import sibling from "./sibling.mjs";',
            'const asset = await readFile(new URL("../assets/input.txt", import.meta.url), "utf8");',
            'let stdin = ""; for await (const chunk of process.stdin) stdin += chunk;',
            'await writeFile("ran.json", JSON.stringify({ file: import.meta.filename, cwd: process.cwd(), sibling, asset, argv: process.argv.slice(2), stdin }));',
            'console.log("NATIVE_EXEC_COMPLETE");',
        ].join("\n"));
        const provider = new CapturingMock({ contextWindow: 32768, responses: [
            turn("````READ (skill://sample/scripts/main.mjs) <1,-1>````"),
            turn(PlurnkParser.frame("js (skill://sample/scripts/main.mjs)", body)),
            turn("", true),
        ] });
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            t.after(() => ws.close());
            await rpcCall(ws, 1, "workspace.create", { name: `native-skill-${crypto.randomUUID()}`, projectRoot: root });
            const result = await runLoopToTerminal(ws, 2, { prompt: "Execute the installed skill script." });
            assert.equal(result.finalStatus, 200);
            if (proposals === "accept") {
                assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
                    file: script, cwd: root, sibling: "IMPORTED_SIBLING", asset: "RELATIVE_ASSET", argv, stdin: "",
                });
                assert.match(provider.packets.at(-1)!, /NATIVE_EXEC_COMPLETE/);
            } else {
                await assert.rejects(stat(marker), { code: "ENOENT" });
                assert.match(provider.packets.at(-1)!, /reject/i, "the model sees the proposal refusal");
            }
            assert.match(await readFile(script, "utf8"), /IMPORTED_SIBLING|sibling/, "the native script is not removed as a temporary");
        });
    });
}

test("{§skills-sources} {§log-wire-format} a sliced skill asset READ retains its complete native image", async (t) => {
    serverProposals(t, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-image-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, ".agents", "skills", "sample");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: sample\ndescription: Inspect an image\n---\nSee assets/image.png.\n");
    await writeFile(join(dir, "assets", "image.png"), PNG);
    const provider = new CapturingMock({ contextWindow: 32768, inputModalities: ["image"], responses: [
        turn("````READ (skill://sample/assets/image.png#bytes) <1,3>````"),
        turn(""),
        turn("", true),
    ] });
    await withDaemon(provider, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { name: `skill-image-${crypto.randomUUID()}`, projectRoot: root });
        const result = await runLoopToTerminal(ws, 2, { prompt: "Inspect the image." });
        assert.equal(result.finalStatus, 200);
    });
    for (const index of [1, 2]) {
        const images = provider.received[index].flatMap(({ role, content }) =>
            role === "user" && Array.isArray(content) ? content.filter((part) => part.type === "file") : []);
        assert.equal(images.length, 1, "the skill READ contributes exactly one retained native delivery per request");
        assert.equal(images[0]!.mediaType, "image/png");
        assert.deepEqual(Buffer.from(images[0]!.data), PNG);
    }
    assert.match(userText(provider.received[1]), /1:89\n2:50\n3:4e/);
});

test("{§skills-module} a model discovers a skill and reads its original tree through the skill authority", async (t) => {
    serverProposals(t, "accept");
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
    });
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-resources-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, ".agents", "skills", "sample");
    await mkdir(join(dir, "references", "nested"), { recursive: true });
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "SKILL.md"), "---\nname: sample\ndescription: Inspect the sample fixture\nlicense: MIT\n---\nRead [the guide](references/guide.md).\n");
    await writeFile(join(dir, "references", "guide.md"), "REFERENCE_SENTINEL\nSee nested/rules.md.\n");
    await writeFile(join(dir, "references", "nested", "rules.md"), "NESTED_SENTINEL\n");
    await writeFile(join(dir, "assets", "sample.bin"), Buffer.from([0x00, 0xff, 0x81]));
    const provider = new CapturingMock({ contextWindow: 32768, responses: [
        turn("````READ (skill://sample/SKILL.md) <1,-1>````"),
        turn("````FIND (skill://sample/references/**) <1,-1>````\n````READ (skill://sample/references/guide.md) <1,-1>````\n````READ (skill://sample/references/nested/rules.md) <1,-1>````\n````READ (skill://sample/assets/sample.bin) <1,-1>````"),
        turn("", true),
    ] });
    await withDaemon(provider, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { name: `skill-resources-${crypto.randomUUID()}`, projectRoot: root });
        const result = await runLoopToTerminal(ws, 2, { prompt: "Inspect the installed sample skill." });
        assert.equal(result.finalStatus, 200);
        assert.match(provider.packets[0], /skill:\/\/sample\/SKILL\.md/, "initial discovery addresses the source skill");
        assert.match(provider.packets[0], /Inspect the sample fixture/, "initial discovery carries the standard description");
        assert.doesNotMatch(provider.packets[0], /REFERENCE_SENTINEL|NESTED_SENTINEL/, "supporting bodies are not injected by discovery");
        assert.match(provider.packets[1], /license: MIT/, "READ preserves optional frontmatter, not a rewritten synopsis");
        assert.match(provider.packets[1], /references\/guide\.md/, "source-relative links survive unchanged");
        assert.match(provider.packets[2], /REFERENCE_SENTINEL/);
        assert.match(provider.packets[2], /NESTED_SENTINEL/);
        const binaryRequest = provider.packets[2].indexOf("```READ (skill://sample/assets/sample.bin) <1,-1>\n```");
        assert.ok(binaryRequest >= 0, "the complete binary READ replays with its turn, before the turn's results");
        const reads = provider.packets[2].slice(binaryRequest).split(/\n\n(?=### log:\/\/\/)/).filter((section) => /^### log:\/\/\/1\/3\/\d+\/READ \(skill:\/\/sample\/\S+\) · \d+$/m.test(section));
        assert.equal(reads.length, 3, "the turn's READ receipts follow it, in program order");
        assert.match(reads.at(-1)!, /\n1:00\n2:ff\n3:81/, "binary assets use the ordinary byte projection");
    });
});
});
