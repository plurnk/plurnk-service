import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Session from "../../src/schemes/Session.ts";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import { type LineMarker, type MatcherBody, type ParsedPath, type ReadStatement, type FindStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, Results, type SchemeHandler } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, insertOperationTurn, rootWorkspace, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx, DEFAULT_MIMETYPES, schemeManifest } from "./_scheme.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { contentWeight } from "../../src/core/content-weight.ts";
import { type AnchoredReadResult } from "../../src/content/read-projector.ts";
import { editStmt, readStmt, urlPath, copyStmt, findStmt, regex } from "./_dsl.ts";
import { fixtureExecutors, userText } from "./_mock.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { connect, rpcCall, withDaemon, runLoopToTerminal } from "./_rpc.ts";


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

