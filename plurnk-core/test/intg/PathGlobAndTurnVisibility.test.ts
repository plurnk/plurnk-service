import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import Turn from "../../src/core/Turn.ts";
import LineAnchors, { type LineAnchorPrecondition } from "../../src/content/line-anchors.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import Fork from "../../src/core/fork.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import EntryOps from "../../src/schemes/_entry-ops.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import { serverProposals, ownSession, TEST_OWNER } from "./_approval.ts";
import { type EditStatement, type PlurnkStatement, type OperationResult, type ReadStatement, PathSyntax } from "@plurnk/plurnk-contracts";
import { Mock, chatMessageText, type MockResponse, type ChatMessage } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { openMigrated, seedEnvelope, insertWorkspace, insertSession, insertLoop, seedEntryWithChannel, insertTurn } from "./_db.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse, fixtureExecutors } from "./_mock.ts";
import { type SchemeManifest, type EntryData, type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { killStmt, urlPath, localPath, editStmt, readStmt, copyStmt, moveStmt, sendStmt, noteStmt, dispositionStmt, fullReplace, regex } from "./_dsl.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { type Db } from "../../src/core/Db.ts";
import { resourcePaths } from "./_find.ts";
import { type FindResult } from "../../src/schemes/_entry-find.ts";
import { logEntries } from "./_packet.ts";
import { statement as parseSingleStatement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";
import { pathToFileURL } from "node:url";
import { CoreSchemeAdapterBase, type CoreSchemeCallContext } from "../../src/core/CoreSchemeServices.ts";


describe("end_to_end_mock", () => {
const e2eEditStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "edit", aside: null,
    target: urlPath("workspace", pathname),
    lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[], content: string = ""): MockResponse => ({
    assistant: { content, ops, reasoning: null },
});

const seedEnvelopeNoTurn = async (db: Db, label: string): Promise<{ workspaceId: number; sessionId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, label);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "main");
    return { workspaceId, sessionId, loopId };
};

const dispatchTurn = async (
    engine: Engine, provider: Mock, db: Db,
    ctx: { workspaceId: number; sessionId: number; loopId: number },
): Promise<{ turnId: number; statuses: number[] }> => {
    const { assistant } = await provider.generate({ messages: [] });
    const ops = (assistant.ops ?? []) as PlurnkStatement[];
    const { id: turnId } = await Turn.open(db, { loopId: ctx.loopId, producer: "model", kind: "inference" });
    const statuses: number[] = [];
    for (const [i, statement] of ops.entries()) {
        const result = await engine.dispatch({
            statement, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId,
            turnId, sequence: i + 1, origin: "model",
        });
        statuses.push(result.status);
    }
    await Turn.complete(db, turnId, 102);
    return { turnId, statuses };
};

test("{§loop-completion} e2e: single-turn EDIT + SEND — entry created, log rows populated, statuses match", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-single");
        const provider = new Mock({
            contextWindow: 100000,
            // {§loop-completion} — an EDIT receipt lands next packet, so the turn continues.
            responses: [response([e2eEditStmt("/france/capital", "Paris"), noteStmt("answered")])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await dispatchTurn(engine, provider, db, env);
        assert.deepEqual(result.statuses, [201, 200], "EDIT created → 201; NOTE retained → 200");

        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: env.workspaceId, scheme: "workspace", pathname: "/france/capital",
        });
        assert.ok(entry !== undefined);

        const logRows = await db.test_log_entries_by_turn.all<{ op: string; sequence: number; status_rx: number; pathname: string | null }>({ turn_id: result.turnId });
        assert.equal(logRows.length, 2);
        assert.equal(logRows[0]?.op, "edit");
        assert.equal(logRows[0]?.sequence, 1);
        assert.equal(logRows[0]?.status_rx, 201);
        assert.equal(logRows[0]?.pathname, "/france/capital");
        assert.equal(logRows[1]?.op, "note");
        assert.equal(logRows[1]?.sequence, 2);
        assert.equal(logRows[1]?.status_rx, 200);
        assert.equal(logRows[1]?.pathname, null);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} e2e: three EDITs in one turn — sequence 1/2/3, three entries written", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-three");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([
                e2eEditStmt("/a", "1"), e2eEditStmt("/b", "2"), e2eEditStmt("/c", "3"),
                noteStmt("more"),
            ])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await dispatchTurn(engine, provider, db, env);
        assert.deepEqual(result.statuses, [201, 201, 201, 200]);

        const count = (await db.test_count_entries_by_workspace.get<{ n: number }>({ workspace_id: env.workspaceId }))?.n;
        assert.equal(count, 3);

        const indices = await db.test_log_entries_by_turn.all<{ sequence: number }>({ turn_id: result.turnId });
        assert.deepEqual(indices.map((r) => r.sequence), [1, 2, 3, 4]);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} e2e: cross-turn state — turn 2 sees entry written in turn 1", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-multi");
        const message = await db.message_source_resources.get<{ path: string }>({ workspace_id: env.workspaceId, scheme: "message", target: null });
        assert.ok(message);
        const e2eReadStmt = (pathname: string): PlurnkStatement => ({
            metadata: null,
            op: "read", aside: null,
            target: urlPath("workspace", pathname),
            lineMarker: null, matcher: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([e2eEditStmt("/state", "from turn 1"), noteStmt("continuing")]),
                response([e2eReadStmt("/state"), noteStmt("reading")]),
                response([sendStmt(parsePath(message.path), "done")]),
            ],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const turn1 = await dispatchTurn(engine, provider, db, env);
        const turn2 = await dispatchTurn(engine, provider, db, env);
        const turn3 = await dispatchTurn(engine, provider, db, env);
        assert.notEqual(turn1.turnId, turn2.turnId);
        assert.deepEqual(turn1.statuses, [201, 200]);
        assert.deepEqual(turn2.statuses, [200, 200], "READ → 200; the continue receives the result next turn");
        assert.deepEqual(turn3.statuses, [200], "the reply is delivered after the read");

        const turn2Reads = (await db.test_log_entries_by_turn.all<{ sequence: number; status_rx: number; pathname: string; op: string }>({ turn_id: turn2.turnId }))
            .filter((r) => r.op === "read");
        assert.equal(turn2Reads.length, 1);
        assert.equal(turn2Reads[0]?.sequence, 1, "sequence resets per turn (1-based)");
        assert.equal(turn2Reads[0]?.status_rx, 200);
        assert.equal(turn2Reads[0]?.pathname, "/state");
    } finally { await db.close(); }
});

test("{§provider-instantiation} e2e: Mock queue exhaustion throws after the expected provider call", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-exhaust");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([e2eEditStmt("/only", "x"), sendStmt(null, "")])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await dispatchTurn(engine, provider, db, env);
        await assert.rejects(() => dispatchTurn(engine, provider, db, env), /Mock provider exhausted/);
    } finally { await db.close(); }
});
});

describe("entry-publication", () => {
const coordinate = { authority: "", pathname: "/shared.md" };
const version = (name: string): EntryData => ({
    attributes: { version: name },
    channels: {
        body: { content: name, mimetype: "text/plain" },
        evidence: { content: name, mimetype: "text/plain" },
    },
});

test("{§scheme-manifest} republishing preserves unchanged derivations and invalidates only changed representations", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-identity-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
    const publication = await EntryCrud.writeEntry(coordinate, version("before"), ctx, "session");
    assert.ok(publication.entryId);
    const hashes = () => db.test_channel_hashes_for_entry.all<{ name: string; deep_hash: string | null; content_hash: string }>({ entry_id: publication.entryId! });
    await SearchIndex.maintain(ctx);
    const before = await hashes();
    assert.ok(before.every(({ deep_hash }) => deep_hash !== null), "initial channels have completed derivations");

    await Promise.all(Array.from({ length: 8 }, () => EntryCrud.writeEntry(coordinate, version("before"), ctx, "session")));
    assert.deepEqual(await hashes(), before, "concurrent unchanged publication cannot invalidate another session's settled FIND");

    const changed = version("before");
    changed.channels.evidence.content = "after";
    await EntryCrud.writeEntry(coordinate, changed, ctx, "session");
    const after = await hashes();
    assert.deepEqual(after[0], before[0], "the unchanged body retains its artifact");
    assert.equal(after[1].deep_hash, null, "changed content cannot retain stale search evidence");
    assert.notEqual(after[1].content_hash, before[1].content_hash);

    await SearchIndex.maintain(ctx);
    changed.channels.evidence.mimetype = "text/markdown";
    await EntryCrud.writeEntry(coordinate, changed, ctx, "session");
    assert.equal((await hashes())[1].deep_hash, null, "a changed mimetype also invalidates the representation");
    delete changed.channels.evidence;
    await EntryCrud.writeEntry(coordinate, changed, ctx, "session");
    assert.deepEqual(await hashes(), [before[0]], "omitted channels are still removed by whole-entry publication");
});

for (const existing of [false, true]) {
    test(`{§scheme-manifest} concurrent whole-entry publication preserves one complete version; existing=${existing}`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `publication-${crypto.randomUUID()}`);
        const sessions = await Promise.all(Array.from({ length: 8 }, () => insertSession(db, workspaceId)));
        const contexts = sessions.map((sessionId) => makeSchemeCtx({ db, workspaceId, sessionId }));
        if (existing) await EntryCrud.writeEntry(coordinate, version("before"), contexts[0], "session");

        const outcomes = await Promise.allSettled(contexts.map((ctx, index) =>
            EntryCrud.writeEntry(coordinate, version(`version-${index}`), ctx, "session")));
        for (const result of outcomes) assert.equal(result.status, "fulfilled", String(result.status === "rejected" ? result.reason : result.value));
        const publications = outcomes.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        assert.equal(new Set(publications.map(({ entryId }) => entryId)).size, 1, "the resource retains one identity");
        assert.equal(publications.filter(({ created }) => created).length, existing ? 0 : 1, "creation is claimed once");
        const read = await EntryCrud.readEntry(coordinate, contexts[0], "session");
        assert.equal(read.status, 200);
        const name = read.entry?.attributes?.version;
        assert.match(String(name), /^version-[0-7]$/);
        assert.deepEqual(Object.keys(read.entry!.channels).toSorted(), ["body", "evidence"]);
        assert.equal(read.entry!.channels.body.content, name);
        assert.equal(read.entry!.channels.evidence.content, name, "metadata and all channels belong to the same publication");
    });
}

test("{§scheme-manifest} a rejected channel rolls back the whole replacement, including attributes", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-rollback-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
    await EntryCrud.writeEntry(coordinate, version("before"), ctx, "session");
    const before = await EntryCrud.readEntry(coordinate, ctx, "session");
    const replacement = version("after");
    replacement.channels.evidence.state = "invalid" as never;
    await assert.rejects(
        EntryCrud.writeEntry(coordinate, replacement, ctx, "session"),
        /CHECK constraint failed: state IN/,
    );
    assert.deepEqual(await EntryCrud.readEntry(coordinate, ctx, "session"), before,
        "a failed publication does not leave partial content or metadata");
});
});

describe("lifecycle-notes", () => {

test("{§turn-source-resources} #713: notes have durable sources, normal log curation, and do not block completion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lifecycle-notes");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the parser and report the result.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reasoning = "await plurnk.edit({\"path\":\"should-not-exist.txt\",\"content\":\"Never execute reasoning edits.\"});";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: ["await plurnk.note({\"text\":\"The network is not the cause.\"});", "await plurnk.note({\"text\":\"Inspect the parser next.\"});"].join("\n\n"), reasoning } },
            { assistant: { content: "await plurnk.kill({\"path\":\"log:///1/2/*/note\"});", reasoning: null } },
            { assistant: { content: ["await plurnk.note({\"text\":\"Both checks passed.\"});", "await plurnk.done({\"text\":\"Finished.\"});"].join("\n\n"), reasoning: null } },
        ] });
        const first = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(first.status, 102);
        const second = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const notes = logEntries(packet).filter((row) => /^log:\/\/\/1\/2\/\d+\/note$/.test(row.logPath));
        assert.equal(notes.length, 2, "reasoning and content NOTEs both retain ordinary receipt addresses");
        assert.deepEqual(notes.map((row) => row.resource), notes.map((row) => `note://alice/${row.logPath.replace(/^log:\/\/\//u, "").replace(/\/note$/u, "")}`), "each ordinary receipt exposes its recoverable source at its own coordinate");
        assert.ok(notes.every((row) => row.origin === undefined || row.origin === "model"));
        // Source identity never depends on the reader ({§turn-source-resources}); alice's later packets are under test.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const read = (source: string, reader = observer) => clientRead(engine, db, { workspaceId, sessionId: reader, statement: parseSingleStatement(source) });
        const firstSource = await read(`await plurnk.read({"path":"${String(notes[0].resource)}","range":"1,-1"});`);
        assert.equal(firstSource.status, 200);
        assert.equal(firstSource.content, "The network is not the cause.");
        const contentNote = /^log:\/\/\/(1\/2\/\d+)\/note$/u.exec(notes[1].logPath)?.[1];
        assert.ok(contentNote, "the content NOTE has its own receipt coordinate");
        const secondSource = await read(`await plurnk.read({"path":"note://alice/${contentNote}","range":"1,-1"});`);
        assert.equal(secondSource.content, "Inspect the parser next.", "the receipt coordinate reads the content NOTE's durable source");
        const final = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(final.status, 200, "an extracted note is not an unseen external result");
        const finalPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: final.turnId }))!.packet);
        assert.equal(logEntries(finalPacket).filter((row) => /^log:\/\/\/1\/2\/\d+\/note$/.test(row.logPath)).length, 0);
        const sourceAgain = await read(`await plurnk.read({"path":"${String(notes[0].resource)}","range":"1,-1"});`);
        assert.equal(sourceAgain.content, "The network is not the cause.", "curating the log does not delete the source note");
        const rawReasoning = await read("await plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"1,-1\"});");
        assert.equal(rawReasoning.content, reasoning);
        const found = await engine.dispatch({ ...context, turnId: final.turnId, sequence: 40, origin: "model",
            statement: parseSingleStatement("await plurnk.find({\"path\":\"note://alice/1/2/*\",\"pattern\":\"/parser/\"});"),
        });
        assert.equal(found.status, 200);
        assert.deepEqual(resourcePaths(found as FindResult), [`note://alice/${contentNote}`], "source search still works after log curation");
        const fork = await Fork.fork(db, sessionId, "branch");
        const inherited = await read(`await plurnk.read({"path":"${String(notes[0].resource).replace("note://alice/", "note://branch/")}","range":"1,-1"});`, fork);
        assert.equal(inherited.content, firstSource.content, "FORK preserves source identity and content");
        for (const op of ["edit", "kill"]) {
            const refused = await engine.dispatch({ ...context, turnId: final.turnId, sequence: op === "edit" ? 50 : 51, origin: "model",
                statement: parseSingleStatement(`await plurnk.${op.toLowerCase()}(${JSON.stringify({ path: String(notes[0].resource), ...(op === "edit" ? { content: "Changed" } : {}) })});`),
            });
            assert.equal(refused.status, 403, `${op} cannot change immutable note evidence`);
        }
        const missing = await read("await plurnk.read({\"path\":\"note://alice/1/2/99\"});");
        assert.equal(missing.status, 404, "an absent note is not an invented empty source");
    } finally { await db.close(); }
});

test("{§loop-completion} empty WAIT falls through and SEND plus a retrieval observes before concluding", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lifecycle-fallthrough");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the recorded operations, then answer.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "await plurnk.wait({\"text\":\"Wait for results.\"});", reasoning: null } },
            { assistant: { content: ["await plurnk.send({\"text\":\"The answer.\"});", "await plurnk.read({\"path\":\"ops://alice/1/1\",\"range\":\"1,-1\"});"].join("\n\n"), reasoning: null } },
            { assistant: { content: "await plurnk.done({});", reasoning: null } },
        ] });
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 200);
    } finally { await db.close(); }
});

test("{§op-shapes} {§parse-recovery}: a lost boundary admits the NOTE beside it and records the loss", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lost-boundary-reasoning-note");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: `await plurnk.note({"text":"Kept despite the broken program."});\n\nawait plurnk.read({"path":"unfinished`, reasoning: null } },
            { assistant: { content: "await plurnk.done({\"text\":\"Finished.\"});", reasoning: null } },
        ] });
        const first = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(first.status, 102);
        assert.deepEqual((await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first.turnId })).map(({ accepted }) => accepted), [1],
            "an admitted operation is a closed operational statement, a NOTE as much as a READ: no resample");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; source: string | null }>({ turn_id: first.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["note", "error"], "the NOTE ran; the loss is the model's own diagnostic row");
        assert.ok(rows.some(({ op, source }) => op === "error" && source === "grammar"), "the lost boundary is one hard diagnostic the model sees");
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 200);
    } finally { await db.close(); }
});

test("{§op-shapes} {§emission-admission}: a rejected emission cannot commit its reasoning", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "rejected-reasoning-note");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const rejectedReasoning = "await plurnk.note({\"text\":\"This belongs to the rejected attempt.\"});";
        const acceptedReasoning = "await plurnk.note({\"text\":\"This belongs to the accepted attempt.\"});";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            // {§emission-admission} — the model writing the harness's log is the refusal that remains.
            { assistant: { content: "### log:///1/2/1/note\nI am the harness.", reasoning: rejectedReasoning } },
            { assistant: { content: "await plurnk.done({\"text\":\"Finished.\"});", reasoning: acceptedReasoning } },
        ] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 200);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 1]);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        const notes = sources.filter(({ kind }) => kind === "reasoning");
        assert.equal(notes.filter(({ content }) => content === acceptedReasoning).length, 1);
        assert.ok(notes.every(({ content }) => content !== rejectedReasoning));
        const reasoning = await clientRead(engine, db, { workspaceId, sessionId, statement: parseSingleStatement("await plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"1,-1\"});") });
        assert.equal(reasoning.content, acceptedReasoning);
    } finally { await db.close(); }
});
});

describe("mcp-ordered-admission", () => {
for (const scenario of ["add", "inline", "accept", "reject", "cancel", "invalid", "enable", "disable", "remove", "deny", "quoted"] as const) {
    test(`{§fence-pairing} {§op-methods-op-dispatch}: ${scenario} resolves a new MCP invocation at its execution point`, { timeout: 30_000 }, async (t) => {
        const manual = scenario === "accept" || scenario === "reject" || scenario === "cancel";
        serverProposals(t, manual ? "review" : "accept");
        const received: unknown[] = [];
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name: "ordered-fixture", version: "1.0.0" });
            server.registerTool("inspect", {
                inputSchema: fromJsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async (args) => {
                received.push(args);
                return { content: [{ type: "text", text: "ordered-tool-result" }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        const definition = httpEntry(served.url);
        const { hostPaths, env } = await mcpFixture(t, scenario === "enable" ? { fresh: definition } : {});
        if (scenario === "enable") env.PLURNK_MCP_fresh_ENABLED = "0";
        const command = scenario === "enable" ? "enable" : "add";
        const params = command === "enable" ? { alias: "fresh", enabled: true }
            : { alias: "fresh", ...(scenario === "invalid" ? { type: "not-a-transport" } : definition) };
        const args = '{"query":"unchanged"}';
        const invocation = `await fresh.inspect(${args});`;
        const source = [
            `await plurnk.mcp(${JSON.stringify(params)});`,
            ...(scenario === "disable" ? [`await plurnk.mcp(${JSON.stringify({ alias: "fresh", enabled: false })});`] : []),
            ...(scenario === "remove" ? [`await plurnk.mcp(${JSON.stringify({ alias: "fresh", remove: true })});`] : []),
            scenario === "inline" ? `await fresh.inspect(${args});`
                : scenario === "quoted" ? `\`\`\`markdown\n${invocation}\n\`\`\`` : invocation,
            "await plurnk.note({\"text\":\"Observe the result.\"});",
        ].join("\n\n");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeRawMockResponse(source), makeRawMockResponse("await plurnk.done({\"text\":\"Finished.\"});"),
        ] });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, hostPaths });
        daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `ordered-${scenario}` });
        const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
        if (manual) await ownSession(db, workspaceId, sessionId);
        if (scenario === "deny") await daemon.setWorkspaceCapabilities({ workspaceId, policy: { deny: [{ runtime: "fresh", tool: "inspect" }] } });
        assert.ok(!daemon.executorTags(workspaceId).includes("fresh"), "the parser is not preloaded with the new runtime");
        const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Configure the server and inspect it.", maxTurns: 2 });
        if (manual) {
            const proposals = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
            assert.deepEqual(received, [], "the invocation cannot run while addition awaits approval");
            assert.ok(!daemon.executorTags(workspaceId).includes("fresh"));
            if (scenario === "cancel") await daemon.cancelSession({ workspaceId, sessionId, reason: "cancelled before approval" });
            else await daemon.resolveProposal(proposals[0].logEntryId, { decision: scenario }, { workspaceId, address: TEST_OWNER });
        }
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
        if (scenario === "cancel") {
            await waitForDb(() => daemon.readLog({ workspaceId, sessionId }), (rows) =>
                rows.some((row) => row.origin === "model" && row.op === "plurnk" && row.status_rx === 499));
        }
        const succeeds = !["reject", "cancel", "invalid", "disable", "remove", "deny", "quoted"].includes(scenario);
        assert.deepEqual(received, succeeds ? [{ query: "unchanged" }] : [], "only the actually published capability can be invoked");
        const rows = await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER });
        const invoked = rows.filter((row) => row.origin === "model" && row.op === "fresh");
        const configured = rows.filter((row) => row.origin === "model" && row.op === "plurnk");
        assert.ok(configured.length > 0);
        if (scenario === "quoted" || scenario === "cancel") {
            assert.deepEqual(invoked, [], "quotation and cancellation never admit an invocation");
        } else {
            assert.equal(invoked.length, 1, "the new invocation is admitted exactly once, never relegated to outside text");
            assert.equal(invoked[0].status_rx, succeeds ? 200 : scenario === "deny" ? 403 : 400);
            if (!succeeds && scenario !== "deny") {
                const result = invoked[0].rx as OperationResult;
                assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");
                assert.equal(result.problem?.requestedRuntime, "fresh");
            }
            assert.ok(configured.every((row) => row.turn_id === invoked[0].turn_id), "configuration and invocation occurred in the same real turn");
        }
        if (scenario === "cancel") {
            assert.equal(configured[0].status_rx, 499);
            assert.ok(!daemon.executorTags(workspaceId).includes("fresh"));
            assert.equal(provider.received.length, 1, "cancellation never resumes inference");
        } else if (scenario === "reject") {
            assert.equal(configured[0].status_rx, 400);
            assert.equal((configured[0].rx as OperationResult).problem?.type, "https://problems.plurnk.xyz/proposal/rejected");
        } else if (scenario === "invalid") assert.equal(configured[0].status_rx, 400);
        else assert.ok(configured.every((row) => row.status_rx !== null && row.status_rx >= 200 && row.status_rx < 300));
        assert.equal(await lifecycle.status(loop.loopId), scenario === "cancel" ? 499 : 200);
    });
}
});

describe("operation-cancellation", () => {
for (const shape of ["separate", "glob", "final"] as const) {
    test(`{§op-methods-op-dispatch}: cancellation after the first ${shape} mutation retains it and stops the program`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `cancel-${shape}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "edit the entries");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const entries = await Promise.all(["/a.txt", "/b.txt"].map((pathname) =>
            seedEntryWithChannel(db, { workspaceId, pathname, content: "original" })));
        const paths = shape === "glob" ? ["workspace:///*.txt"]
            : shape === "separate" ? ["workspace:///a.txt", "workspace:///b.txt"] : ["workspace:///a.txt"];
        const source = paths.map((path) => `await plurnk.edit({"path":"${path}","range":"1,-1","content":"changed"});`).join("\n\n");
        const provider = new Mock({ contextWindow: 100_000, responses: [makeRawMockResponse(source, 37)] });
        const abort = new AbortController();
        const reason = new Error("cancel after the first committed effect");
        t.after(engine.bindLoopSignal(loopId, abort.signal));
        let cancelledAt: number | undefined;
        await assert.rejects(engine.runTurn({
            provider, workspaceId, sessionId, loopId, signal: abort.signal,
            messages: [{ role: "user", content: "Edit the entries." }],
            onSettled: async (id) => {
                const rows = await db.test_log_entries_by_session.all<{ id: number; origin: string; op: string }>({ session_id: sessionId });
                if (cancelledAt === undefined && rows.some((row) => row.id === id && row.origin === "model" && row.op === "edit")) {
                    cancelledAt = id;
                    abort.abort(reason);
                }
            },
        }), (cause) => cause === reason);
        assert.ok(cancelledAt !== undefined, "the first real effect settled before cancellation");
        const content = await Promise.all(entries.map(async (entryId) =>
            (await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "body" }))?.content));
        assert.deepEqual(content, ["changed", "original"], "cancellation preserves the committed effect and never applies the next one");
        const rows = await db.test_log_entries_by_session.all<{ id: number; origin: string; op: string; status_rx: number }>({ session_id: sessionId });
        assert.deepEqual(rows.filter((row) => row.origin === "model" && row.op === "edit").map(({ id, status_rx }) => [id, status_rx]), [[cancelledAt, 200]]);
        const turns = await db.test_list_turns_in_loop.all<{ kind: string; status: number; completed_at: string | null }>({ loop_id: loopId });
        const inference = turns.find(({ kind }) => kind === "inference");
        assert.equal(inference?.status, 499);
        assert.ok(inference?.completed_at);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        assert.ok(sources.some((row) => row.kind === "ops" && row.content === source), "the complete authored program remains evidence");
        assert.equal((await engine.loopUsage(loopId)).accounting.usage?.outputTokens, 37, "cancellation does not discard completed inference accounting");
    });
}
});

describe("packet-envelope", () => {
// {§turn-source-resources} {§emission-history}: durable programs, curatable records, complete retained operations.










const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });
const surveyRead = "await plurnk.read({\"path\":\"reasoning://analyst/1/1\"});";
const userText = (request: readonly ChatMessage[]): string => request.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");
const previous = (request: readonly ChatMessage[]): string => request.filter(({ role }) => role === "assistant").map(chatMessageText).join("\n\n");

const run = async (name: string, prompt: string, responses: ReturnType<typeof say>[], maxTurns: number) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, name);
    const sessionId = await insertSession(db, workspaceId, null, "analyst");
    const loopId = await insertLoop(db, sessionId, 1, prompt);
    const provider = new Mock({ contextWindow: 100000, responses });
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    const result = await engine.runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns });
    const rows = await db.test_emission_rows_by_session.all<{
        coordinate: string; origin: string; op: string; scheme: string; hostname: string; pathname: string;
        attrs: string; rx: string; initial_folded: string; active: number; folded: string;
    }>({ session_id: sessionId });
    return { db, result, provider, rows, workspaceId, sessionId, loopId, engine, schemes };
};

test("{§emission-history}: curation removes memory receipts; source READ still restores exact bodies", async (t) => {
    const body = Array.from({ length: 120 }, (_, index) => `FULL-BODY line ${index + 1}`).join("\n");
    const first = `await plurnk.edit({"path":"workspace:///memory.md","content":${JSON.stringify(body)}}); // remember\n\nawait plurnk.note({"text":"CURATABLE-MEMORY: retain the actual observation."});`;
    const curate = "await plurnk.kill({\"path\":\"log:///1/2/*/note\"});";
    const read = "await plurnk.read({\"path\":\"ops://analyst/1/2\",\"range\":\"1,-1\"});";
    const { db, result, provider, rows, sessionId } = await run("envelope-source", "Work, curate, then inspect your original program.", [
        say(first, "await plurnk.note({\"text\":\"REASONING-MEMORY: independent reasoning note.\"});"),
        say(curate), say(read), say("await plurnk.done({\"text\":\"Complete.\"});"),
    ], 5);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 4);
    const edit = `await plurnk.edit({"path":"workspace:///memory.md","content":${JSON.stringify(body)}}); // remember`;
    assert.equal(previous(provider.received[1]), first, "EDIT and NOTE replay whole");
    assert.doesNotMatch(userText(provider.received[1]), /REASONING-MEMORY/u);
    assert.doesNotMatch(userText(provider.received[1]), /CURATABLE-MEMORY/u, "the paired NOTE receipt does not duplicate its body");
    assert.equal(previous(provider.received[2]), edit, "the curated NOTE leaves the replay; the surviving EDIT remains");
    assert.doesNotMatch(userText(provider.received[2]), /CURATABLE-MEMORY/u, "the curated NOTE has no historical replay duplicate");
    assert.equal(previous(provider.received[3]), `${edit}\n\n${read}`, "the explicit source READ joins the surviving history");
    assert.match(userText(provider.received[3]), /CURATABLE-MEMORY/u, "an explicit READ retrieves the complete program");
    assert.match(userText(provider.received[3]), /FULL-BODY line 120/u);
    const reads = await db.test_log_entries_by_session_op_full.all<{ pathname: string; rx: string }>({ session_id: sessionId, op: "read" });
    assert.ok(reads.some(({ pathname, rx }) => pathname === "/1/2" && (JSON.parse(rx) as { content?: string }).content === first));
    assert.equal((JSON.parse(rows.find(({ coordinate }) => coordinate.startsWith("1/2/"))!.rx) as { content: string }).content, first);
});

test("{§turn-source-resources}: initialization has no replay; canonical content carries interstitial text as the NOTEs it became and preserves row chronology", async (t) => {
    const canonical = `await plurnk.note({"text":"Let me look around first."});\n\n${surveyRead}\n\nawait plurnk.note({"text":"Bearings: nothing read yet."});\n\nawait plurnk.note({"text":"Done for now."});`;
    const { db, result, provider, rows } = await run("envelope-chronology", "Answer.", [
        say(`Let me look around first.\n\n${surveyRead}\n\nawait plurnk.note({"text":"Bearings: nothing read yet."});\n\nDone for now.`), say("await plurnk.done({\"text\":\"Answer.\"});"),
    ], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.deepEqual(rows.map(({ coordinate }) => coordinate), ["1/2/2", "1/3/1"]);
    for (const row of rows) {
        assert.equal(row.origin, "_plurnk");
        assert.equal(row.op, "read");
        assert.equal(row.scheme, "ops");
        assert.equal(row.pathname, `/${row.coordinate.split("/").slice(0, 2).join("/")}`);
        assert.deepEqual(JSON.parse(row.initial_folded), [[1, -1]]);
        assert.equal(row.active, 1);
    }
    assert.equal(previous(provider.received[0]), "");
    assert.equal(previous(provider.received[1]), canonical, "normalization preserves each operation at its position");
    assert.equal(JSON.parse(rows[0].rx).content, canonical, "the frozen row preserves the complete admitted program, interstitial text as NOTEs at their positions");
    assert.match(userText(provider.received[1]), /### log:\/\/\/1\/2\/1\/send[\s\S]*### log:\/\/\/1\/2\/2\/emission[\s\S]*### log:\/\/\/1\/2\/4\/read/u);
    const request = provider.received[1];
    assert.deepEqual(request.map(({ role }) => role), ["system", "user", "assistant", "user"], "the turn replays as one assistant message");
    assert.match(chatMessageText(request[1]), /### log:\/\/\/1\/2\/1\/send[\s\S]*### log:\/\/\/1\/2\/2\/emission[^\n]*$/u, "incoming observations precede the content operations");
    assert.match(chatMessageText(request[3]), /^### log:\/\/\/1\/2\/3\/note[\s\S]*### log:\/\/\/1\/2\/4\/read/u, "the turn's results follow the operations that caused them");
});

test("{§turn-source-resources}: curation retires the immediately preceding emission without reviving an older one", async (t) => {
    const mode = process.env.PLURNK_SERVICE_EMISSION_HISTORY;
    process.env.PLURNK_SERVICE_EMISSION_HISTORY = "latest";
    t.after(() => { if (mode === undefined) delete process.env.PLURNK_SERVICE_EMISSION_HISTORY; else process.env.PLURNK_SERVICE_EMISSION_HISTORY = mode; });
    const newest = "await plurnk.note({\"text\":\"Newest memory.\"});";
    const f = await run("envelope-retire", "Work.", [say(`${surveyRead}\n\nawait plurnk.note({"text":"Older memory."});`), say(`${newest}\n\nawait plurnk.send({"text":"Newest program."});`)], 2);
    t.after(() => f.db.close());
    const builder = new PacketBuilder({ db: f.db, schemes: f.schemes, executors: () => undefined });
    const build = () => builder.buildRequestPacket({ ...f, initialMessages: [], currentTurnSeq: 5, gitStatus: null });
    assert.equal(PacketWire.sectionContent(await build(), "emission-history"), `${newest}\n\nawait plurnk.send({"text":"Newest program."});`);
    const last = f.rows.at(-1)!;
    const turnId = await insertTurn(f.db, f.loopId, 4);
    const result = await f.engine.dispatch({ ...f, turnId, sequence: 1, origin: "model", statement: killStmt(urlPath("log", `/${last.coordinate}/emission`)) });
    assert.equal(result.status, 200);
    assert.equal(PacketWire.sectionContent(await build(), "emission-history"), "");
    assert.ok(PacketWire.sectionContent(await build(), "log").includes("log:///1/2/2/emission"), "an older live emission is not replayed");
});

test("{§turn-source-resources}: a scoped KILL cannot partially curate a program; a sweep preserves it and an unscoped KILL retires it", async (t) => {
    const { db, result, provider, rows } = await run("envelope-scope", "Answer.\nSecond line.\nThird line.", [
        say("await plurnk.edit({\"path\":\"workspace:///scope.md\",\"content\":\"line one\\nline two\\nline three\"});"),
        say("await plurnk.kill({\"path\":\"log:///1/2/2/emission\",\"range\":\"1,-1\"});"),
        say("await plurnk.kill({\"path\":\"log:///1/2/*\",\"range\":\"2,3\"});"),
        say("await plurnk.kill({\"path\":\"log:///1/2/2/emission\"});"), say("await plurnk.done({\"text\":\"Answer.\"});"),
    ], 6);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.match(userText(provider.received[2]), /### log:\/\/\/1\/3\/\d+\/kill[^\n]*\n\{[^\n]*"status":422/u);
    assert.match(userText(provider.received[2]), /is an emission; curate it without a line scope/u);
    assert.match(userText(provider.received[2]), /await plurnk\.kill\(\{ path: \\"log:\/\/\/1\/2\/2\/emission\\" \}\); retires it\./u, "the recovery names the one form that retires it");
    assert.match(userText(provider.received[2]), /### log:\/\/\/1\/2\/2\/emission/u);
    assert.match(userText(provider.received[3]), /### log:\/\/\/1\/2\/2\/emission/u, "a partial sweep leaves it intact");
    assert.doesNotMatch(userText(provider.received[4]), /### log:\/\/\/1\/2\/2\/emission/u, "the unscoped KILL retires it");
    const retired = rows.find(({ coordinate }) => coordinate === "1/2/2")!;
    assert.equal(retired.active, 0);
    assert.deepEqual(JSON.parse(retired.folded), []);
});

test("{§turn-source-resources} {§emission-admission}: an echoed emission heading is tolerated and dropped, never a NOTE, never replayed", async (t) => {
    const { db, result, provider, rows } = await run("envelope-echo", "Answer.", [
        say(`### log:///1/2/2/emission (ops://exampleSessionName/1/2) · 30\n\n${surveyRead}\n\nawait plurnk.note({"text":"Noted."});`), say("await plurnk.done({\"text\":\"Answer.\"});"),
    ], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.equal((JSON.parse(rows.find(({ coordinate }) => coordinate === "1/2/2")!.rx) as { content: string }).content, `${surveyRead}\n\nawait plurnk.note({"text":"Noted."});`,
        "the echo is absent from the canonical program; the text beside the operations that was not an echo would be a NOTE");
    assert.equal(previous(provider.received[1]), `${surveyRead}\n\nawait plurnk.note({"text":"Noted."});`, "the replay carries the admitted operations, not the echo");
});
});

describe("parser_roundtrip", () => {
const parseOne = (input: string): PlurnkStatement => {
    const result = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    for (const item of result.items) {
        if (item.kind === "statement") return item.statement;
    }
    throw new Error(`no statement parsed from: ${input}`);
};

const parseAll = (input: string): PlurnkStatement[] => {
    const result = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    return result.items.filter((i) => i.kind === "statement").map((i) => i.statement);
};

const dispatch = async (engine: Engine, ctx: Awaited<ReturnType<typeof seedEnvelope>>, statements: PlurnkStatement[]): Promise<number[]> => {
    const statuses: number[] = [];
    for (const [i, statement] of statements.entries()) {
        const result = await engine.dispatch({
            statement, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: i + 1, origin: "model",
        });
        statuses.push(result.status);
    }
    return statuses;
};

test("{§execution-output-identity} parser roundtrip: EDIT writes the resource", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = parseOne("await plurnk.edit({\"path\":\"workspace:///countries/france/capital\",\"content\":\"Paris\"});") as EditStatement;
        const result = await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entry = await db.test_parser_entries_first.get<{ workspace_id: number; scheme: string; pathname: string }>();
        assert.ok((entry?.workspace_id ?? 0) >= 1, "owner stamped ({§execution-output-identity})");
        assert.equal(entry?.scheme, "workspace");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const body = await db.test_parser_body_first.get<{ content: string }>();
        assert.equal(body?.content, "Paris");

    } finally { await db.close(); }
});

// {§fence-pairing} {§op-shapes}
test("{§fence-pairing} parser roundtrip: an empty EDIT section performs a scoped deletion", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-empty-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const statements = [
            parseOne("await plurnk.edit({\"path\":\"workspace:///scoped-delete\",\"content\":\"alpha\\nbeta\\ngamma\"});"),
            parseOne("await plurnk.edit({\"path\":\"workspace:///scoped-delete\",\"range\":\"2\"});"),
        ];

        assert.deepEqual(await dispatch(engine, env, statements), [201, 200]);
        const body = await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/scoped-delete" });
        assert.equal(body?.content, "alpha\ngamma");
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} parser roundtrip: multi-statement text parses + dispatches in order", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-multi");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const text = "await plurnk.edit({\"path\":\"workspace:///a\",\"content\":\"first\"});\n\nawait plurnk.edit({\"path\":\"workspace:///b\",\"content\":\"second\"});\n\nawait plurnk.edit({\"path\":\"workspace:///c\",\"content\":\"third\"});";
        const statements = parseAll(text);
        assert.equal(statements.length, 3);
        const statuses = await dispatch(engine, env, statements);
        assert.deepEqual(statuses, [201, 201, 201]);
        const pathnames = await db.test_parser_pathnames.all<{ pathname: string }>();
        assert.deepEqual(pathnames.map((p) => p.pathname), ["/a", "/b", "/c"]);
        const logIndices = await db.test_parser_log_indices.all<{ sequence: number; pathname: string }>();
        assert.deepEqual(logIndices.map((r) => r.sequence), [1, 2, 3]);
        assert.deepEqual(logIndices.map((r) => r.pathname), ["/a", "/b", "/c"]);
    } finally { await db.close(); }
});

test("{§scheme-surface} parser roundtrip: EDIT followed by READ reads back what was written", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-readback");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        await engine.dispatch({
            statement: parseOne("await plurnk.edit({\"path\":\"workspace:///france\",\"content\":\"The capital is Paris.\"});"),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });

        const readResult = await engine.dispatch({
            statement: parseOne("await plurnk.read({\"path\":\"workspace:///france\"});"),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(readResult.status, 200);
        assert.equal((readResult as unknown as { content: string }).content, "The capital is Paris.");
    } finally { await db.close(); }
});

test("{§scheme-address} parser roundtrip: HTTP-shape path still decomposes authority correctly", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-http");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("await plurnk.read({\"path\":\"https://en.wikipedia.org/wiki/Paris\"});") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_parser_log_first.get<{ scheme: string; hostname: string | null; pathname: string }>();
        assert.equal(log?.scheme, "https");
        assert.equal(log?.hostname, "en.wikipedia.org");
        assert.equal(log?.pathname, "/wiki/Paris");
    } finally { await db.close(); }
});

test("{§operation-fences} parser roundtrip: real DSL preserves serialized query + fragment on opaque scheme", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-params");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("await plurnk.read({\"path\":\"workspace:///france?lang=fr#History\"});") as ReadStatement;
        await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_parser_log_first.get<{ scheme: string; hostname: string | null; pathname: string; query: string | null; fragment: string | null }>();
        assert.equal(log?.scheme, "workspace");
        assert.equal(log?.hostname, null);
        assert.equal(log?.pathname, "/france");
        assert.equal(log?.query, "lang=fr");
        assert.equal(log?.fragment, "History");
    } finally { await db.close(); }
});

// {§operation-fences}
const stripVolatile = (stmt: PlurnkStatement): object => {
    const { position: _position, ...rest } = stmt;
    return rest;
};

for (const [label, canonical, terse] of [
    ["edit", 'await plurnk.edit({"path":"workspace:///countries/france/capital","content":"Paris"});', 'plurnk.edit({"path":"workspace:///countries/france/capital","content":"Paris"})'],
    ["find", 'await plurnk.find({"path":"workspace:///users.json","pattern":"$.name"});', 'plurnk.find({"path":"workspace:///users.json","pattern":"$.name"})'],
    ["send", 'await plurnk.send({"target":"workspace:///result","text":"Paris"});', 'plurnk.send({"target":"workspace:///result","text":"Paris"})'],
    ["sh", 'await plurnk.sh({"command":"uname -r"});', 'plurnk.sh({"command":"uname -r"})'],
] as const) {
    test(`{§operation-fences} parser: optional await and semicolon do not change the AST (${label})`, () => {
        const short = parseOne(canonical);
        const long = parseOne(terse);
        assert.deepEqual(stripVolatile(short), stripVolatile(long));
    });
}

test("{§operation-fences} parser: a 3-backtick block stays literal in a Code Mode string body", () => {
    const body = "quoted section:\n\nawait plurnk.edit({\"path\":\"workspace:///inner\",\"content\":\"hello\"});";
    const stmts = parseAll(`await plurnk.edit(${JSON.stringify({ path: "workspace:///demo", content: body })});`);
    assert.equal(stmts.length, 1, "a nested call string never closes the body");
    assert.equal(stmts[0]?.op, "edit");
    assert.equal((stmts[0]).body, body);
});

test("{§fence-pairing} parser: a top-level EDIT after an EDIT runs; a quoted EDIT inside content stays body", () => {
    const body = "quoted section:\n\nawait plurnk.edit({\"path\":\"workspace:///inner\",\"content\":\"hello\"});";
    const bare = parseAll([
        'await plurnk.edit({"path":"workspace:///demo","content":"quoted section:"});',
        'await plurnk.edit({"path":"workspace:///inner","content":"hello"});',
    ].join("\n\n"));
    assert.deepEqual(bare.map(({ op }) => op), ["edit", "edit"], "two top-level statements produce two mutations");
    assert.equal((bare[0] as EditStatement).body, "quoted section:");
    assert.equal((bare[1] as EditStatement).body, "hello");
    const wider = parseAll(`await plurnk.edit(${JSON.stringify({ path: "workspace:///demo", content: body })});`);
    assert.equal(wider.length, 1, "the string literal holds the quoted statement as body");
    assert.equal((wider[0] as EditStatement).body, body);
});
});

describe("path-glob-mutations", () => {
const execFileP = promisify(execFile);

test("{§op-methods-op-dispatch} escaped and URL selectors read and edit the intended file, never its separator neighbor", async (t) => {
    serverProposals(t, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-glob-"));
    const intended = String.raw`dir\name/a.txt`;
    const names = [intended, "dir/name/a.txt", "dirname/a.txt", "a*.txt", "a/b.txt"];
    const bare = PathSyntax.escapeTarget(String.raw`dir\\name/*.txt`);
    const url = `${pathToFileURL(join(root, String.raw`dir\name`)).href}/*.txt`;
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        for (const name of names) {
            await mkdir(dirname(join(root, name)), { recursive: true });
            await writeFile(join(root, name), `Original ${name}\n`);
        }
        await execFileP("git", ["add", "--all"], { cwd: root, env: hermeticGitEnv() });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse([
                ...[bare, url].flatMap((path) => [`await plurnk.find(${JSON.stringify({ path })});`, `await plurnk.read(${JSON.stringify({ path })});`]),
                `await plurnk.read(${JSON.stringify({ path: PathSyntax.escapeTarget(String.raw`a\*.txt`) })});`,
            ].join("\n\n"), 50),
            makeMockResponse(`await plurnk.edit({"path":"${url}","range":"1,-1","content":"Revised\\n"});`, 50),
            makeMockResponse("await plurnk.done({\"text\":\"Finished.\"});", 50),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const client = await connect(addr);
            try {
                await rpcCall(client, 1, "workspace.create", { name: "literal-globs", projectRoot: root });
                const loop = await runLoopToTerminal(client, 2, { prompt: "Select the literal names." });
                assert.equal(loop.result.status, 200);
                const rows = (await db.engine_render_log.all<{ op: string; origin: string; pathname: string; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! }))
                    .filter(({ origin }) => origin === "model");
                assert.deepEqual(rows.filter(({ op }) => op === "read").map(({ pathname, status_rx }) => ({ pathname, status_rx })),
                    [intended, intended, "a*.txt"].map((pathname) => ({ pathname, status_rx: 200 })));
                const finds = rows.filter(({ op }) => op === "find");
                assert.equal(finds.length, 2);
                for (const find of finds) {
                    const result = JSON.parse(find.rx);
                    assert.equal(result.status, 200);
                    assert.equal(result.matchingPathCount, 1);
                    assert.equal(result.results[0][0].path, pathToFileURL(join(root, intended)).href);
                }
                for (const name of names) {
                    assert.equal(await readFile(join(root, name), "utf8"), name === intended ? "Revised\n" : `Original ${name}\n`, name);
                }
                assert.deepEqual(await readdir(join(root, String.raw`dir\name`)), ["a.txt"], "no wildcard-named file is created");
                assert.deepEqual(rows.filter(({ op }) => op === "edit").map(({ pathname, status_rx }) => ({ pathname, status_rx })), [{ pathname: intended, status_rx: 200 }]);
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

class Channels extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "channels", channels: { body: "text/plain", notes: "text/plain" }, defaultChannel: "body",
        category: "data", writableBy: ["model", "client"], volatile: false, modelVisible: true, textEditScopes: true,
    };
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: CoreSchemeCallContext, precondition?: LineAnchorPrecondition) {
        return EntryOps.editWorkspaceEntryBatch(statements, this.coreContext(ctx), Channels.manifest, precondition);
    }
}

const fixture = async (t: TestContext, entries: Record<string, string>, scheme = "workspace", producer: "client" | "model" = "client") => {
    const db = await openMigrated();
    t.after(() => db.close());
    const env = await seedEnvelope(db, `bulk-${crypto.randomUUID()}`, { producer });
    const schemes = new SchemeRegistry();
    schemes.register("channels", new Channels());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const ids = new Map<string, number>();
    for (const [pathname, content] of Object.entries(entries)) {
        ids.set(pathname, await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme, pathname, content }));
    }
    let sequence = 1;
    const dispatch = async (statement: PlurnkStatement) => {
        const result = await engine.dispatch({ ...env, statement, sequence, origin: "client" });
        sequence += (result.rowsWritten as number | undefined) ?? 1;
        return result;
    };
    const content = async (pathname: string, channel = "body") => (await db.test_get_channel.get<{ content: string }>({ entry_id: ids.get(pathname)!, name: channel }))?.content;
    const rows = () => db.test_log_entries_by_turn.all<{ op: string; pathname: string; status_rx: number; rx: string; attrs: string; sequence: number }>({ turn_id: env.turnId });
    return { db, env, engine, ids, dispatch, content, rows };
};

for (const op of ["edit", "kill"] as const) {
    test(`{§op-methods-op-dispatch} ${op} applies a scoped matcher to every selected resource`, async (t) => {
        const { dispatch, content, rows } = await fixture(t, { "/a.txt": "foo one\nfoo two", "/b.txt": "foo three\nfoo four", "/other.md": "foo five" });
        const target = urlPath("workspace", "/@(a|b).txt");
        const statement = op === "edit" ? editStmt(target, "bar", { marks: [1, 1] }, regex("foo")) : killStmt(target, { marks: [1, 1] }, regex("foo"));
        const result = await dispatch(statement);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.rowsWritten, 2);
        assert.equal(Object.hasOwn(result, "commandsExecuted"), false, "dispatch accounting is not an operation result");
        assert.equal(Object.hasOwn(result, "commandsOmitted"), false);
        assert.equal(await content("/a.txt"), `${op === "edit" ? "bar" : ""} one\nfoo two`);
        assert.equal(await content("/b.txt"), `${op === "edit" ? "bar" : ""} three\nfoo four`);
        assert.equal(await content("/other.md"), "foo five");
        assert.deepEqual((await rows()).map((row) => [row.op, row.pathname, row.status_rx]), [[op, "/a.txt", 200], [op, "/b.txt", 200]]);
        for (const { rx } of await rows()) {
            assert.equal(Object.hasOwn(JSON.parse(rx), "commandsExecuted"), false, "receipts retain only operation results");
            assert.equal(Object.hasOwn(JSON.parse(rx), "commandsOmitted"), false);
        }
    });

    test(`{§op-methods-op-dispatch} empty ${op} selection is a single no-effect receipt`, async (t) => {
        const { dispatch, rows, content } = await fixture(t, { "/a.txt": "unchanged" });
        const target = urlPath("workspace", "/missing*.txt");
        const result = await dispatch(op === "edit" ? editStmt(target, "new", fullReplace) : killStmt(target));
        assert.equal(result.status, 204, JSON.stringify(result));
        assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/missing*.txt", 204]]);
        assert.equal(await content("/a.txt"), "unchanged");
        assert.equal((await dispatch(readStmt(urlPath("workspace", "/missing*.txt")))).status, 204, "no literal wildcard resource was created");
    });
}

for (const op of ["read", "edit", "kill"] as const) {
    test(`{§op-methods-op-dispatch} ${op} preserves the selected nondefault channel`, async (t) => {
        const { db, dispatch, content, ids, rows } = await fixture(t, { "/a.txt": "body a", "/b.txt": "body b" }, "channels");
        for (const entryId of ids.values()) await db.test_seed_channel.run({ entry_id: entryId, name: "notes", content: "selected", mimetype: "text/plain", state: "static" });
        const target = urlPath("channels", "/*.txt", "notes");
        const result = await dispatch(op === "read" ? readStmt(target) : op === "edit" ? editStmt(target, "replacement", fullReplace) : killStmt(target, fullReplace));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.rowsWritten, 2);
        for (const path of ids.keys()) {
            assert.equal(await content(path), `body ${path[1]}`);
            assert.equal(await content(path, "notes"), op === "edit" ? "replacement" : op === "kill" ? "" : "selected");
        }
        if (op === "read") assert.deepEqual((await rows()).map(({ rx }) => JSON.parse(rx).content), ["selected", "selected"]);
    });
}

for (const op of ["copy", "move"] as const) {
    for (const operand of ["source", "destination"] as const) {
        for (const count of [0, 1, 2]) {
            test(`{§op-methods-op-dispatch} ${op} ${operand} glob with ${count} matches`, async (t) => {
                const entries = { "/source.txt": "source\ntail", "/destination.txt": "destination", ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`/match${i}.txt`, operand === "source" ? "source\ntail" : "destination"])) };
                const { dispatch, content, rows } = await fixture(t, entries);
                const source = urlPath("workspace", operand === "source" ? "/match*.txt" : "/source.txt");
                const destination = urlPath("workspace", operand === "destination" ? "/match*.txt" : "/destination.txt");
                const result = await dispatch((op === "copy" ? copyStmt : moveStmt)(source, destination, { marks: [1, 1] }, fullReplace));
                assert.equal(result.status, count === 1 ? 200 : 400, JSON.stringify(result));
                if (count !== 1) {
                    assert.ok(result.problem?.type.endsWith("/target-cardinality"), JSON.stringify(result));
                    assert.equal(result.problem?.detail, `${op} ${operand} matched ${count} resources; expected one.`);
                    for (const [path, original] of Object.entries(entries)) assert.equal(await content(path), original, `${path} must not change`);
                } else {
                    assert.equal(await content(operand === "destination" ? "/match0.txt" : "/destination.txt"), "source\n", "line selection preserves its separator");
                    assert.equal(await content(operand === "source" ? "/match0.txt" : "/source.txt"), op === "move" ? "tail" : "source\ntail");
                }
                assert.deepEqual((await rows()).map(({ op: actual }) => actual), [op], "internal surveys do not create extra receipts");
            });
        }
    }
}

const previewLines = (t: TestContext, lines: number) => {
    const old = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    process.env.PLURNK_SERVICE_PREVIEW_LINES = String(lines);
    t.after(() => { if (old === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES; else process.env.PLURNK_SERVICE_PREVIEW_LINES = old; });
};

for (const op of ["edit", "kill"] as const) {
    test(`{§op-methods-op-dispatch} ${op} is complete even when the FIND preview holds one item`, async (t) => {
        previewLines(t, 1);
        const entries = { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c", "/nested/d.txt": "d" };
        const { dispatch, content, rows } = await fixture(t, entries);
        const target = urlPath("workspace", "/**/*.txt");
        const result = await dispatch(op === "edit" ? editStmt(target, "changed", fullReplace) : killStmt(target));
        assert.ok(result.status < 300, JSON.stringify(result));
        assert.equal(result.rowsWritten, 4);
        for (const path of Object.keys(entries)) assert.equal(await content(path), op === "edit" ? "changed" : undefined, path);
        assert.deepEqual((await rows()).map(({ pathname }) => pathname), Object.keys(entries));
    });
}

for (const failOnOperationError of [false, true]) {
    test(`{§op-methods-op-dispatch} anchors remain resource-specific during fan-out; fail-on-error=${failOnOperationError}`, async (t) => {
        const { dispatch, content, rows, engine, env } = await fixture(t, { "/a.txt": "first\nsecond", "/b.txt": "different", "/c.txt": "first\nsecond" });
        const read = await dispatch(readStmt(urlPath("workspace", "/a.txt"), fullReplace));
        const anchor = (read.lineAnchors as string[])[0];
        const execution = engine.executeAdmittedTurn({
            ...env, origin: "client", source: null, emission: null, fromSequence: 2, failOnOperationError,
            statements: TurnOps.parseInternal(`await plurnk.edit({"path":"workspace:///*.txt","range":"${anchor}","content":"updated"});`),
        });
        if (failOnOperationError) await assert.rejects(execution, OperationFailureError);
        else await execution;
        assert.equal(await content("/a.txt"), "updated\nsecond");
        assert.equal(await content("/b.txt"), "different");
        assert.equal(await content("/c.txt"), "first\nsecond", "identical content in another resource does not share the READ anchor");
        const edits = (await rows()).filter(({ op }) => op === "edit");
        assert.deepEqual(edits.map(({ status_rx }) => status_rx), failOnOperationError ? [200, 409] : [200, 409, 409]);
        assert.match(JSON.parse(edits[1].rx).problem.type, /\/edit-collision$/);
    });
}

for (const op of ["read", "edit", "kill"] as const) for (const limit of [0, 1, 2, Infinity]) {
    test(`{§op-methods-op-dispatch} ${op} fan-out obeys concrete command limit ${limit}`, async (t) => {
        const entries = { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c" };
        const { engine, env, rows, content } = await fixture(t, entries);
        const target = urlPath("workspace", "/*.txt");
        const statement = op === "read" ? readStmt(target) : op === "edit" ? editStmt(target, "changed", fullReplace) : killStmt(target);
        await engine.executeAdmittedTurn({ ...env, origin: "client", source: null, emission: null, fromSequence: 1, maxCommands: limit,
            statements: [statement, noteStmt("after targets"), dispositionStmt("wait")] });
        const receipts = await rows();
        assert.deepEqual(receipts.filter(({ op: actual }) => actual === op).map(({ pathname }) => pathname), Object.keys(entries).slice(0, limit));
        for (const [index, [path, original]] of Object.entries(entries).entries()) {
            assert.equal(await content(path), index >= limit || op === "read" ? original : op === "edit" ? "changed" : undefined);
        }
        assert.equal(receipts.some((receipt) => receipt.op === "note"), limit === Infinity);
        assert.ok(receipts.some((receipt) => receipt.op === "wait"), "WAIT remains exempt");
        const problem = receipts.map(({ rx }) => JSON.parse(rx).problem).find((candidate) => candidate?.type.endsWith("/max-commands-exceeded"));
        if (limit === Infinity) assert.equal(problem, undefined);
        else assert.equal(problem?.omittedOperations, limit === 0 ? 2 : 4 - limit);
    });
}

for (const decision of ["reject", "drift"] as const) {
    test(`{§op-methods-op-dispatch} file fan-out settles each proposal independently after ${decision}`, { timeout: 30_000 }, async (t) => {
        serverProposals(t, "review");
        const root = await mkdtemp(join(tmpdir(), "plurnk-bulk-proposals-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const { db, env, engine, rows } = await fixture(t, { "a.txt": "a\n", "b.txt": "b\n" }, "file", "model");
        await db.test_set_workspace_project_root.run({ id: env.workspaceId, project_root: root });
        await ownSession(db, env.workspaceId, env.sessionId);
        for (const name of ["a", "b"]) {
            const path = `${name}.txt`;
            await writeFile(join(root, path), `${name}\n`);
            await MembershipMaterialization.materializeMember(path, root, makeSchemeCtx({ ...env, db, mimetypes: DEFAULT_MIMETYPES }), new Map());
        }
        const publications = [Promise.withResolvers<number>(), Promise.withResolvers<number>()];
        let index = 0;
        const execution = engine.dispatch({ ...env, origin: "model", sequence: 1,
            statement: editStmt(localPath("*.txt"), "updated\n", fullReplace),
            onDispatch: (id) => publications[index++].resolve(id),
        });
        for (const [position, published] of publications.entries()) {
            const id = await published.promise;
            const pending = await engine.pendingProposals(env.workspaceId);
            assert.deepEqual(pending.map(({ logEntryId }) => logEntryId), [id], `only the current concrete target is proposed: ${JSON.stringify(await rows())}`);
            if (position === 0 && decision === "drift") await writeFile(join(root, "a.txt"), "external\n");
            await engine.resolveProposal(id, { decision: position === 0 && decision === "reject" ? "reject" : "accept" });
        }
        const result = await execution;
        assert.equal(result.status, decision === "reject" ? 400 : 409);
        assert.equal(result.rowsWritten, 2);
        assert.equal(await readFile(join(root, "a.txt"), "utf8"), decision === "reject" ? "a\n" : "external\n");
        assert.equal(await readFile(join(root, "b.txt"), "utf8"), "updated\n");
        const receipts = await rows();
        assert.deepEqual(receipts.map(({ pathname, status_rx }) => [pathname, status_rx]), [["a.txt", decision === "reject" ? 400 : 409], ["b.txt", 200]]);
        assert.deepEqual(receipts.map(({ attrs }) => JSON.parse(attrs).fanout.index), [0, 1]);
    });
}

test("{§op-methods-op-dispatch} authority selectors mutate entries, never session actors", async (t) => {
    const { db, env, dispatch } = await fixture(t, {});
    const ids = [];
    for (const authority of ["alpha", "beta"]) ids.push(await seedEntryWithChannel(db, { workspaceId: env.workspaceId, authority, pathname: "/shared.txt", content: authority }));
    const result = await dispatch(editStmt(parsePath("session://*/shared.txt"), "updated", fullReplace));
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.rowsWritten, 2);
    for (const id of ids) assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: id, name: "body" }))?.content, "updated");
    const refused = await dispatch(killStmt(parsePath("session://*")));
    assert.equal(refused.status, 404, JSON.stringify(refused));
    assert.match(refused.problem!.type, /\/session-not-found$/);
    for (const id of ids) assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: id, name: "body" }))?.content, "updated");
});

test("{§op-methods-op-dispatch} mutation patterns retain a receipt for every selected resource", async (t) => {
    const { dispatch, rows, content } = await fixture(t, { "/a.txt": "absent", "/b.txt": "needle", "/c.txt": "absent" });
    const result = await dispatch(editStmt(urlPath("workspace", "/*.txt"), "found", null, regex("needle")));
    assert.ok(result.status < 300, JSON.stringify(result));
    assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/a.txt", 204], ["/b.txt", 200], ["/c.txt", 204]]);
    assert.equal(await content("/a.txt"), "absent");
    assert.equal(await content("/b.txt"), "found");
    assert.equal(await content("/c.txt"), "absent");
});

test("{§op-methods-op-dispatch} denied mutations neither enumerate nor change their targets", async (t) => {
    const { db, env, dispatch, rows, content } = await fixture(t, { "/a.txt": "original", "/b.txt": "original" });
    await db.test_set_workspace_settings.run({ id: env.workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "edit" }] } }) });
    const result = await dispatch(editStmt(urlPath("workspace", "/*.txt"), "updated", fullReplace));
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.match(result.problem!.type, /\/capability-denied$/);
    assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/*.txt", 403]]);
    assert.equal(await content("/a.txt"), "original");
    assert.equal(await content("/b.txt"), "original");
});

for (const op of ["copy", "move"] as const) {
    test(`{§op-methods-op-dispatch} ${op} resolves both channel operands and preserves exact creation`, async (t) => {
        const { db, dispatch, content, ids } = await fixture(t, { "/source.txt": "body", "/destination.txt": "body" }, "channels");
        for (const [path, id] of ids) await db.test_seed_channel.run({ entry_id: id, name: "notes", content: path === "/source.txt" ? "selected" : "destination", mimetype: "text/plain", state: "static" });
        const transfer = op === "copy" ? copyStmt : moveStmt;
        const result = await dispatch(transfer(urlPath("channels", "/source*.txt", "notes"), urlPath("channels", "/destination*.txt", "notes"), fullReplace, fullReplace));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(await content("/source.txt"), "body");
        assert.equal(await content("/destination.txt"), "body");
        assert.equal(await content("/source.txt", "notes"), op === "copy" ? "selected" : undefined, "whole-channel MOVE removes only the selected source channel");
        assert.equal(await content("/destination.txt", "notes"), "selected");
        const created = await dispatch(transfer(urlPath("channels", "/destination*.txt", "notes"), urlPath("workspace", "/new.txt")));
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.equal((await dispatch(readStmt(urlPath("workspace", "/new.txt")))).content, "selected");
    });
    test(`{§op-methods-op-dispatch} ${op} rejects ambiguity beyond the preview page`, async (t) => {
        previewLines(t, 1);
        const entries = { "/source.txt": "original", "/destination1.txt": "one", "/destination2.txt": "two" };
        const { dispatch, content } = await fixture(t, entries);
        const result = await dispatch((op === "copy" ? copyStmt : moveStmt)(urlPath("workspace", "/source*.txt"), urlPath("workspace", "/destination*.txt")));
        assert.equal(result.status, 400, JSON.stringify(result));
        assert.match(result.problem!.type, /\/target-cardinality$/);
        assert.equal(result.problem!.matchingPathCount, 2);
        for (const [path, original] of Object.entries(entries)) assert.equal(await content(path), original);
    });
}

test("{§op-methods-op-dispatch} scheme extensions cannot override the command accounting", async (t) => {
    const edit = Channels.prototype.editBatch;
    t.mock.method(Channels.prototype, "editBatch", async function (this: Channels, ...args: Parameters<Channels["editBatch"]>) {
        return { ...await edit.apply(this, args), commandsExecuted: 0, commandsOmitted: 42 };
    });
    const { engine, env, rows, content } = await fixture(t, { "/a.txt": "original" }, "channels");
    await engine.executeAdmittedTurn({ ...env, origin: "client", source: null, emission: null, fromSequence: 1, maxCommands: 1,
        statements: [editStmt(urlPath("channels", "/a.txt"), "updated", fullReplace), noteStmt("exceeds the ceiling")] });
    assert.equal(await content("/a.txt"), "updated");
    const receipts = await rows();
    assert.equal(receipts.some((receipt) => receipt.op === "note"), false);
    const problem = receipts.map(({ rx }) => JSON.parse(rx).problem).find((candidate) => candidate?.type.endsWith("/max-commands-exceeded"));
    assert.equal(problem?.omittedOperations, 1);
});
});

describe("same-turn-visibility", () => {
// {§op-methods-op-dispatch} {§op-methods-op-dispatch}






test("{§turn-record}: log KILL selects the pre-program snapshot, not rows emitted earlier by its own program", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        { assistant: { content: "await plurnk.find({\"path\":\"workspace:///*\"});\n\nawait plurnk.kill({\"path\":\"log:///1/2/*\"});\n\nawait plurnk.note({\"text\":\"Continue after curating the observed pre-program row.\"});", reasoning: null } },
        { assistant: { content: "await plurnk.done({\"text\":\"done\"});", reasoning: null } },
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-selection-snapshot" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "Exercise current-turn log selection." });
            assert.equal(result.finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{
                turn_id: number;
                op: string | null;
                origin: string;
                active: 0 | 1;
                attrs: string;
            }>({ loop_id: result.loopId });
            const firstModelTurnId = rows.find(({ origin, op }) => origin === "model" && op === "find")?.turn_id;
            assert.ok(firstModelTurnId !== undefined);
            const firstModelTurn = rows.filter(({ turn_id }) => turn_id === firstModelTurnId);
            const prompt = firstModelTurn.find(({ op, origin }) => op === "send" && origin === "_plurnk");
            assert.equal(prompt?.active, 0, "the pre-program arrival row was in the selected snapshot");
            for (const op of ["find", "kill", "note"] as const) {
                assert.equal(
                    firstModelTurn.find((row) => row.op === op)?.active,
                    1,
                    `${op} was emitted by the executing program and cannot select itself`,
                );
            }
            assert.ok(firstModelTurn.every(({ op }) => op !== null), "program retention is independent of the log selection snapshot");
            const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string }>({ session_id: result.modelSessionId! });
            assert.ok(programs.some(({ turn_id, kind }) => turn_id === firstModelTurnId && kind === "ops"));
        } finally { ws.close(); }
    });
});

test("{§op-methods-op-dispatch}: FIND observes an entry created by EDIT in the same turn", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Turn 1: write, then read-back in the same turn; continue (same-turn completion would
        // — correctly — trip the weigh-before-conclude 409; that gate is not under test here).
        makeMockResponse("await plurnk.edit({\"path\":\"workspace:///abs/module-loader-spec.md\",\"content\":\"the spec body\"});\n\nawait plurnk.find({\"path\":\"workspace:///abs/**\"});\n\nawait plurnk.note({\"text\":\"wrote and listed\"});", 10),
        makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "probe360" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: loopId });
            const modelFind = (rows ?? []).filter((r) => r.op === "find" && r.origin === "model");
            assert.ok(modelFind.length >= 1, "the model's FIND dispatched");
            const rx = JSON.parse(modelFind[0].rx ?? "{}") as { content?: string };
            assert.match(rx.content ?? "", /module-loader-spec/,
                "the just-EDITed entry is visible to the SAME-turn FIND — writes land before subsequent ops read");
        } finally { ws.close(); }
    });
});

test("{§op-methods-op-dispatch}: each EDIT records its own revision; an earlier READ retains its snapshot", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("await plurnk.edit({\"path\":\"workspace:///mode.md\",\"content\":\"one\\ntwo\\nthree\\nfour\"});\n\nawait plurnk.note({\"text\":\"fixture created\"});", 10),
        makeMockResponse("await plurnk.read({\"path\":\"workspace:///mode.md\"});\n\nawait plurnk.edit({\"path\":\"workspace:///mode.md\",\"range\":\"4\",\"content\":\"FOUR\"});\n\nawait plurnk.edit({\"path\":\"workspace:///mode.md\",\"range\":\"2\",\"content\":\"TWO\\n2.5\"});\n\nawait plurnk.note({\"text\":\"mutated and observed\"});", 10),
        makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-batch" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const reads = rows.filter((row) => row.op === "read" && row.origin === "model");
            assert.equal(reads.length, 1);
            const receipt = JSON.parse(reads[0].rx) as { content?: string };
            assert.equal(receipt.content, "one\ntwo\nthree\nfour");
            const edits = rows
                .filter((row) => row.op === "edit" && row.origin === "model")
                .map((row) => JSON.parse(row.rx) as {
                    receipt?: { revision?: string; effect?: { requested?: string; source?: string; result?: string } };
                })
                .filter((row) => row.receipt?.effect?.requested === "<2>" || row.receipt?.effect?.requested === "<4>");
            assert.equal(edits.length, 2);
            assert.match(edits[0].receipt?.revision ?? "", /^[a-f0-9]{64}$/);
            assert.notEqual(edits[0].receipt?.revision, edits[1].receipt?.revision, "each EDIT identifies its own committed revision");
            const unanchored = (context: unknown): string => String(context).replace(/^ *(\d+)<@[0-9A-Za-z]{5}>/gm, "$1:");
            assert.deepEqual(edits.map((row) => ({ ...row.receipt?.effect, context: unanchored((row.receipt?.effect as { context?: unknown } | undefined)?.context) })), [
                // {§edit-result-receipt-projection} — four lines of boundary context (the shipped default) reach the whole file here.
                { requested: "<4>", source: "<4>", result: "<4>", removed: 1, inserted: 1, context: "1:one\n2:two\n3:three\n4:FOUR" },
                { requested: "<2>", source: "<2>", result: "<2,3>", removed: 1, inserted: 2, context: "1:one\n2:TWO\n3:2.5\n4:three\n5:FOUR" },
            ]);
            for (const row of edits) assert.match(String((row.receipt?.effect as { context?: unknown } | undefined)?.context), /^ *[1-9]\d*<@[0-9A-Za-z]{5}>/, "{§edit-result-receipt-projection}");
        } finally { ws.close(); }
    });
});

test("{§op-methods-op-dispatch}: overlapping numeric EDITs apply to successive resource states", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("await plurnk.edit({\"path\":\"workspace:///atomic.md\",\"content\":\"one\\ntwo\\nthree\"});\n\nawait plurnk.note({\"text\":\"fixture\"});", 10),
        makeMockResponse("await plurnk.edit({\"path\":\"workspace:///atomic.md\",\"range\":\"1,2\",\"content\":\"changed\"});\n\nawait plurnk.edit({\"path\":\"workspace:///atomic.md\",\"range\":\"2,3\",\"content\":\"also changed\"});\n\nawait plurnk.read({\"path\":\"workspace:///atomic.md\"});\n\nawait plurnk.note({\"text\":\"checked\"});", 10),
        makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-atomic-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const failedEdits = rows.filter((row) => row.op === "edit" && row.origin === "model"
                && (JSON.parse(row.rx) as { status?: number }).status === 200);
            assert.equal(failedEdits.length, 2);
            const read = rows.find((row) => row.op === "read" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "changed\nalso changed");
        } finally { ws.close(); }
    });
});

test("{§edit}: a two-anchor whole-line range survives the composed EDIT path", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const content = "alpha\nbeta\ngamma\ndelta";
    const [alpha, beta] = LineAnchors.tokens("workspace:///anchored-range.md", content);
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("await plurnk.edit({\"path\":\"workspace:///anchored-range.md\",\"content\":\"alpha\\nbeta\\ngamma\\ndelta\"});\n\nawait plurnk.note({\"text\":\"created\"});", 10),
        makeMockResponse(`await plurnk.edit({"path":"workspace:///anchored-range.md","range":"${alpha},${beta}"});

await plurnk.read({"path":"workspace:///anchored-range.md"});

await plurnk.note({"text":"verify"});`, 10),
        makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "anchored-range" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const read = rows.findLast((row) => row.op === "read" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "gamma\ndelta");
        } finally { ws.close(); }
    });
});

test("{§op-methods-op-dispatch}: an invalid anchored EDIT leaves the earlier effect intact", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const content = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
    const [one, two, three, four, five, six, seven, eight] = LineAnchors.tokens(
        "workspace:///anchor-batch.md",
        content,
    );
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse(`await plurnk.edit(${JSON.stringify({ path: "workspace:///anchor-batch.md", content })});

await plurnk.note({"text":"created"});`, 10),
        makeMockResponse(`await plurnk.edit({"path":"workspace:///anchor-batch.md","range":"${one},${two}"});

await plurnk.edit({"path":"workspace:///anchor-batch.md","range":"${three},${four},${five},${six},${seven},${eight}","content":"replacement"});

await plurnk.read({"path":"workspace:///anchor-batch.md"});

await plurnk.note({"text":"verify"});`, 10),
        makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "anchored-batch-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{
                aside: string | null;
                op: string;
                origin: string;
                rx: string;
            }>({ loop_id: result.loopId });
            const edits = rows
                .filter((row) => row.op === "edit" && row.origin === "model")
                .map((row) => JSON.parse(row.rx) as {
                    problem?: { anchor?: string; type?: string };
                    status?: number;
                });
            assert.equal(edits.length, 3, "fixture creation plus the two authored batch members");
            assert.equal(edits[1]?.status, 200);
            assert.equal(edits[1]?.problem?.anchor, undefined);
            assert.equal(edits[1]?.problem, undefined);
            assert.equal(edits[2]?.status, 400);
            assert.equal(edits[2]?.problem?.anchor, three);
            assert.match(edits[2]?.problem?.type ?? "", /line-anchor-invalid$/);

            const read = rows.findLast((row) => row.op === "read" && row.origin === "model");
            assert.equal(
                (JSON.parse(read?.rx ?? "{}") as { content?: string }).content,
                "three\nfour\nfive\nsix\nseven\neight",
                "the invalid operation does not reverse an earlier successful EDIT",
            );
        } finally { ws.close(); }
    });
});
});

