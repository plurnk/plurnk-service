import test, { describe, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import Turn from "../../src/core/Turn.ts";
import LineAnchors, { type LineAnchorPrecondition } from "../../src/content/line-anchors.ts";
import ClientInteractions, { type ClientInteractionPendingEvent } from "../../src/core/ClientInteractions.ts";
import MessageResources from "../../src/core/MessageResources.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import SessionName from "../../src/core/SessionName.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import Fork from "../../src/core/fork.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import EntryOps from "../../src/schemes/_entry-ops.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import { serverProposals, ownSession, TEST_OWNER } from "./_approval.ts";
import { TurnDisposition, Validator, type EntryReadResult, type ParsedPath, type CapabilityPolicy, type ProposalPolicy, type EditStatement, type PlurnkStatement, type OperationResult, type ReadStatement, PathSyntax } from "@plurnk/plurnk-contracts";
import { Mock, chatMessageText, type MockResponse, type ChatMessage } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { openMigrated, seedEnvelope, insertWorkspace, insertSession, insertLoop, insertOperationTurn, seedEntryWithChannel, rootWorkspace, insertTurn } from "./_db.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse, fixtureExecutors } from "./_mock.ts";
import { MessageScheme, type SchemeHandler, type SchemeManifest, type RepresentationPreparationRequest, type SchemeCtx, Results, type EntryData, type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { contentWeight } from "../../src/core/content-weight.ts";
import { killStmt, urlPath, localPath, editStmt, readStmt, copyStmt, moveStmt, execStmt, sendStmt, noteStmt, dispositionStmt, fullReplace, regex } from "./_dsl.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import { type Effect, type Executor } from "@plurnk/plurnk-execs";
import { schemeManifest, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { type AnchoredReadResult } from "../../src/content/read-projector.ts";
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

describe("operation-order", () => {
const target = "workspace:///ordered.md";
const content = "one\ntwo\nthree\nfour\nfive\nsix";
const anchors = LineAnchors.tokens(target, content);
const cases = [
    {
        name: "READs observe the state at their authored position, not a future EDIT",
        ops: [`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``, `\`\`\`\`EDIT (${target}) <2>
TWO
extra
\`\`\`\``, `\`\`\`\`READ (${target}) <1,-1>\`\`\`\``, `\`\`\`\`EDIT (${target}) <4>
THREE
\`\`\`\``, `\`\`\`\`READ (${target}) <1,-1>\`\`\`\``],
        order: ["READ", "EDIT", "READ", "EDIT", "READ"],
        reads: [content, "one\nTWO\nextra\nthree\nfour\nfive\nsix", "one\nTWO\nextra\nTHREE\nfour\nfive\nsix"],
        statuses: [200, 200],
    },
    {
        name: "an EDIT can create a resource and a later EDIT can change it in the same turn",
        ops: ["````EDIT (workspace:///new.md)\nalpha\nbeta\n````", "````EDIT (workspace:///new.md) <2>\nBETA\n````", "````READ (workspace:///new.md) <1,-1>````"],
        order: ["EDIT", "EDIT", "READ"],
        reads: ["alpha\nBETA"],
        statuses: [201, 200],
    },
    {
        name: "an invalid EDIT does not roll back an earlier effect or suppress a later one",
        ops: [`\`\`\`\`EDIT (${target}) <1>
ONE
\`\`\`\``, `\`\`\`\`EDIT (${target}) <99>
invalid
\`\`\`\``, `\`\`\`\`EDIT (${target}) <2>
TWO
\`\`\`\``, `\`\`\`\`READ (${target}) <1,-1>\`\`\`\``],
        order: ["EDIT", "EDIT", "EDIT", "READ"],
        reads: ["ONE\nTWO\nthree\nfour\nfive\nsix"],
        statuses: [200, 416, 200],
    },
    {
        name: "a surviving hash follows its target through an adjacent numeric insertion",
        ops: [`\`\`\`\`EDIT (${target}) <0>
prefix
\`\`\`\``, `\`\`\`\`READ (${target}) <1,-1>\`\`\`\``, `\`\`\`\`EDIT (${target}) <${anchors[1]}>
TWO
\`\`\`\``, `\`\`\`\`READ (${target}) <1,-1>\`\`\`\``],
        order: ["EDIT", "READ", "EDIT", "READ"],
        reads: [`prefix\n${content}`, "prefix\none\nTWO\nthree\nfour\nfive\nsix"],
        statuses: [200, 200],
    },
    {
        name: "an overwritten hash target is not rebound to replacement content",
        ops: [`\`\`\`\`EDIT (${target}) <${anchors[1]}>
replacement
\`\`\`\``, `\`\`\`\`EDIT (${target}) <${anchors[1]}>
wrong
\`\`\`\``, `\`\`\`\`READ (${target}) <1,-1>\`\`\`\``],
        order: ["EDIT", "EDIT", "READ"],
        reads: ["one\nreplacement\nthree\nfour\nfive\nsix"],
        statuses: [200, 409],
    },
    {
        name: "an untouched hash range survives a preceding scoped entry KILL",
        ops: [`\`\`\`\`KILL (${target}) <1>\`\`\`\``, `\`\`\`\`EDIT (${target}) <${anchors[2]},${anchors[3]}>
THREE
FOUR
\`\`\`\``, `\`\`\`\`READ (${target}) <1,-1>\`\`\`\``],
        order: ["KILL", "EDIT", "READ"],
        reads: ["two\nTHREE\nFOUR\nfive\nsix"],
        statuses: [200],
    },
];

for (const fixture of cases) test(`{§op-methods-op-dispatch}: ${fixture.name}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse(`\`\`\`\`EDIT (${target})
${content}
\`\`\`\`
\`\`\`\`NOTE
created
\`\`\`\``, 10),
        makeMockResponse(`${fixture.ops.join("\n")}
\`\`\`\`NOTE
verify
\`\`\`\``, 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ordered" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "run" });
            assert.equal(result.finalStatus, 200);
            const rows = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string; tx: string }>({ loop_id: result.loopId }))
                .filter(({ origin, op }) => origin === "model" && op !== "SEND" && op !== "NOTE"
                    && !TurnDisposition.isOp(op)).slice(1);
            assert.deepEqual(rows.map(({ op }) => op), fixture.order);
            assert.deepEqual(rows.filter(({ op }) => op === "READ").map(({ rx }) => JSON.parse(rx).content), fixture.reads);
            assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ rx }) => JSON.parse(rx).status), fixture.statuses);
        } finally { ws.close(); }
    });
});

for (const origin of ["client", "_plurnk"] as const) for (const hasNote of [false, true]) {
    for (const failOnOperationError of [false, true]) test(`{§op-methods-op-dispatch}: ${origin} preserves effects and source with failOnOperationError=${failOnOperationError}, NOTE=${hasNote}`, async () => {
        const db = await openMigrated();
        try {
            const env = await seedEnvelope(db, `ordered-${origin}`, { producer: origin });
            env.turnId = (await Turn.open(db, { loopId: env.loopId, producer: origin, kind: "operation" })).id;
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const source = `\`\`\`\`EDIT (${target})
${content}
\`\`\`\`
\`\`\`\`READ (${target}) <1,-1>\`\`\`\`
\`\`\`\`EDIT (${target}) <99>
invalid
\`\`\`\`
\`\`\`\`EDIT (${target}) <2>
TWO
\`\`\`\`${hasNote ? "\n````NOTE\nContinue the task.\n````" : ""}`;
            const execution = engine.executeAdmittedTurn({
                ...env, origin, source, emission: null, statements: TurnOps.parseInternal(source),
                fromSequence: 1, failOnOperationError,
            });
            if (failOnOperationError) await assert.rejects(execution, OperationFailureError);
            else assert.equal((await execution).status, 200, "the administrative program finished without ending a model loop");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: env.turnId });
            assert.deepEqual(rows.filter(({ op }) => op !== null).map(({ op }) => op),
                failOnOperationError ? ["EDIT", "READ", "EDIT"] : ["EDIT", "READ", "EDIT", "EDIT", ...(hasNote ? ["NOTE"] : [])]);
            assert.equal(JSON.parse(rows.find(({ op }) => op === "READ")!.rx).content, content);
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: env.sessionId });
            assert.equal(sources.find(({ turn_id, kind }) => turn_id === env.turnId && kind === "ops")?.content, source,
                "the submitted program remains durable even when execution stops at an error");
            const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/ordered.md", name: "body" });
            assert.equal(body?.content, failOnOperationError ? content : content.replace("two", "TWO"));
        } finally { await db.close(); }
    });
}
});

describe("ClientInteractions", () => {
const request = {
    toolName: "choose_repository",
    mode: "form",
    message: "Choose the repository to inspect.",
    requestedSchema: {
        type: "object",
        properties: { repository: { type: "string" } },
        required: ["repository"],
        additionalProperties: false,
    },
} as const;

test("{§op-methods-op-dispatch} {§problems-client}: competing interaction answers admit exactly one envelope before wake", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, "interaction-message-race");
    await ownSession(db, ids.workspaceId, ids.sessionId, ["choose_repository"]);
    const respondent = { workspaceId: ids.workspaceId, address: TEST_OWNER };
    const interactions = new ClientInteractions(db);
    const observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    interactions.onPending(observed.resolve);
    const awaiting = interactions.request(request, ids).then(async (resolution) => {
        const messages = await MessageResources.read(db, ids);
        assert.equal(messages.length, 1, "the accepted answer is durable when the waiter wakes");
        assert.deepEqual(messages[0].envelope, { messageId: "first", metadata: { exact: true } });
        return resolution;
    });
    const { interactionId } = await observed.promise;
    const resolution = { action: "accept", content: { repository: "plurnk-service" } } as const;
    const outcomes = await Promise.allSettled(["first", "second"].map((messageId) => interactions.resolve(interactionId, resolution, respondent, {
        body: messageId, source: "acp://peer/messages/answer", envelope: { messageId, metadata: { exact: true } },
    })));
    assert.equal(outcomes[0].status, "fulfilled");
    const rejected = outcomes[1];
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") assert.fail("the second answer cannot win");
    assert.ok(rejected.reason instanceof OperationFailureError);
    assert.equal(rejected.reason.result.status, 409);
    assert.match(rejected.reason.result.problem.type, /interaction-not-pending$/u);
    assert.deepEqual(await awaiting, resolution);
});

test("{§methods-client-interaction-resolve} {§client-interactions}: a pending request is durable, projected, resolved once, then removed", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `interaction-${crypto.randomUUID()}`);
    await ownSession(db, ids.workspaceId, ids.sessionId, ["choose_repository"]);
    const respondent = { workspaceId: ids.workspaceId, address: TEST_OWNER };
    const interactions = new ClientInteractions(db);
    const observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    interactions.onPending(observed.resolve);

    const awaiting = interactions.request(request, ids);
    const pending = await observed.promise;

    assert.deepEqual(pending, {
        interactionId: pending.interactionId,
        ...ids,
        recipient: TEST_OWNER,
        request,
    });
    assert.deepEqual(await interactions.list(ids.workspaceId), [{
        interactionId: pending.interactionId,
        sessionId: ids.sessionId,
        loopId: ids.loopId,
        turnId: ids.turnId,
        recipient: TEST_OWNER,
        request,
    }]);

    await interactions.resolve(pending.interactionId, {
        action: "accept",
        content: { repository: "plurnk-service" },
    }, respondent);
    assert.deepEqual(await awaiting, {
        action: "accept",
        content: { repository: "plurnk-service" },
    });
    assert.deepEqual(await interactions.list(ids.workspaceId), []);
    await assert.rejects(
        interactions.resolve(pending.interactionId, { action: "cancel" }, respondent),
        /Client interaction .* is not pending/,
    );
});

test("{§client-interactions}: owner cancellation removes the durable request and rejects its waiter", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `interaction-abort-${crypto.randomUUID()}`);
    await ownSession(db, ids.workspaceId, ids.sessionId, ["choose_repository"]);
    const interactions = new ClientInteractions(db);
    const observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    interactions.onPending(observed.resolve);
    const controller = new AbortController();

    const awaiting = interactions.request(request, ids, controller.signal);
    await observed.promise;
    const reason = new Error("owning operation stopped");
    controller.abort(reason);

    await assert.rejects(awaiting, (error: unknown) => error === reason);
    assert.deepEqual(await interactions.list(ids.workspaceId), []);
});

test("{§client-interactions}: invalid response content leaves the same interaction answerable", async () => {
    const db = await openMigrated();
    const ids = await seedEnvelope(db, "interaction-invalid-response");
    await ownSession(db, ids.workspaceId, ids.sessionId, ["choose_repository"]);
    const respondent = { workspaceId: ids.workspaceId, address: TEST_OWNER };
    const interactions = new ClientInteractions(db);
    const observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    interactions.onPending(observed.resolve);
    const awaiting = interactions.request(request, ids);
    const pending = await observed.promise;
    try {
        await assert.rejects(interactions.resolve(pending.interactionId, {
            action: "accept", content: { repository: 42 },
        }, respondent), (cause: unknown) => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.status, 400);
            assert.match(cause.result.problem.type, /\/interaction-response-invalid$/u);
            return true;
        });
        assert.equal((await interactions.list(ids.workspaceId))[0]?.interactionId, pending.interactionId);
        await interactions.resolve(pending.interactionId, {
            action: "accept", content: { repository: "plurnk-service" },
        }, respondent);
        assert.deepEqual(await awaiting, { action: "accept", content: { repository: "plurnk-service" } });
    } finally {
        if ((await interactions.list(ids.workspaceId)).length) {
            await interactions.resolve(pending.interactionId, { action: "cancel" }, respondent);
        }
        await awaiting;
        await db.close();
    }
});

test("{§methods-client-interaction-resolve} {§client-interactions}: a retired interrupt identity never addresses a subsequent input request", async () => {
    const db = await openMigrated();
    const ids = await seedEnvelope(db, "interaction-identities");
    await ownSession(db, ids.workspaceId, ids.sessionId, ["choose_repository"]);
    const respondent = { workspaceId: ids.workspaceId, address: TEST_OWNER };
    const interactions = new ClientInteractions(db);
    let observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    interactions.onPending((event) => observed.resolve(event));
    const first = interactions.request(request, ids);
    const firstId = (await observed.promise).interactionId;
    await interactions.resolve(firstId, { action: "cancel" }, respondent);
    await first;
    observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    const second = interactions.request(request, ids);
    const secondId = (await observed.promise).interactionId;
    try {
        assert.notEqual(secondId, firstId);
        await assert.rejects(interactions.resolve(firstId, { action: "cancel" }, respondent), /is not pending/u);
        assert.equal((await interactions.list(ids.workspaceId))[0]?.interactionId, secondId);
    } finally {
        await interactions.resolve(secondId, { action: "cancel" }, respondent);
        await second;
        await db.close();
    }
});

test("{§client-interactions}: insertion requires one exact workspace/session/loop/turn ownership chain", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const first = await seedEnvelope(db, `interaction-owner-a-${crypto.randomUUID()}`);
    const second = await seedEnvelope(db, `interaction-owner-b-${crypto.randomUUID()}`);
    await ownSession(db, first.workspaceId, first.sessionId, ["choose_repository"]);
    const interactions = new ClientInteractions(db);

    await assert.rejects(
        interactions.request(request, { ...first, workspaceId: second.workspaceId }),
        /coordinates do not identify one operation/,
    );
    assert.deepEqual(await db.client_interaction_list.all({ workspace_id: first.workspaceId }), []);
    assert.deepEqual(await db.client_interaction_list.all({ workspace_id: second.workspaceId }), []);
});

test("{§client-interactions}: boot recovery removes a request whose process-local owner vanished", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `interaction-recovery-${crypto.randomUUID()}`);
    await ownSession(db, ids.workspaceId, ids.sessionId, ["choose_repository"]);
    const inserted = await db.client_interaction_insert.get({
        workspace_id: ids.workspaceId,
        session_id: ids.sessionId,
        loop_id: ids.loopId,
        turn_id: ids.turnId,
        recipient: TEST_OWNER,
        request: JSON.stringify(request),
    });
    assert.ok(inserted !== undefined);

    await db.recovery_settle_process_owners({});

    assert.deepEqual(await db.client_interaction_list.all({ workspace_id: ids.workspaceId }), []);
});
});

describe("Daemon.entry-read-acquisition", () => {
// {§scheme-address} A client read acquires each kind of address as exact READ does, from the session's perspective:
// a representation core computes, a core scheme's prepared entry, a message core retains whichever module minted its
// address, and any other scheme's entry as stored, its acquisition never run.











const reasoned = (dsl: string, reasoning: string) => {
    const response = makeMockResponse(dsl);
    return { ...response, assistant: { ...response.assistant, reasoning } };
};

// An extension's data scheme whose acquisition would reach outside the daemon: it counts every preparation.
class Remote implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "remote", authority: "resource", channels: { body: "text/plain" }, defaultChannel: "body",
        category: "data", writableBy: ["model"], volatile: true, modelVisible: true,
    };
    prepared = 0;

    async resolveEntryAddress(target: ParsedPath): Promise<{ authority: string; pathname: string } | null> {
        return target.kind === "url" ? { authority: target.hostname ?? "", pathname: target.pathname } : null;
    }

    async prepareRepresentation(): Promise<{ status: 200 }> {
        this.prepared += 1;
        return { status: 200 };
    }
}

const typeOf = (result: EntryReadResult): string | null => result.entry === null ? result.problem.type.replace(/^.*\//u, "") : null;

// Under the shipped database posture, and with a reader Session beside the writer, the other posture an operator may choose
// (`PLURNK_SERVICE_SQLITE_READERS`): every read here follows a write it must see.
for (const readers of [undefined, 1]) test(`{§scheme-address} a client read acquires every kind of address as exact READ does, and runs only core's acquisition (${readers === undefined ? "shipped readers" : `${readers} reader`})`, async () => {
    const thought = "Weighing the note.";
    const minted = "proto://anonymous/threads/t/messages/m1";
    const provider = new Mock({ contextWindow: 32768, responses: [
        reasoned("````NOTE\nOne.\nTwo.\nThree.\n````", thought),
        makeMockResponse("````SEND [200]\nThe answer.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "entry-acquisition" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const remote = new Remote();
        await daemon.registerScheme("proto", new MessageScheme("proto"));
        await daemon.registerScheme("remote", remote);
        const terminated = new Set<number>();
        const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
            if (method === "loop/terminated") terminated.add((params as { loopId: number }).loopId);
        });
        try {
            const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Think, then answer.", source: minted, messageAddress: minted });
            await waitForDb(async () => terminated.has(loopId), (done) => done);
        } finally {
            off();
        }
        const rows = await daemon.readLog({ workspaceId, sessionId });
        const note = rows.find(({ op }) => op === "NOTE");
        // {§message-short-identity} The arrival's receipt names the message by its short address.
        const short = rows.flatMap(({ origin, rx }) => origin === "_plurnk" && typeof (rx as { resource?: unknown } | null)?.resource === "string"
            ? [(rx as { resource: string }).resource] : []).find((resource) => resource.startsWith("message://"));
        assert.ok(note !== undefined && short !== undefined, "the turn noted, and its arrival names its message");
        const coordinate = `${note.loop_seq}/${note.turn_seq}/${note.sequence}`;
        // {§log-kill-scope} A deliberate scoped KILL trims the row's second line from every later reader.
        const trimmed = await modelOperation(daemon, db, { workspaceId, sessionId, statement: killStmt(parsePath(`log:///${coordinate}/NOTE`), { marks: [2] }) });
        assert.equal(trimmed.status, 200);
        const read = async (target: string, slice: { channel?: string; offset?: number } = {}): Promise<EntryReadResult> =>
            Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, sessionId, target, ...slice }));

        // A log row is computed: no stored entry, the canonical coordinate, its unnamed default channel, trimmed.
        const kept = "One.\nThree.";
        assert.deepEqual(await read(`log:///${coordinate}/NOTE`), { status: 200, entry: {
            entryId: null, target: `log:///${coordinate}/NOTE`,
            channels: { "": { content: kept, contentOffset: 0, contentLength: kept.length, mimetype: "text/plain", weight: contentWeight(kept), state: "static" } },
        } });
        assert.deepEqual((await read(`log:///${coordinate}/NOTE`, { channel: "", offset: 5 })).entry?.channels[""],
            { content: "Three.", contentOffset: 5, contentLength: kept.length, mimetype: "text/plain", weight: contentWeight(kept), state: "static" },
            "a computed channel slices by code points, as a stored one does");
        const unknownChannel = await read(`log:///${coordinate}/NOTE`, { channel: "patch" });
        assert.deepEqual([unknownChannel.status, typeOf(unknownChannel)], [404, "channel-not-found"]);

        // A turn's sources are computed by the session they name; its reasoning is the text its first operation row projects.
        assert.equal(note.reasoning, thought);
        const reasoning = await read(`reasoning://main/${note.loop_seq}/${note.turn_seq}`);
        assert.equal(reasoning.entry?.entryId, null);
        assert.deepEqual(reasoning.entry?.channels.body && [reasoning.entry.channels.body.content, reasoning.entry.channels.body.mimetype], [thought, "text/plain"]);
        const answer = rows.find(({ origin, turn_seq }) => origin === "model" && turn_seq !== note.turn_seq);
        assert.equal((await read(`reasoning://main/${note.loop_seq}/${answer?.turn_seq}`)).entry?.channels.body?.content, "", "a turn that reasoned none reads empty");
        const program = await read(`ops://main/${note.loop_seq}/${note.turn_seq}`);
        assert.deepEqual([program.entry?.entryId, program.entry?.channels.body?.mimetype], [null, "text/vnd.plurnk"], "the turn's program");

        // The core message scheme prepares its entry; a message an extension minted is materialized by core.
        for (const [target, label] of [[short, "the short address"], [minted, "the minted address"]] as const) {
            const message = await read(target);
            assert.ok((message.entry?.entryId ?? 0) > 0, `${label} reads a stored entry`);
            assert.equal(message.entry?.channels.body?.content, "Think, then answer.", `${label} holds the words`);
        }

        // An extension's acquisition never runs for a client: what it never stored is not there.
        const unfetched = await read("remote://example.test/page");
        assert.deepEqual([unfetched.status, typeOf(unfetched), remote.prepared], [404, "entry-not-found", 0]);

        // {§methods-entry-channel-read} The channel an address selects, complete: its fragment's, else its scheme's default.
        const selected = async (target: string): Promise<EntryReadResult> =>
            Validator.assertEntryReadResult(await daemon.readEntryChannel({ workspaceId, sessionId, target }));
        for (const [target, channel, content] of [
            [`log:///${coordinate}/NOTE`, "", kept],
            [`reasoning://main/${note.loop_seq}/${note.turn_seq}`, "body", thought],
            [`${minted}#body`, "body", "Think, then answer."],
        ] as const) {
            const one = await selected(target);
            assert.deepEqual([Object.keys(one.entry?.channels ?? {}), one.entry?.channels[channel]?.content], [[channel], content], target);
        }
        const absent = await selected(`log:///${coordinate}/NOTE#patch`);
        assert.deepEqual([absent.status, typeOf(absent)], [404, "channel-not-found"]);

        // Another workspace reads none of this session's addresses.
        const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "entry-acquisition-elsewhere" });
        await assert.rejects(daemon.readEntry({ workspaceId: elsewhere, sessionId, target: `reasoning://main/${note.loop_seq}/${note.turn_seq}` }),
            (error: unknown) => (error as { result?: { status?: number } }).result?.status === 409);

        // The scheme's own refusals stand.
        for (const [target, status, code] of [
            ["log:///x", 400, "coordinate-malformed"],
            [`log:///9/9/9/NOTE`, 404, "entry-not-found"],
            [`reasoning://main/${note.loop_seq}/99`, 404, "entry-not-found"],
        ] as const) {
            const refused = await read(target);
            assert.deepEqual([refused.status, typeOf(refused), refused.entry], [status, code, null], target);
        }
    }, readers === undefined ? {} : { readers });
});
});

describe("Engine.capability-policy", () => {
// {§capability-admission} — every operation route is admitted through the same
// service/workspace capability cascade before either
// execution or proposal settlement. This is the composed dispatch boundary;
// selector algebra itself belongs to @plurnk/plurnk-contracts.



beforeEach((t) => serverProposals(t as TestContext, "review"));















const makeMimetypes = (): Mimetypes => new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map(), packageAttributions: new Map(), skipped: [] },
});

class WritableScheme {
    static manifest: SchemeManifest = {
        name: "write-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "_plurnk"],
        volatile: false,
        modelVisible: true,
    };

    async editBatch(): Promise<{ status: number }> {
        return { status: 201 };
    }
}

class TraitSource {
    readonly manifest: SchemeManifest;
    preparations = 0;

    constructor(name: string, traits: readonly string[]) {
        this.manifest = { ...schemeManifest(name), traits };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<{ status: number }> {
        this.preparations += 1;
        await ctx.entries.write(request.pathname, {
            channels: { body: { content: "source", mimetype: "text/plain" } },
        });
        return { status: 200 };
    }
}

const fixtureExecutor: Executor = {
    runtime: "fixture-tool",
    glyph: "🧪",
    get manifest(): SchemeManifest {
        return {
            ...schemeManifest("fixture-tool", { results: "text/plain" }, "results"),
            volatile: true,
        };
    },
    get defaultChannel(): string { return "results"; },
    get channels() { return { results: { mimetype: "text/plain" } }; },
    async run({ setState }) {
        setState("results", "closed");
        return { status: 200 };
    },
    async probe() { return { available: true }; },
    effect(target: string | null): Effect { return target === null ? "pure" : "read"; },
};

const registryEntry = (executor: Executor, literal = false) => ({
    executor,
    namespaceOwner: { kind: "module" as const, name: `${executor.runtime} fixture` },
    glyph: executor.glyph,
    summary: "Capability fixture.",
    invocation: literal
        ? { body: { role: "input", required: false }, target: { role: "tool identifier", required: true, kind: "literal" as const }, example: { target: "fixture_tool", body: "{}" } }
        : { body: { role: "input", required: true }, target: { role: "resource", required: false, kind: "resource" as const }, example: { body: "fixture" } },
    details: "",
    available: true,
    detail: undefined,
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1);
    const turnId = await insertOperationTurn(db, loopId, 1, "client");
    const schemes = new SchemeRegistry();
    schemes.register("write-test", new WritableScheme());
    const engine = new Engine({ db, schemes, mimetypes: makeMimetypes() });
    engine.setExecutors(new ExecutorRegistry(new Map([
        ["fixture-tool", registryEntry(fixtureExecutor)],
        ["literal-tool", registryEntry(fixtureExecutor, true)],
    ])));
    return { db, workspaceId, sessionId, loopId, turnId, engine, schemes, exec: schemes.get("exec") as Exec };
};

const policies = (capabilities: CapabilityPolicy = {}, proposals: ProposalPolicy = "review"): { capabilities: CapabilityPolicy; proposals: ProposalPolicy } => ({
    capabilities,
    proposals,
});

const setPolicies = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    workspaceId: number,
    policy: ReturnType<typeof policies>,
): Promise<void> => {
    await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: policy.capabilities }) });
    process.env.PLURNK_SERVICE_PROPOSALS = policy.proposals;
};

test("{§op-methods-op-dispatch}: attachment acquisition obeys ordinary READ policy before source preparation", async (t) => {
    const { db, workspaceId, sessionId, loopId, turnId, engine, schemes } = await setup();
    t.after(() => db.close());
    const source = new TraitSource("attachment-source", ["web"]);
    schemes.register("attachment-source", source);
    await engine.injectIntoLoop(loopId, "Return the resource.", [], undefined, {}, "message://request/attachment");
    await setPolicies(db, workspaceId, policies({ deny: [{ access: "observe", traits: ["web"] }] }));
    const result = await engine.dispatch({
        workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        statement: { ...sendStmt(parsePath("message://request/attachment"), "Here is the resource."), metadata: ['{"attachments":["attachment-source:///report"]}'] },
    });
    assert.equal(result.status, 403);
    assert.match(result.problem!.type, /capability-denied$/u);
    assert.equal(result.problem!.operation, "READ");
    assert.equal(source.preparations, 0, "denied sources are not fetched or prepared");
});

test("{§capability-admission} invalid persisted workspace policy fails at its durable owner before dispatch", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: { deny: "invalid" } }) });
        await assert.rejects(
            engine.dispatch({
                statement: editStmt(urlPath("write-test", "x"), "body"),
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `Workspace ${workspaceId} has invalid persisted capability policy.`);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    } finally { await db.close(); }
});

test("{§capability-admission} one access selector gates every matching mutation shape while observations remain admitted", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await setPolicies(db, workspaceId, policies({ deny: [{ access: "mutate" }] }));
        let sequence = 0;
        const dispatch = (statement: Parameters<typeof engine.dispatch>[0]["statement"]) =>
            engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "client" });
        for (const statement of [
            editStmt(localPath("brief.md"), "hello"),
            copyStmt(urlPath("workspace", "note"), localPath("copied.md")),
            moveStmt(localPath("brief.md"), urlPath("workspace", "moved")),
        ]) {
            const result = await dispatch(statement);
            assert.equal(result.status, 403);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
            assert.equal(result.problem?.access, "mutate");
            assert.equal(result.problem?.policyScope, "workspace");
            assert.equal(result.problem?.retryable, false);
            assert.equal(result.problem?.recovery, undefined, "a factual denial does not guess at model intent");
        }
        assert.notEqual((await dispatch(readStmt(localPath("brief.md")))).status, 403);
    } finally { await db.close(); }
});

test("{§capability-admission} a MOVE source requires observation as well as mutation authority", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await setPolicies(db, workspaceId, policies({ deny: [{ access: "observe", scheme: "file" }] }));
        const result = await engine.dispatch({
            statement: moveStmt(localPath("secret.txt"), urlPath("workspace", "/moved.txt")),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "client",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.operation, "MOVE");
        assert.equal(result.problem?.scheme, "file");
        assert.equal(result.problem?.access, "observe");
    } finally { await db.close(); }
});

test("{§capability-admission} proposal disposition cannot deny or resurrect a capability", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await setPolicies(db, workspaceId, policies({}, "reject"));
        const admitted = await engine.dispatch({
            statement: editStmt(urlPath("workspace", "/x"), "body"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(admitted.status, 201, "proposal settlement is downstream of admission");

        await setPolicies(db, workspaceId, policies({ deny: [{ operation: "EDIT" }] }, "accept"));
        const denied = await engine.dispatch({
            statement: editStmt(urlPath("workspace", "/y"), "body"),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "client",
        });
        assert.equal(denied.status, 403, "automatic acceptance cannot restore denied authority");
    } finally { await db.close(); }
});

test("{§capability-admission} an operation with no external capability demand remains available under an empty only-set", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const { id: turnId } = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        await setPolicies(db, workspaceId, policies({ only: [] }));
        const result = await engine.dispatch({
            statement: noteStmt("Retained finding."),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 200, JSON.stringify(result));
    } finally { await db.close(); }
});

test("{§capability-admission} unknown routes reach ordinary resolution even under matching capability denials", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine } = await setup();
    try {
        await setPolicies(db, workspaceId, policies({ deny: [
            { operation: "READ" },
            { scheme: "exec" },
        ] }));
        const result = await engine.dispatch({
            statement: readStmt(urlPath("unknown-source", "/item")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 501);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");
        assert.equal(result.problem?.scheme, "unknown-source");

        const runtime = await engine.dispatch({
            statement: execStmt("unknown-runtime", "input", null),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "client",
        });
        assert.equal(runtime.status, 400);
        assert.equal(runtime.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");

        const copy = await engine.dispatch({
            statement: copyStmt(urlPath("unknown-source", "/item"), urlPath("workspace", "/copy")),
            workspaceId, sessionId, loopId, turnId, sequence: 3, origin: "client",
        });
        assert.equal(copy.status, 501);
        assert.equal(copy.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");
        assert.equal(copy.problem?.scheme, "unknown-source");

        const source = await engine.dispatch({
            statement: execStmt("fixture-tool", "input", urlPath("unknown-source", "/item")),
            workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "client",
        });
        assert.equal(source.status, 501);
        assert.equal(source.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");
        assert.equal(source.problem?.scheme, "unknown-source");
    } finally { await db.close(); }
});

test("{§capability-admission} execution admission precedes every target acquisition shape", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new TraitSource("web-source", ["web"]);
    schemes.register("web-source", web);
    try {
        await setPolicies(db, workspaceId, policies({ deny: [{ scheme: "exec" }] }));
        const targets = [null, localPath("input.txt"), urlPath("file", "/input.txt"), urlPath("workspace", "/source"), urlPath("web-source", "/source")];
        for (const [index, target] of targets.entries()) {
            const result = await engine.dispatch({
                statement: execStmt("fixture-tool", "transform", target),
                workspaceId, sessionId, loopId, turnId, sequence: index + 1, origin: "client",
            });
            assert.equal(result.status, 403);
            assert.equal(result.problem?.operation, "fixture-tool");
        }
        assert.equal(web.preparations, 0);
    } finally { await exec.idle(); await db.close(); }
});

test("{§capability-admission} a resource-shaped execution target adds its own observe demand", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new TraitSource("web-source", ["web"]);
    schemes.register("web-source", web);
    try {
        await setPolicies(db, workspaceId, policies({ deny: [{ traits: ["web"] }] }));
        const result = await engine.dispatch({
            statement: execStmt("fixture-tool", "transform", urlPath("web-source", "/source")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.scheme, "web-source");
        assert.equal(result.problem?.access, "observe");
        assert.equal(web.preparations, 0);
    } finally { await exec.idle(); await db.close(); }
});

test("{§capability-admission} a literal execution target is a tool identifier, never a resource route", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine, schemes, exec } = await setup();
    const web = new TraitSource("web-source", ["web"]);
    schemes.register("web-source", web);
    try {
        await setPolicies(db, workspaceId, policies({ deny: [{ traits: ["web"] }] }, "accept"));
        const result = await engine.dispatch({
            statement: execStmt("literal-tool", "{}", urlPath("web-source", "/tool")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(result.status, 200);
        assert.equal(web.preparations, 0);
    } finally { await exec.idle(); await db.close(); }
});

test("{§manifest-capability-traits} runtime scheme traits participate in the same selector space", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, engine, exec } = await setup();
    const interactive: Executor = {
        ...fixtureExecutor,
        runtime: "ask-human",
        get manifest(): SchemeManifest {
            return {
                ...schemeManifest("ask-human", { results: "text/plain" }, "results"),
                traits: ["interaction"],
                volatile: true,
            };
        },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "text/plain" } }; },
    };
    engine.registerRuntime("ask-human", registryEntry(interactive));
    try {
        await setPolicies(db, workspaceId, policies({ deny: [{ traits: ["interaction"] }] }));
        const denied = await engine.dispatch({
            statement: execStmt("ask-human", "{}", null),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.problem?.runtime, "ask-human");
        assert.deepEqual(denied.problem?.traits, ["interaction"]);
    } finally { await exec.idle(); await db.close(); }
});
});

describe("Engine.contextual-anchors", () => {
const statements = (program: string) => PlurnkParser.parse(program).items.map((item) => {
    assert.equal(item.kind, "statement", program);
    if (item.kind !== "statement") throw new Error("Expected an operation");
    return item.statement;
});

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const env = await seedEnvelope(db, `context-anchors-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    let sequence = 0;
    const run = (program: string) => {
        const ops = statements(program);
        assert.equal(ops.length, 1);
        return engine.dispatch({ ...env, statement: ops[0], sequence: ++sequence, origin: "model" });
    };
    const batch = (program: string) => {
        const ops = statements(program);
        const fromSequence = sequence + 1;
        sequence += ops.length;
        return engine.executeAdmittedTurn({ ...env, statements: ops, source: null, emission: null, fromSequence, origin: "model" });
    };
    const read = async (path: string, scope = "1,-1") =>
        Results.assertReadResult(await run(`\`\`\`READ (${path}) <${scope}>\n\`\`\``)) as AnchoredReadResult;
    const write = (path: string, body: string, scope = "") => run(`\`\`\`EDIT (${path}) ${scope}\n${body}\n\`\`\``);
    return { run, batch, read, write };
};

const repeated = (body: string) => {
    const block = (label: string) => [label, "before-2", "before-1", body, "after-1", "after-2", `end-${label}`];
    return [
        ...Array.from({ length: 10 }, (_, i) => `head-${i}`),
        ...block("a"), ...block("b"),
        ...Array.from({ length: 10 }, (_, i) => `tail-${i}`),
    ];
};

for (const op of ["EDIT", "KILL", "COPY", "MOVE"] as const) {
    test(`{§line-anchors}: ${op} uses contextual READ handles after a separate operation shifts the resource`, async (t) => {
        const { run, read, write } = await runtime(t);
        const source = "workspace:///source.md";
        const destination = "workspace:///destination.md";
        const sourceLines = repeated("source-target");
        const destinationLines = repeated("destination-target");
        const selected = sourceLines.indexOf("source-target");
        const other = sourceLines.lastIndexOf("source-target");
        assert.equal((await write(source, sourceLines.join("\n"))).status, 201);
        assert.equal((await write(destination, destinationLines.join("\n"))).status, 201);
        const full = await read(source);
        assert.notEqual(full.lineAnchors![selected], full.lineAnchors![other]);
        const slice = await read(source, String(selected + 1));
        assert.equal(slice.content, "source-target");
        const anchor = slice.lineAnchors![0];
        assert.equal(anchor, full.lineAnchors![selected], "scope does not discard the distinguishing context");
        const destinationAnchor = (await read(destination, String(other + 1))).lineAnchors![0];

        assert.equal((await write(source, "prefix\nhead-0", "<1>")).status, 200);
        assert.equal((await write(destination, "prefix\nhead-0", "<1>")).status, 200);
        assert.equal((await read(source, anchor)).content, "source-target");
        const program = op === "EDIT"
            ? `\`\`\`EDIT (${source}) <${anchor}>\nchanged\n\`\`\``
            : op === "KILL"
                ? `\`\`\`KILL (${source}) <${anchor}>\n\`\`\``
                : `\`\`\`${op} (${source}) <${anchor}> (${destination}) <${destinationAnchor}>\n\`\`\``;
        const result = await run(program);
        assert.equal(result.status, 200, JSON.stringify(result));

        const expectedSource = ["prefix", ...sourceLines];
        const expectedDestination = ["prefix", ...destinationLines];
        if (op === "EDIT") expectedSource[selected + 1] = "changed";
        if (op === "KILL" || op === "MOVE") expectedSource.splice(selected + 1, 1);
        if (op === "COPY" || op === "MOVE") expectedDestination[other + 1] = "source-target";
        assert.equal((await read(source)).content, expectedSource.join("\n"), "only the selected copy is changed or removed");
        assert.equal((await read(destination)).content, expectedDestination.join("\n"), "the destination independently resolves its contextual anchor");
    });
}

test("{§line-anchors}: changed extended context refuses EDIT without changing either twin", async (t) => {
    const { read, write, run } = await runtime(t);
    const path = "workspace:///stale.md";
    const lines = repeated("target");
    const target = lines.indexOf("target");
    assert.equal((await write(path, lines.join("\n"))).status, 201);
    const anchor = (await read(path, String(target + 1))).lineAnchors![0];
    assert.equal((await write(path, "changed section", `<${target - 2}>`)).status, 200);
    const changed = lines.with(target - 3, "changed section").join("\n");
    const refused = await run(`\`\`\`EDIT (${path}) <${anchor}>\nwrong\n\`\`\``);
    assert.equal(refused.status, 409);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
    assert.equal(refused.problem?.retryable, false);
    assert.equal((await read(path)).content, changed);
    const current = (await read(path, String(target + 1))).lineAnchors![0];
    assert.notEqual(current, anchor);
    assert.equal((await run(`\`\`\`EDIT (${path}) <${current}>\ncorrect\n\`\`\``)).status, 200);
    assert.equal((await read(path)).content, lines.with(target - 3, "changed section").with(target, "correct").join("\n"));
});

test("{§op-methods-op-dispatch}: introducing a twin in one program retains the original binding through real EDIT dispatch", async (t) => {
    const { read, write, batch } = await runtime(t);
    const path = "workspace:///continuity.md";
    assert.equal((await write(path, "one\ntwo\nthree\nfour\nfive\nsix")).status, 201);
    const anchor = (await read(path, "3")).lineAnchors![0];
    const result = await batch(`\`\`\`EDIT (${path}) <6>
six
one
two
three
four
five
\`\`\`

\`\`\`EDIT (${path}) <${anchor}>
THREE
\`\`\``);
    assert.deepEqual(result.outcomes.map(({ status }) => status), [200, 200]);
    assert.equal((await read(path)).content, "one\ntwo\nTHREE\nfour\nfive\nsix\none\ntwo\nthree\nfour\nfive");
});
});

describe("Engine.edit-batch-merges", () => {
// {§op-methods-op-dispatch} {§op-methods-op-dispatch}: independent EDIT effects and verified prefix normalization.











const execFileP = promisify(execFile);
const SOURCE = "var x int\n\nfunc requireFn(a int) int {\n\treturn a\n}\n\nfunc other() {}\n";

const seeded = async (root: string): Promise<void> => {
    const env = hermeticGitEnv();
    await execFileP("git", ["init", "-q"], { cwd: root, env });
    await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
    await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
    await writeFile(join(root, "f.go"), SOURCE);
    await execFileP("git", ["add", "f.go"], { cwd: root, env });
    await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
};

type Row = { op: string; origin: string; status_rx: number; rx: string };
const editRows = (rows: Row[]): Array<{ status: number; rx: Record<string, unknown> }> =>
    rows.filter(({ op }) => op === "EDIT").map(({ status_rx, rx }) => ({ status: status_rx, rx: JSON.parse(rx) }));

test("{§op-methods-op-dispatch} separate numeric EDITs never negotiate a shared endpoint", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <2,3>\nfunc resolve() string {\n\treturn \"\"\n}\n\n````\n\n````EDIT (f.go) <3,5>\nfunc requireFn(a int) int {\n\treturn a + 1\n}\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "merge", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.equal(edits[0].rx.merged, undefined, "the requested region is not silently shrunk");
                assert.equal(edits[1].rx.merged, undefined, "the claiming row is an ordinary applied edit");
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\nfunc resolve() string {\nfunc requireFn(a int) int {\n\treturn a + 1\n}\n}\n\nfunc other() {}\n", "numeric coordinates name the current content, without reinterpretation");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a READ rendering pasted back as a body is stripped only when its anchors verify; a look-alike is written as authored", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const pending: { body: string | null; fake: string | null } = { body: null, fake: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (f.go) <1,-1>````\n````NOTE\nreading\n````", 50),
            makeMockResponse("````SEND [200]\nread\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`\`\`\`\`EDIT (f.go) <1,2>
${pending.body}
\`\`\`\`

\`\`\`\`EDIT (f.go) <7>
${pending.fake}
\`\`\`\`

\`\`\`\`NOTE
editing
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````SEND [200]\nedited\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "paste", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<Row>({ session_id: first.modelSessionId! })).find(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                const anchors = JSON.parse(readRow!.rx).lineAnchors as string[];
                assert.equal(anchors.length, 7);
                // Lines 1-2 pasted back exactly as rendered (right-aligned ordinal, the anchor as the delimiter, text);
                // line 7's "prefix" carries a hash that is not this resource's anchor.
                pending.body = `1<${anchors[0]}>var x int\n2<${anchors[1]}>`;
                pending.fake = "7<@zzzzz>func other() { /* kept */ }";
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit" });
                assert.equal(second.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: second.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [304, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.deepEqual(edits[0].rx.merged, [{ rule: "rendered-prefix-stripped", lines: 2, source: "current" }]);
                assert.deepEqual(edits[1].rx.merged, [{ rule: "rendered-prefix-unverified", lines: 1 }]);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\n\nfunc requireFn(a int) int {\n\treturn a\n}\n\n7<@zzzzz>func other() { /* kept */ }\n", "verified prefixes stripped; the look-alike written verbatim");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a paste from an older READ still verifies, against the anchors that READ published", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const pending: { body: string | null } = { body: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (f.go) <1,-1>````\n````NOTE\nreading\n````", 50),
            makeMockResponse("````SEND [200]\nread\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`\`\`\`\`EDIT (f.go) <1,2>
${pending.body}
\`\`\`\`

\`\`\`\`NOTE
editing
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````SEND [200]\nedited\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "stale-paste", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<Row>({ session_id: first.modelSessionId! })).find(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                const anchors = JSON.parse(readRow!.rx).lineAnchors as string[];
                // Line 4 changes out-of-band after the READ: line 2's neighbourhood now differs, so the
                // pasted prefixes no longer verify against the current anchors - only against the READ's.
                await writeFile(join(root, "f.go"), SOURCE.replace("\treturn a\n", "\treturn a // changed\n"));
                pending.body = `1<${anchors[0]}>var x int64\n2<${anchors[1]}>`;
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit" });
                assert.equal(second.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: second.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.deepEqual(edits[0].rx.merged, [{ rule: "rendered-prefix-stripped", lines: 2, source: "log" }]);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int64\n\nfunc requireFn(a int) int {\n\treturn a // changed\n}\n\nfunc other() {}\n", "stripped by the READ's own anchors; lines 1-2 replaced as rendered");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} an identical subsequent EDIT reports its own ordinary no-change result", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <1>\nvar x int64\n````\n\n````EDIT (f.go) <1>\nvar x int64\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "twin", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 304]);
                assert.ok(edits[0].rx.receipt !== undefined, "the first row carries the effect");
                assert.equal(edits[1].rx.merged, undefined);
                assert.equal(edits[1].rx.receipt, undefined, "the twin applied nothing and claims no effect");
                assert.match(await readFile(join(root, "f.go"), "utf8"), /^var x int64\n\nfunc requireFn/);
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a numeric EDIT can modify content introduced by an earlier EDIT", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        // The outer rewrites requireFn but keeps its return line verbatim; the inner edits that line.
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <3,5>\nfunc requireFn(a int, debug bool) int {\n\treturn a\n}\n````\n\n````EDIT (f.go) <4>\n\treturn a * 2\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "relocate", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.equal(edits[1].rx.merged, undefined);
                assert.ok(edits[1].rx.receipt !== undefined, "the later EDIT owns its own effect");
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\n\nfunc requireFn(a int, debug bool) int {\n\treturn a * 2\n}\n\nfunc other() {}\n", "the inner change landed inside the rewritten function");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a shortened region does not secretly relocate a later numeric EDIT", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <3,5>\nfunc requireFn(a int) int { return a }\n````\n\n````EDIT (f.go) <4>\n\treturn a * 2\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "contain", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200]);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\n\nfunc requireFn(a int) int { return a }\n\treturn a * 2\nfunc other() {}\n", "the second EDIT names current line 4, not a former line inside the rewritten region");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
});

describe("Engine.manifest", () => {
// SPEC {§packet} — the FIND-served catalog is the complete, unranked directory
// for one addressed owner. A real turn updates its search projection; this test
// reads the same catalog surface and asserts every selected entry is listed.











const indexingTurn = {
    assistant: {
        content: "\n````SEND\ndone\n````",
        reasoning: null,
    },
};

test("{§packet} the commons catalog is complete and unranked — every selected entry, no `shown`, never itself", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        // Two commons-owned entries the directory must enumerate.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/france/capital", channel: "body", content: "Paris", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/germany/capital", channel: "body", content: "Berlin\nis the capital", mimetype: "text/markdown" });

        // A real turn maintains the search index; the catalog is the
        // read-only render FIND serves — there is no manifest.json entry.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const paths = catalog.map(([channel]) => channel.path);

        // Completeness: every seeded entry is listed.
        assert.ok(paths.includes("workspace:///france/capital"), `catalog lists france; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("workspace:///germany/capital"), `catalog lists germany; got ${JSON.stringify(paths)}`);
        // It does not list itself.
        assert.ok(!paths.includes("workspace:///manifest.json"), "catalog has no synthetic manifest entry");
        // Unranked directory: NO `shown` (or any visibility/relevance) field anywhere.
        for (const [channel] of catalog) assert.equal("shown" in channel, false, `no \`shown\` field — the directory is unranked (offender: ${channel.path})`);

        // Shape: a non-empty, default-first array of channel metadata; exceptional
        // parser evidence is independently covered below.
        const germany = catalog.find(([channel]) => channel.path === "workspace:///germany/capital");
        assert.ok(germany !== undefined, "germany entry present");
        assert.equal(germany.length, 1);
        const [gbody] = germany;
        assert.equal(gbody.path, "workspace:///germany/capital", "the default channel carries the bare resource URI");
        assert.equal(gbody.mimetype, "text/markdown");
        assert.equal(gbody.weight, Math.ceil("Berlin\nis the capital".length / 2), "weight is the stored curation depth, never re-counted from a body");
        assert.equal(gbody.lines, 2, "lines is the stored extent: a trailing newline would terminate the last line");
    } finally { await db.close(); }
});

test("{§packet} catalog projection selects by literal authority, or the whole workspace when omitted", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-owner-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/shared.md",
            content: "commons",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            authority: await SessionName.forId(db, sessionId),
            scheme: "session",
            pathname: "/private.md",
            content: "session",
        });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx)).map(([channel]) => channel.path),
            ["workspace:///shared.md", "session://alice/private.md"],
            "an omitted authority includes every workspace namespace",
        );
        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx, undefined, "alice")).map(([channel]) => channel.path),
            ["session://alice/private.md"],
            "an explicit authority selects that literal namespace",
        );
        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx, "workspace", "")).map(([channel]) => channel.path),
            ["workspace:///shared.md"],
            "an empty authority is the commons, not an omitted filter",
        );
        assert.deepEqual(await EntryManifest.catalogRowsFor(ctx, "https", "alice"), [],
            "scheme and authority filters intersect");
    } finally { await db.close(); }
});

test("{§packet} manifest build survives a malformed application/json entry — degrades to a line count, never crashes the turn (-32603)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-badjson-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        // A valid JSON entry plus one whose body is malformed — the kind of imperfect
        // JSON a small model writes. buildManifestBody calls mimetypes.process() per
        // entry for its line count, and process() validates application/json and THROWS
        // SyntaxError on a parse error. Uncaught, that crashed the whole manifest build
        // (and the turn → daemon -32603). One bad entry must not take down everything.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/good.json", channel: "body", content: '{"ok":true}', mimetype: "application/json" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/bad.json", channel: "body", content: '{\n  "a": 1\n  "b": 2\n}', mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        // The turn's pump survived the malformed entry (no -32603); the catalog renders it degraded.
        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const paths = catalog.map(([channel]) => channel.path);
        assert.ok(paths.includes("workspace:///good.json"), `valid entry listed; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("workspace:///bad.json"), "malformed entry still listed (degraded, not crashed)");
        const bad = catalog.find(([channel]) => channel.path === "workspace:///bad.json");
        assert.ok(bad !== undefined && bad[0].lines >= 1, "malformed entry degraded to a line count");
    } finally { await db.close(); }
});

test("{§scheme-catalog-parse-issues} catalog quietly marks parser recovery without disabling the derivation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-parse-issues-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");
        const brokenId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/broken.ts",
            channel: "body",
            content: "const x = ;",
            mimetype: "text/typescript",
        });
        await db.test_seed_channel.run({
            entry_id: brokenId,
            name: "notes",
            content: "auxiliary channel",
            mimetype: "text/plain",
            state: "static",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/clean.ts",
            channel: "body",
            content: "const x = 1;",
            mimetype: "text/typescript",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const broken = catalog.find(([channel]) => channel.path === "workspace:///broken.ts");
        const clean = catalog.find(([channel]) => channel.path === "workspace:///clean.ts");
        assert.equal(broken?.[0].parseIssues, 1);
        const notes = broken?.find((channel) => channel.path === "workspace:///broken.ts#notes");
        assert.equal(notes !== undefined && "parseIssues" in notes, false, "one channel's parser issues never label a sibling channel");
        assert.equal(clean !== undefined && "parseIssues" in clean[0], false, "clean source carries no success badge");

        const derivation = await db.test_derivation_disposition.get<{ disposition: string }>({ entry_id: brokenId });
        assert.notEqual(derivation?.disposition, "failed", "advisory parser recovery leaves indexing available");
    } finally { await db.close(); }
});

test("{§find} catalog projects a bounded aside on only its exact markdown channel", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-summary-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");
        const long = "x".repeat(300);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/tool.md",
            channel: "body",
            content: `# Tool\n\n## Summary\n\n${long}\n\n## Example\n\nDetails.`,
            mimetype: "text/markdown",
        });
        await db.test_seed_channel.run({
            entry_id: entryId,
            name: "notes",
            content: "No summary here.",
            mimetype: "text/markdown",
            state: "static",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const tool = catalog.find(([channel]) => channel.path === "workspace:///tool.md");
        assert.equal(Array.from(tool![0].aside!).length, 256);
        assert.equal(tool![0].aside, `${"x".repeat(255)}…`);
        assert.equal("aside" in tool![1], false, "one channel's aside never labels a sibling channel");
    } finally { await db.close(); }
});

test("{§channel-selection} catalog names a projected channel and its differently typed source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-source-mimetype-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "file",
            pathname: "/picture.png",
            content: "PNG image, 640×640 px, 37022 bytes",
            mimetype: "text/markdown",
        });
        await db.test_set_entry_attributes.run({
            entry_id: entryId,
            attributes: JSON.stringify({ sourceProjection: { mimetype: "image/png" } }),
        });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const picture = catalog.find(([channel]) => channel.path.endsWith("picture.png"));
        assert.ok(picture !== undefined, `picture is cataloged; got ${JSON.stringify(catalog)}`);
        assert.equal(picture[0].mimetype, "text/markdown");
        assert.equal(picture[0].sourceMimetype, "image/png");
    } finally { await db.close(); }
});

test("{§persistent-search-index} a large JSON entry is indexed and cataloged before inference", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-json-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        const big = JSON.stringify(Object.fromEntries(
            Array.from({ length: 80 }, (_, i) => [`key_${i}`, `value number ${i} with several descriptive words here`]),
        ), null, 2);
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/big.json", channel: "body", content: big, mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.ok(catalog.some(([channel]) => channel.path === "workspace:///big.json"), "the large JSON entry is listed in the catalog");
    } finally { await db.close(); }
});

test("{§session-loop-lifecycle} catalog distinguishes active, closed, killed, failed, and static entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-stream-state-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");

        await seedEntryWithChannel(db, { workspaceId, authority: await SessionName.forId(db, sessionId), scheme: "session", pathname: "/static/note", channel: "body", content: "x", mimetype: "text/markdown" });
        const seedStream = async (pathname: string, result?: ReturnType<typeof Results.failure> | { status: number }): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "sh",
                pathname,
                channel: "stdout",
                content: result === undefined ? "running..." : "",
                mimetype: "text/stream",
            });
            const subscriptionId = await ChannelWrite.openSubscription(db, {
                sessionId,
                entryId,
                scheme: "sh",
                handle: `sh: ${pathname}`,
            });
            if (result !== undefined) await ChannelWrite.closeSubscription(db, { subscriptionId, result });
        };
        await seedStream("/1/1/1/sh");
        await seedStream("/1/1/2/sh", { status: 200 });
        await seedStream("/1/1/3/sh", Results.failure("executor:sh", "killed", 499, "killed"));
        await seedStream("/1/1/4/sh", Results.failure("executor:sh", "failed", 503, "failed"));

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({
            db,
            workspaceId,
            defaultChannelFor: (scheme) => scheme === "sh" ? "stdout" : "body",
        }));
        const active = catalog.find(([channel]) => channel.path === "sh:///1/1/1/sh");
        const closed = catalog.find(([channel]) => channel.path === "sh:///1/1/2/sh");
        const killed = catalog.find(([channel]) => channel.path === "sh:///1/1/3/sh");
        const failed = catalog.find(([channel]) => channel.path === "sh:///1/1/4/sh");
        const stat = catalog.find(([channel]) => channel.path === "session://alice/static/note");
        assert.ok(active !== undefined && closed !== undefined && killed !== undefined && failed !== undefined && stat !== undefined);
        assert.equal(active[0].stream?.state, "active");
        assert.equal(typeof (active[0].stream?.state === "active" ? active[0].stream.seconds : undefined), "number");
        assert.deepEqual(closed[0].stream, { state: "closed", status: 200 });
        assert.deepEqual(killed[0].stream, { state: "killed", status: 499 });
        assert.deepEqual(failed[0].stream, { state: "failed", status: 503 });
        assert.equal(stat[0].stream, undefined, "an entry with no subscription is not presented as a stream");
    } finally { await db.close(); }
});

test("{§packet} [note4] manifest groups addressable channels default-first — default bare, non-default #fragment", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `note4-${crypto.randomUUID()}`);
        await insertSession(db, workspaceId);
        // A multi-channel exec stream entry at sh:///1/1/2/sh (stdout is the default channel, + stderr).
        const id = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/2/sh", channel: "stdout", content: "out", mimetype: "text/stream" });
        await db.test_seed_channel.run({ entry_id: id, name: "stderr", content: "err", mimetype: "text/stream", state: "static" });
        await db.test_seed_channel.run({ entry_id: id, name: "preview(\\", content: "detail", mimetype: "text/stream", state: "static" });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "https",
            authority: "example.test",
            pathname: "/x?literal=)&encoded=%29",
            channel: "body",
            content: "network",
            mimetype: "text/plain",
        });
        // sh's default channel is stdout (the Exec handler) — resolve it so stdout is [0], stderr a #fragment.
        const ctx = makeSchemeCtx({ db, workspaceId, defaultChannelFor: (s) => (s === "sh" ? "stdout" : "body") });
        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const stream = catalog.find(([channel]) => channel.path === "sh:///1/1/2/sh");
        assert.ok(stream, "exec stream listed");
        assert.deepEqual(
            stream.map((channel) => channel.path),
            ["sh:///1/1/2/sh", "sh:///1/1/2/sh#preview\\(\\\\", "sh:///1/1/2/sh#stderr"],
            "the default is first and bare; non-default channels use target-slot spelling",
        );
        assert.ok(
            catalog.some(([channel]) => channel.path === "https://example.test/x?literal=\\)&encoded=%29"),
            "network catalog paths preserve literal and percent-encoded query identity",
        );
    } finally { await db.close(); }
});
});

describe("Engine.multi-edit", () => {
// {§op-methods-op-dispatch} {§op-methods-op-dispatch} {§op-methods-op-dispatch} {§line-anchors} {§op-methods-op-dispatch} — the
// multi-EDIT matrix through the model path on project files. Every coherent program lands exactly where its
// anchors were published, whatever its order and whatever its own earlier splices did to ordinals and
// neighbourhoods; the only refusals are attempts no runtime could resolve deterministically (a line this
// program already replaced or deleted, a never-issued or foreign anchor), each refused without touching
// its siblings. Across programs the receipts' anchors are current and the packet's old ones are stale.



beforeEach((t) => serverProposals(t as TestContext, "accept"));












const execFileP = promisify(execFile);

const DEBUG = "django/views/debug.py";
const HELPERS = "django/views/helpers.py";
const DEBUG_LINES = [
    "import functools", "import re", "import sys", "import types", "from pathlib import Path", "",
    "from django.conf import settings",
    "from django.http import HttpResponse, HttpResponseNotFound",
    "from django.template import Context, Engine, TemplateDoesNotExist",
    "from django.template.defaultfilters import pprint",
    "from django.urls import Resolver404, resolve",
    "from django.utils import timezone",
    "from django.utils.datastructures import MultiValueDict",
    "from django.utils.encoding import force_str",
    "from django.utils.module_loading import import_string",
    "from django.utils.version import get_docs_version",
    "", "",
    "def technical_404_response(request, exception):",
    "    caller = ''",
    "    try:",
    "        resolver_match = resolve(request.path)",
    "    except Resolver404:",
    "        pass",
    "    else:",
    "        obj = resolver_match.func",
    "",
    "        if hasattr(obj, '__name__'):",
    "            caller = obj.__name__",
];
const HELPERS_LINES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const HTTP_IMPORT = "from django.http import Http404, HttpResponse, HttpResponseNotFound";
const URLS_IMPORT = "from django.urls import resolve";
const EXCEPT_404 = "    except Http404:";

type Unresolved = { anchor: string; kind: "missing" | "ambiguous"; lines?: number[] };
type EditRow = { status: number; landed: string | null; unresolved: Unresolved[] | null; context: string[] | null };
type Ctx = { root: string; db: Awaited<ReturnType<typeof openMigrated>>; engine: Engine; workspaceId: number; sessionId: number };
type Anchors = (line: number) => string;

const withProject = async <T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-multi-edit-"));
    const db = await openMigrated();
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        for (const [file, lines] of [[DEBUG, DEBUG_LINES], [HELPERS, HELPERS_LINES]] as const) {
            await mkdir(dirname(join(root, file)), { recursive: true });
            await writeFile(join(root, file), `${lines.join("\n")}\n`);
        }
        await execFileP("git", ["add", "."], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `multi-edit-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        return await fn({ root, db, engine, workspaceId, sessionId });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

const edit = (file: string, scope: string, body: string | null): string => PlurnkParser.frame(`EDIT (${file}) <${scope}>`, body ?? "");

// The anchors the model's latest READ of each file published, indexed by one-based line: the packet is the
// only place a model learns an anchor, so the program takes them from there and nowhere else.
const anchorsFromLog = async ({ db, sessionId }: Ctx): Promise<[Anchors, Anchors]> => {
    const rows = await db.engine_render_log.all<{ op: string | null; origin: string; status_rx: number; pathname: string | null; rx: string }>({ session_id: sessionId });
    const latest = (file: string): Anchors => {
        const row = rows.findLast(({ op, origin, status_rx, pathname }) => op === "READ" && origin === "model" && status_rx === 200 && (pathname === file || pathname === `/${file}`));
        assert.ok(row, `the model READ ${file}`);
        const anchors = (JSON.parse(row.rx) as { lineAnchors?: string[] }).lineAnchors;
        assert.ok(Array.isArray(anchors) && anchors.length > 0, `the READ of ${file} published one anchor per line`);
        return (line: number) => {
            const anchor = anchors[line - 1];
            if (anchor === undefined) throw new Error(`no anchor for line ${line} of ${file}`);
            return anchor;
        };
    };
    return [latest(DEBUG), latest(HELPERS)];
};

// One loop of the same session under an accepting proposal policy: the model READs both files, then
// emits `frames` built from the anchors that READ published, then concludes.
const program = async (ctx: Ctx, sequence: number, frames: (a: Anchors, b: Anchors) => string[]): Promise<{ edits: EditRow[]; published: [Anchors, Anchors] }> => {
    const { db, engine, workspaceId, sessionId } = ctx;
    const loopId = await insertLoop(db, sessionId, sequence, "Apply the fix.");
    const reads = [DEBUG, HELPERS].map((file) => PlurnkParser.frame(`READ (${file}) <1,-1>`, null)).join("\n\n");
    const respond = async (content: string, args: Parameters<Mock["generate"]>[0]) =>
        await new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }).generate(args);
    let calls = 0;
    let published: [Anchors, Anchors] | null = null;
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    provider.generate = async (args) => {
        calls += 1;
        if (calls === 1) return await respond(reads, args);
        if (calls === 2) {
            published = await anchorsFromLog(ctx);
            return await respond(frames(...published).join("\n\n"), args);
        }
        return await respond(PlurnkParser.frame("SEND [200]", "Done."), args);
    };
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 6, maxStrikes: 3, messages: [{ role: "user", content: "Apply the fix." }] });
    assert.equal(result.result.status, 200, JSON.stringify(result.result).slice(0, 300));
    assert.ok(published, "the program ran");
    const rows = (await Promise.all(result.turnIds.map((id) => db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: id })))).flat();
    const edits = rows.filter(({ op, origin }) => op === "EDIT" && origin === "model").map(({ status_rx, rx }) => {
        const parsed = JSON.parse(rx) as { receipt?: { effect?: { result?: string; context?: string } }; problem?: { unresolvedAnchors?: Unresolved[] } };
        return {
            status: status_rx,
            landed: parsed.receipt?.effect?.result ?? null,
            unresolved: parsed.problem?.unresolvedAnchors ?? null,
            context: parsed.receipt?.effect?.context?.split("\n") ?? null,
        };
    });
    return { edits, published };
};

const fileLines = async ({ root }: Ctx, file: string): Promise<string[]> => (await readFile(join(root, file), "utf8")).replace(/\n$/u, "").split("\n");
const expectLines = (lines: readonly string[], mutate: (draft: string[]) => void): string[] => { const draft = [...lines]; mutate(draft); return draft; };
const set = (draft: string[], line: number, ...body: string[]): void => { draft.splice(line - 1, 1, ...body); };
const setRange = (draft: string[], from: number, to: number, ...body: string[]): void => { draft.splice(from - 1, to - from + 1, ...body); };

type Case = {
    name: string;
    frames: (a: Anchors, b: Anchors) => string[];
    outcomes: Array<[status: number, landed: string | null | undefined]>;
    debug?: (draft: string[]) => void;
    helpers?: (draft: string[]) => void;
    unresolved?: (a: Anchors, b: Anchors) => Array<Unresolved[] | null>;
};

// Every program below is one model turn on the seeded file. `landed` is the receipt's effect; `undefined`
// leaves it unchecked (a deletion's receipt names no result region).
const COHERENT: Case[] = [
    {
        name: "far apart: the rollout's fix with the anchors of the lines it meant",
        frames: (a) => [edit(DEBUG, a(8), HTTP_IMPORT), edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<8>"], [200, "<11>"], [200, "<23>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); set(d, 11, URLS_IMPORT); set(d, 23, EXCEPT_404); },
    },
    {
        name: "adjacent lines, ascending: the second anchor survives the first edit to its neighbour",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(12), "from django.utils import timezone  # kept")],
        outcomes: [[200, "<11>"], [200, "<12>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); },
    },
    {
        name: "adjacent lines, descending",
        frames: (a) => [edit(DEBUG, a(12), "from django.utils import timezone  # kept"), edit(DEBUG, a(11), URLS_IMPORT)],
        outcomes: [[200, "<12>"], [200, "<11>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); },
    },
    {
        name: "own insertion above, then a hash below: the anchor follows its line down",
        frames: (a) => [edit(DEBUG, a(7), "from django.conf import settings\nfrom django.core.exceptions import ImproperlyConfigured"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7,8>"], [200, "<24>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); set(d, 7, "from django.conf import settings", "from django.core.exceptions import ImproperlyConfigured"); },
    },
    {
        name: "own shrink above (two lines into one), then a hash below: the anchor follows its line up",
        frames: (a) => [edit(DEBUG, `${a(7)},${a(8)}`, "from django.conf import settings  # merged"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7>"], [200, "<22>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); setRange(d, 7, 8, "from django.conf import settings  # merged"); },
    },
    {
        name: "own deletion above, then a hash below",
        frames: (a) => [edit(DEBUG, a(6), null), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, undefined], [200, "<22>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); setRange(d, 6, 6); },
    },
    {
        name: "an enclosing range after an inner edit: both endpoints survive, the range rewrites the current lines",
        frames: (a) => [edit(DEBUG, a(22), "        resolver_match = resolve(request.path_info)"), edit(DEBUG, `${a(21)},${a(23)}`, "    try:\n        match = resolve(request.path)\n    except Http404:")],
        outcomes: [[200, "<22>"], [200, "<21,23>"]],
        debug: (d) => { setRange(d, 21, 23, "    try:", "        match = resolve(request.path)", "    except Http404:"); },
    },
    {
        name: "numeric insertion above, then a hash below: continuity is about splices, not about how they were addressed",
        frames: (a) => [edit(DEBUG, "7", "from django.conf import settings\nimport logging"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7,8>"], [200, "<24>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); set(d, 7, "from django.conf import settings", "import logging"); },
    },
    {
        name: "hash insertion above, then a numeric scope below: numbers address current coordinates ({§op-methods-op-dispatch})",
        frames: (a) => [edit(DEBUG, a(7), "from django.conf import settings\nimport logging"), edit(DEBUG, "23", "        resolver_match = resolve(request.path_info)")],
        outcomes: [[200, "<7,8>"], [200, "<23>"]],
        debug: (d) => { set(d, 22, "        resolver_match = resolve(request.path_info)"); set(d, 7, "from django.conf import settings", "import logging"); },
    },
    {
        name: "an offset anchor whose base line's neighbour was edited earlier: the base carries, the offset applies ({§op-methods-op-dispatch})",
        frames: (a) => [edit(DEBUG, a(21), "    try:  # guarded"), edit(DEBUG, `${a(22)}+1`, EXCEPT_404)],
        outcomes: [[200, "<21>"], [200, "<23>"]],
        debug: (d) => { set(d, 21, "    try:  # guarded"); set(d, 23, EXCEPT_404); },
    },
    {
        name: "two files in one program, each by its own anchors",
        frames: (a, b) => [edit(DEBUG, a(11), URLS_IMPORT), edit(HELPERS, b(3), "GAMMA")],
        outcomes: [[200, "<11>"], [200, "<3>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); },
        helpers: (d) => { set(d, 3, "GAMMA"); },
    },
    {
        name: "a failing middle EDIT leaves both neighbours applied and names only its own anchor",
        frames: (a) => [edit(DEBUG, a(8), HTTP_IMPORT), edit(DEBUG, "@451ok", "nope"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<8>"], [409, null], [200, "<23>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); set(d, 23, EXCEPT_404); },
        unresolved: () => [null, [{ anchor: "@451ok", kind: "missing" }], null],
    },
    {
        name: "the same line twice: the second edit addresses it by current coordinate",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, "11", `${URLS_IMPORT}  # confirmed`)],
        outcomes: [[200, "<11>"], [200, "<11>"]],
        debug: (d) => { set(d, 11, `${URLS_IMPORT}  # confirmed`); },
    },
    {
        name: "a twin neighbourhood created by this program does not detach the original line's anchor",
        frames: (a) => [
            edit(DEBUG, "29", [DEBUG_LINES[28], ...DEBUG_LINES.slice(19, 24)].join("\n")),
            edit(DEBUG, a(22), "        resolver_match = resolve(request.path_info)"),
        ],
        outcomes: [[200, "<29,34>"], [200, "<22>"]],
        debug: (d) => { set(d, 22, "        resolver_match = resolve(request.path_info)"); set(d, 29, DEBUG_LINES[28], ...DEBUG_LINES.slice(19, 24)); },
    },
];

const REFUSED: Case[] = [
    {
        name: "the old anchor of a line this program already replaced",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(11), "from django.urls import resolve, reverse")],
        outcomes: [[200, "<11>"], [409, null]],
        debug: (d) => { set(d, 11, URLS_IMPORT); },
        unresolved: (a) => [null, [{ anchor: a(11), kind: "missing" }]],
    },
    {
        name: "the old anchor of a line this program already deleted",
        frames: (a) => [edit(DEBUG, a(12), null), edit(DEBUG, a(12), "from django.utils import timezone")],
        outcomes: [[200, undefined], [409, null]],
        debug: (d) => { setRange(d, 12, 12); },
        unresolved: (a) => [null, [{ anchor: a(12), kind: "missing" }]],
    },
    {
        name: "a range whose one endpoint this program already replaced names that endpoint alone",
        frames: (a) => [edit(DEBUG, a(23), EXCEPT_404), edit(DEBUG, `${a(21)},${a(23)}`, "    try:\n        match = resolve(request.path)\n    except Http404:")],
        outcomes: [[200, "<23>"], [409, null]],
        debug: (d) => { set(d, 23, EXCEPT_404); },
        unresolved: (a) => [null, [{ anchor: a(23), kind: "missing" }]],
    },
    {
        name: "another file's anchor is foreign here; the sibling after it still applies",
        frames: (a, b) => [edit(DEBUG, b(3), "GAMMA"), edit(DEBUG, a(8), HTTP_IMPORT)],
        outcomes: [[409, null], [200, "<8>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); },
        unresolved: (_a, b) => [[{ anchor: b(3), kind: "missing" }], null],
    },
];

const check = async (ctx: Ctx, c: Case, edits: EditRow[], a: Anchors, b: Anchors): Promise<void> => {
    assert.deepEqual(
        edits.map(({ status, landed }, index) => [status, c.outcomes[index]?.[1] === undefined ? undefined : landed]),
        c.outcomes.map(([status, landed]) => [status, landed]),
        `${c.name}: outcomes ${JSON.stringify(edits.map(({ status, landed, unresolved }) => ({ status, landed, unresolved })))}`,
    );
    if (c.unresolved !== undefined) {
        assert.deepEqual(edits.map(({ unresolved }) => unresolved), c.unresolved(a, b), `${c.name}: each refusal names exactly its own unresolved anchors`);
    }
    assert.deepEqual(await fileLines(ctx, DEBUG), expectLines(DEBUG_LINES, c.debug ?? (() => {})), `${c.name}: ${DEBUG} after the program`);
    assert.deepEqual(await fileLines(ctx, HELPERS), expectLines(HELPERS_LINES, c.helpers ?? (() => {})), `${c.name}: ${HELPERS} after the program`);
};

for (const c of COHERENT) test(`{§op-methods-op-dispatch}: coherent program, ${c.name}`, async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, c.frames);
        await check(ctx, c, edits, published[0], published[1]);
    });
});

for (const c of REFUSED) test(`{§op-methods-op-dispatch}: refused attempt, ${c.name}`, async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, c.frames);
        await check(ctx, c, edits, published[0], published[1]);
    });
});

test("{§edit-result-receipt-projection}: every EDIT receipt carries its own padded window, and a later receipt supersedes a neighbour's anchor", async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(12), "from django.utils import timezone  # kept"), edit(DEBUG, a(23), EXCEPT_404)]);
        const [a] = published;
        assert.deepEqual(edits.map(({ status, landed }) => [status, landed]), [[200, "<11>"], [200, "<12>"], [200, "<23>"]]);
        const contexts = edits.map(({ context }) => context!);
        assert.deepEqual(contexts.map((lines) => lines.length), [9, 9, 9], "four lines above and four below each single-line change");
        const anchorAt = (lines: string[], line: number): string => {
            const match = lines.map((text) => /^ *(\d+)<(@[0-9A-Za-z]{5})>/u.exec(text)).find((m) => m !== null && Number(m[1]) === line);
            assert.ok(match, `line ${line} in ${JSON.stringify(lines)}`);
            return match[2];
        };
        assert.notEqual(anchorAt(contexts[0], 12), a(12), "after line 11 changed, the first receipt already shows line 12 under a new anchor (its neighbourhood changed)");
        assert.equal(edits[1].landed, "<12>", "yet the program's original anchor for line 12 still landed there ({§op-methods-op-dispatch})");
        assert.notEqual(anchorAt(contexts[1], 11), anchorAt(contexts[0], 11), "the second receipt supersedes the first receipt's anchor for line 11");
        assert.equal(anchorAt(contexts[2], 23), anchorAt(contexts[2], 23));
        assert.match(contexts[2][4], /^ *23<@[0-9A-Za-z]{5}>    except Http404:$/u, "the changed line sits in the middle of its window");
    });
});

test("{§op-methods-op-dispatch}: across programs, a neighbour's packet anchor is stale and refused; the receipt's anchor is current; a far anchor still holds", async () => {
    await withProject(async (ctx) => {
        const first = await program(ctx, 1, (a) => [edit(DEBUG, a(11), URLS_IMPORT)]);
        assert.deepEqual(first.edits.map(({ status, landed }) => [status, landed]), [[200, "<11>"]]);
        const [stale] = first.published;
        const second = await program(ctx, 2, (a) => {
            assert.notEqual(a(12), stale(12), "line 12's anchor changed with its neighbourhood");
            assert.equal(a(23), stale(23), "line 23's anchor did not");
            return [
                edit(DEBUG, stale(12), "from django.utils import timezone  # stale attempt"),
                edit(DEBUG, a(12), "from django.utils import timezone  # kept"),
                edit(DEBUG, stale(23), EXCEPT_404),
            ];
        });
        assert.deepEqual(second.edits.map(({ status, landed, unresolved }) => [status, landed, unresolved]), [
            [409, null, [{ anchor: stale(12), kind: "missing" }]],
            [200, "<12>", null],
            [200, "<23>", null],
        ]);
        assert.deepEqual(await fileLines(ctx, DEBUG), expectLines(DEBUG_LINES, (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); set(d, 23, EXCEPT_404); }));
    });
});

test("{§op-methods-op-dispatch}: after a whole-file rewrite, every earlier anchor is stale", async () => {
    await withProject(async (ctx) => {
        const first = await program(ctx, 1, () => [edit(DEBUG, "1,-1", "# rewritten\n")]);
        assert.equal(first.edits[0].status, 200);
        const [original] = first.published;
        const second = await program(ctx, 2, () => [edit(DEBUG, original(23), EXCEPT_404)]);
        assert.deepEqual(second.edits.map(({ status, unresolved }) => [status, unresolved]), [[409, [{ anchor: original(23), kind: "missing" }]]]);
        assert.deepEqual(await fileLines(ctx, DEBUG), ["# rewritten"]);
    });
});
});

describe("Message.attachments", () => {
const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const next = "````NOTE\nDeliver selected resources.\n````";
const done = "````SEND [200]\nAttachment handling verified.\n````";

test("{§op-methods-op-dispatch}: session SEND snapshots only selected resources and a failed source sends nothing", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [
        turn(`\`\`\`\`EDIT (workspace:///selected.md)\noriginal\n\`\`\`\`\n\`\`\`\`EDIT (workspace:///private.md)\nunselected\n\`\`\`\`\n${next}`),
        turn(`\`\`\`\`SEND (session://receiver) [{"attachments":["workspace:///selected.md","workspace:///missing.md"]}]\nDo not deliver a partial message.\n\`\`\`\`\n${next}`),
        turn(`\`\`\`\`SEND (session://receiver) [{"attachments":["workspace:///selected.md"]}]\nReview this.\n\`\`\`\`\n\`\`\`\`EDIT (workspace:///selected.md) <1,-1>\nchanged\n\`\`\`\`\n\`\`\`\`WAIT\n\`\`\`\``),
        turn(done),
        turn(done),
    ] });
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "message-export", projectRoot: null });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const receiver = await daemon.createSession({ workspaceId, name: "receiver" });
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Send only the selected report." });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await waitForDb(() => lifecycle.status(started.loopId), (status) => status === 200 || status >= 400), 200);
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId: receiver.sessionId }), (loops) => loops.some((loop) => loop.status === 200));
        const received = (await daemon.readMessages({ workspaceId, sessionId: receiver.sessionId })).filter(({ direction }) => direction === "inbound");
        assert.equal(received.length, 1, "no dispatch occurs on partial acquisition failure");
        assert.match(received[0].body, /^Review this\.\n\n<session:\/\/receiver\/attachments\/[^/]+\/selected\.md>$/u);
        assert.equal(received[0].attachments.length, 1, "the unselected resource was never exported");
        assert.equal(received[0].attachments[0].name, "selected.md");
        assert.equal(received[0].attachments[0].mediaType, "text/markdown");
        assert.equal(Buffer.from(received[0].attachments[0].bytes).toString(), "original");
        const rows = await daemon.readLog({ workspaceId, sessionId, loopId: started.loopId });
        const failed = rows.filter((row) => row.op === "SEND" && row.status_rx === 404);
        assert.equal(failed.length, 1, "the source failure is a visible ordinary SEND failure");
        const senderPackets = provider.received.map((messages) => messages.map(chatMessageText).join("\n")).join("\n");
        assert.match(senderPackets, /"attachments":\[\{"name":"selected\.md","mediaType":"text\/markdown","path":"workspace:\/\/\/selected\.md"\}\]/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const body of ["Inspect this.", ""]) test(`{§op-methods-op-dispatch}: ${body ? "text and attachment" : "attachment-only"} session SEND carries a snapshot as a normal readable resource`, async () => {
    class Reader extends Mock {
        override async generate(...args: Parameters<Mock["generate"]>) {
            const response = await super.generate(...args);
            if (!response.assistant.content.includes("$RESOURCE")) return response;
            const packet = args[0].messages.map(chatMessageText).join("\n");
            const path = /<(session:\/\/receiver\/attachments\/[^>]+)>/u.exec(packet)?.[1];
            assert.ok(path, "the peer gets an ordinary attachment link");
            return { ...response, assistant: { ...response.assistant, content: response.assistant.content.replace("$RESOURCE", path) } };
        }
    }
    const provider = new Reader({ contextWindow: 100_000, responses: [turn(`\`\`\`\`READ ($RESOURCE) <1,-1>\n\`\`\`\`\n${next}`), turn(done)] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "session-attachments", projectRoot: null });
        const receiver = await daemon.createSession({ workspaceId, name: "receiver" });
        const program = PlurnkParser.parseStatements([
            PlurnkParser.frame("EDIT (workspace:///report.md)", "original peer report"),
            PlurnkParser.frame('SEND (session://receiver) [{"attachments":42}]', "Do not deliver invalid input."),
            PlurnkParser.frame('SEND (session://receiver) [{"attachments":["workspace:///report.md"]}]', body),
            PlurnkParser.frame("EDIT (workspace:///report.md) <1,-1>", "changed"),
        ].join("\n\n"));
        assert.ok(program.items.every((item) => item.kind === "statement"));
        // A person's operation sends to the session ({§connection-lifecycle}).
        const results = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER,
            statements: program.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []) });
        assert.deepEqual(results.map(({ status }) => status), [201, 400, 200, 200], JSON.stringify(results));
        assert.match(JSON.stringify(results[1]), /attachments-invalid/u, "SEND metadata reaches its recipient for validation");
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId: receiver.sessionId }), (loops) => loops.some((loop) => loop.status === 200));
        const received = (await daemon.readMessages({ workspaceId, sessionId: receiver.sessionId })).filter(({ direction }) => direction === "inbound");
        assert.equal(received.length, 1, "invalid SEND metadata is not discarded to deliver a different message");
        assert.equal(received[0].attachments.length, 1);
        assert.equal(Buffer.from(received[0].attachments[0].bytes).toString(), "original peer report");
        assert.match(provider.received[1].map(chatMessageText).join("\n"), /original peer report/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("disposition-order", () => {
const response = (content: string) => ({ assistant: { content, reasoning: null } });

// {§disposition-anywhere} {§emission-admission}
test("{§disposition-anywhere} a KILL after SEND executes: curation and the reply persist before a later conclusion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "disposition-order");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Deliver the answer and curate the note.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const seed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("```EDIT (workspace:///note.md)\nEvidence.\n```\n```NOTE\nReview.\n```")] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        const originalRows = await db.test_log_entries_by_turn.all<{ id: number; sequence: number; op: string; active: number }>({ turn_id: seed.turnId });
        const plan = originalRows.find(({ op }) => op === "NOTE");
        assert.ok(plan);
        const turn = await db.test_latest_model_turn_in_loop.get<{ sequence: number }>({ loop_id: loopId });
        assert.ok(turn);
        const source = `\`\`\`\`SEND
Answer.
\`\`\`\`
\`\`\`\`KILL (log:///1/${turn.sequence}/${plan.sequence}/NOTE)\`\`\`\``;
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "a progress reply leaves the message unresolved");
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["SEND", 200], ["KILL", 200]]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; attrs: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter((row) => row.op !== null && row.op !== "prompt" && !LogEntryProjection.isEmission(row)).map(({ op }) => op), ["SEND", "KILL"]);
        const send = rows.find(({ op }) => op === "SEND");
        assert.ok(send);
        assert.equal(JSON.parse(send.tx).body.raw, "Answer.");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, source);
        const curated = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({ turn_id: seed.turnId });
        assert.equal(curated.find(({ id }) => id === plan.id)?.active, 0, "the KILL authored after SEND curated the earlier note");
        assert.equal((await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("```SEND [200]\n```")] }),
            workspaceId, sessionId, loopId, messages: [],
        })).status, 200);
    } finally { await db.close(); }
});

test("{§matcher-refusal} SEND authored first: later operations run in authored order and completion waits for their results", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "next-order");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Create and inspect the note.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = "```SEND\nInspect results.\n```\n```EDIT (workspace:///note.md)\nCreated before READ.\n```\n```READ (workspace:///note.md)```\n```FIND (workspace:///*) /[/```";
        const result = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }), workspaceId, sessionId, loopId, messages: [] });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["SEND", 200], ["EDIT", 201], ["READ", 200], ["FIND", 400]],
            "the reply, mutations, retrieval, and the refused matcher ({§matcher-refusal}) retain authored order");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; attrs: string }>({ turn_id: result.turnId });
        const read = rows.find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
        assert.ok(read);
        assert.equal(JSON.parse(read.rx).content, "Created before READ.", "the actual READ observed the EDIT that preceded it");
    } finally { await db.close(); }
});

test("{§unparsed-tail-boundary} a lost boundary refuses only what follows it: the statements before it run, the loss is a row", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "admit-before-loss");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [
                response("```EDIT (workspace:///before-loss.md)\nKept.\n```\n```WAIT\nContinue.\n```\n```READ (unfinished"),
            ] }), workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "the failed row keeps the loop going; nothing was resampled");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors).map(({ line, column, source }: { line: number; column: number; source: string }) => ({ line, column, source }))]), [[1, [{
            line: 7, column: 0, source: "grammar",
        }]]], "the one attempt is admitted and carries the tail as its diagnostic");
        const [{ message }] = JSON.parse(attempts[0].parse_errors) as [{ message: string }];
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.some(({ op }) => op === "EDIT"), true, "the statement that closed before the loss ran");
        const loss = rows.find(({ op }) => op === "error");
        assert.ok(loss, "the loss is a failed row of the same turn");
        const problem = JSON.parse(loss.rx).problem;
        assert.equal(problem.detail, message, "the loss row carries the attempt's tail diagnostic");
        assert.equal(problem.siblingsRetained, true);
    } finally { await db.close(); }
});

test("{§disposition-anywhere} internal turn programs admit a disposition anywhere like model turns", () => {
    const source = "```KILL (log:///1/1/*)\n```\n\n```WAIT\nContinue.\n```";
    const statements = TurnOps.parseInternal(source);
    assert.deepEqual(statements.map(({ op }) => op), ["KILL", "WAIT"]);
    assert.equal(TurnOps.renderInternal(statements), source);
    // {§disposition-anywhere} — a program that authors an operation after its disposition is valid turnOps.
    const first = TurnOps.parseInternal("```WAIT\nContinue.\n```\n```KILL (log:///1/1/*)```");
    assert.deepEqual(first.map(({ op }) => op), ["WAIT", "KILL"]);
});
});

describe("end_to_end_mock", () => {
const e2eEditStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
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

test("{§send-premature-terminate} e2e: single-turn EDIT + SEND — entry created, log rows populated, statuses match", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-single");
        const provider = new Mock({
            contextWindow: 100000,
            // {§send-premature-terminate} — an EDIT receipt lands next packet, so the turn continues.
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
        assert.equal(logRows[0]?.op, "EDIT");
        assert.equal(logRows[0]?.sequence, 1);
        assert.equal(logRows[0]?.status_rx, 201);
        assert.equal(logRows[0]?.pathname, "/france/capital");
        assert.equal(logRows[1]?.op, "NOTE");
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
            op: "READ", aside: null,
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
            .filter((r) => r.op === "READ");
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
const frame = PlurnkParser.frame;

test("{§turn-source-resources} #713: notes have durable sources, normal log curation, and do not block completion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lifecycle-notes");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the parser and report the result.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reasoning = [frame("NOTE", "The network is not the cause."), frame("EDIT (should-not-exist.txt)", "Never execute reasoning edits.")].join("\n\n");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: frame("NOTE", "Inspect the parser next."), reasoning } },
            { assistant: { content: frame("KILL (log:///1/2/*/NOTE)", null), reasoning: null } },
            { assistant: { content: frame("SEND [200]", "Finished."), reasoning: frame("NOTE", "Both checks passed.") } },
        ] });
        const first = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(first.status, 102);
        const second = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const notes = logEntries(packet).filter((row) => /^log:\/\/\/1\/2\/\d+\/NOTE$/.test(row.logPath));
        assert.equal(notes.length, 2, "reasoning and content NOTEs both retain ordinary receipt addresses");
        assert.deepEqual(notes.map((row) => row.resource), notes.map((row) => `note://alice/${row.logPath.replace(/^log:\/\/\//u, "").replace(/\/NOTE$/u, "")}`), "each ordinary receipt exposes its recoverable source at its own coordinate");
        assert.ok(notes.every((row) => row.origin === undefined || row.origin === "model"));
        // Source identity never depends on the reader ({§turn-source-resources}); alice's later packets are under test.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const read = (source: string, reader = observer) => clientRead(engine, db, { workspaceId, sessionId: reader, statement: parseSingleStatement(source) });
        const firstSource = await read(frame(`READ (${String(notes[0].resource)}) <1,-1>`, null));
        assert.equal(firstSource.status, 200);
        assert.equal(firstSource.content, "The network is not the cause.");
        const contentNote = /^log:\/\/\/(1\/2\/\d+)\/NOTE$/u.exec(notes[1].logPath)?.[1];
        assert.ok(contentNote, "the content NOTE has its own receipt coordinate");
        const secondSource = await read(frame(`READ (note://alice/${contentNote}) <1,-1>`, null));
        assert.equal(secondSource.content, "Inspect the parser next.", "the receipt coordinate reads the content NOTE's durable source");
        const final = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(final.status, 200, "an extracted note is not an unseen external result");
        const finalPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: final.turnId }))!.packet);
        assert.equal(logEntries(finalPacket).filter((row) => /^log:\/\/\/1\/2\/\d+\/NOTE$/.test(row.logPath)).length, 0);
        const sourceAgain = await read(frame(`READ (${String(notes[0].resource)}) <1,-1>`, null));
        assert.equal(sourceAgain.content, "The network is not the cause.", "curating the log does not delete the source note");
        const rawReasoning = await read(frame("READ (reasoning://alice/1/2) <1,-1>", null));
        assert.equal(rawReasoning.content, reasoning);
        const found = await engine.dispatch({ ...context, turnId: final.turnId, sequence: 40, origin: "model",
            statement: parseSingleStatement(frame("FIND (note://alice/1/2/*) /parser/", null)),
        });
        assert.equal(found.status, 200);
        assert.deepEqual(resourcePaths(found as FindResult), [`note://alice/${contentNote}`], "source search still works after log curation");
        const fork = await Fork.fork(db, sessionId, "branch");
        const inherited = await read(frame(`READ (${String(notes[0].resource).replace("note://alice/", "note://branch/")}) <1,-1>`, null), fork);
        assert.equal(inherited.content, firstSource.content, "FORK preserves source identity and content");
        for (const op of ["EDIT", "KILL"]) {
            const refused = await engine.dispatch({ ...context, turnId: final.turnId, sequence: op === "EDIT" ? 50 : 51, origin: "model",
                statement: parseSingleStatement(frame(`${op} (${String(notes[0].resource)})`, op === "EDIT" ? "Changed" : null)),
            });
            assert.equal(refused.status, 403, `${op} cannot change immutable note evidence`);
        }
        const missing = await read(frame("READ (note://alice/1/2/99)", null));
        assert.equal(missing.status, 404, "an absent note is not an invented empty source");
    } finally { await db.close(); }
});

test("{§wait-obligation-matrix} empty WAIT falls through and SEND plus a retrieval observes before concluding", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lifecycle-fallthrough");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the recorded operations, then answer.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: frame("WAIT", "Wait for results."), reasoning: null } },
            { assistant: { content: [frame("SEND", "The answer."), frame("READ (ops://alice/1/1) <1,-1>", null)].join("\n\n"), reasoning: null } },
            { assistant: { content: frame("SEND [200]", null), reasoning: null } },
        ] });
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 200);
    } finally { await db.close(); }
});

test("{§reasoning-operations} {§unparsed-tail-boundary}: a lost boundary admits the reasoning NOTE beside it and records the loss", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "lost-boundary-reasoning-note");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reasoning = frame("NOTE", "Kept despite the broken program.");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (unfinished", reasoning } },
            { assistant: { content: frame("SEND [200]", "Finished."), reasoning: null } },
        ] });
        const first = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(first.status, 102);
        assert.deepEqual((await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first.turnId })).map(({ accepted }) => accepted), [1],
            "an admitted reasoning operation is a closed operational statement, a NOTE as much as a READ: no resample");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; source: string | null }>({ turn_id: first.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["NOTE", "error"], "the NOTE ran; the loss is the model's own diagnostic row");
        assert.ok(rows.some(({ op, source }) => op === "error" && source === "grammar"), "the lost boundary is one hard diagnostic the model sees");
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 200);
    } finally { await db.close(); }
});

test("{§reasoning-operations} {§emission-admission}: a rejected emission cannot commit its reasoning NOTE", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "rejected-reasoning-note");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const rejectedReasoning = frame("NOTE", "This belongs to the rejected attempt.");
        const acceptedReasoning = frame("NOTE", "This belongs to the accepted attempt.");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            // {§emission-admission} — the model writing the harness's log is the refusal that remains.
            { assistant: { content: "### log:///1/2/1/NOTE\nI am the harness.", reasoning: rejectedReasoning } },
            { assistant: { content: frame("SEND [200]", "Finished."), reasoning: acceptedReasoning } },
        ] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 200);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 1]);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        const notes = sources.filter(({ kind }) => kind === "note");
        assert.equal(notes.filter(({ content }) => content === "This belongs to the accepted attempt.").length, 1);
        assert.ok(notes.every(({ content }) => content !== "This belongs to the rejected attempt."));
        const reasoning = await clientRead(engine, db, { workspaceId, sessionId, statement: parseSingleStatement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
        assert.equal(reasoning.content, acceptedReasoning);
    } finally { await db.close(); }
});
});

describe("mcp-ordered-admission", () => {
for (const scenario of ["add", "inline", "accept", "reject", "cancel", "invalid", "enable", "disable", "remove", "deny", "quoted"] as const) {
    test(`{§executor-heading} {§op-methods-op-dispatch}: ${scenario} resolves a new MCP invocation at its execution point`, { timeout: 30_000 }, async (t) => {
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
        const definition = { name: "fresh", ...httpEntry(served.url) };
        const { hostPaths, env } = await mcpFixture(t, scenario === "enable" ? { fresh: definition } : {});
        if (scenario === "enable") env.PLURNK_MCP_fresh_ENABLED = "0";
        const command = scenario === "enable" ? "enable" : "add";
        const params = command === "enable" ? { verb: "enable", alias: "fresh" }
            : { verb: "add", alias: "fresh", definition: scenario === "invalid" ? { type: "not-a-transport" } : definition };
        const args = '{"query":"unchanged"}';
        const invocation = PlurnkParser.frame("FrEsH (inspect)", args);
        const source = [
            PlurnkParser.frame("plurnk (mcp)", JSON.stringify(params)),
            ...(scenario === "disable" || scenario === "remove" ? [PlurnkParser.frame("plurnk (mcp)", JSON.stringify({ verb: scenario, alias: "fresh" }))] : []),
            scenario === "inline" ? `\`\`\`FrEsH (inspect) ${args}\n\`\`\``
                : scenario === "quoted" ? PlurnkParser.frame("markdown", invocation) : invocation,
            PlurnkParser.frame("NOTE", "Observe the result."),
        ].join("\n\n");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeRawMockResponse(source), makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Finished.")),
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
        const source = paths.map((path) => PlurnkParser.frame(`EDIT (${path}) <1,-1>`, "changed")).join("\n\n");
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
                if (cancelledAt === undefined && rows.some((row) => row.id === id && row.origin === "model" && row.op === "EDIT")) {
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
        assert.deepEqual(rows.filter((row) => row.origin === "model" && row.op === "EDIT").map(({ id, status_rx }) => [id, status_rx]), [[cancelledAt, 200]]);
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
const frame = PlurnkParser.frame;
const surveyRead = frame("READ (reasoning://analyst/1/1)", null);
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
    const first = `${frame("EDIT (workspace:///memory.md) <!-- remember -->", body)}\n\n${frame("NOTE", "CURATABLE-MEMORY: retain the actual observation.")}`;
    const curate = frame("KILL (log:///1/2/*/NOTE)", null);
    const read = frame("READ (ops://analyst/1/2) <1,-1>", null);
    const { db, result, provider, rows, sessionId } = await run("envelope-source", "Work, curate, then inspect your original program.", [
        say(first, frame("NOTE", "REASONING-MEMORY: independent reasoning note.")),
        say(curate), say(read), say(frame("SEND [200]", "Complete.")),
    ], 5);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 4);
    const edit = frame("EDIT (workspace:///memory.md) <!-- remember -->", body);
    assert.equal(previous(provider.received[1]), first, "EDIT and NOTE replay whole");
    assert.match(userText(provider.received[1]), /REASONING-MEMORY/u);
    assert.doesNotMatch(userText(provider.received[1]), /CURATABLE-MEMORY/u, "the paired NOTE receipt does not duplicate its body");
    assert.equal(previous(provider.received[2]), edit, "the curated NOTE leaves the replay; the surviving EDIT remains");
    assert.doesNotMatch(userText(provider.received[2]), /CURATABLE-MEMORY/u, "the curated NOTE has no historical replay duplicate");
    assert.equal(previous(provider.received[3]), `${edit}\n\n${read}`, "the explicit source READ joins the surviving history");
    assert.match(userText(provider.received[3]), /CURATABLE-MEMORY/u, "an explicit READ retrieves the complete program");
    assert.match(userText(provider.received[3]), /FULL-BODY line 120/u);
    const reads = await db.test_log_entries_by_session_op_full.all<{ pathname: string; rx: string }>({ session_id: sessionId, op: "READ" });
    assert.ok(reads.some(({ pathname, rx }) => pathname === "/1/2" && (JSON.parse(rx) as { content?: string }).content === first));
    assert.equal((JSON.parse(rows.find(({ coordinate }) => coordinate.startsWith("1/2/"))!.rx) as { content: string }).content, first);
});

test("{§turn-source-resources}: initialization has no replay; canonical content carries interstitial text as the NOTEs it became and preserves row chronology", async (t) => {
    const canonical = `${frame("NOTE", "Let me look around first.")}\n\n${surveyRead}\n\n${frame("NOTE", "Bearings: nothing read yet.")}\n\n${frame("NOTE", "Done for now.")}`;
    const { db, result, provider, rows } = await run("envelope-chronology", "Answer.", [
        say(`Let me look around first.\n\n${surveyRead}\n\n${frame("NOTE", "Bearings: nothing read yet.")}\n\nDone for now.`), say(frame("SEND [200]", "Answer.")),
    ], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.deepEqual(rows.map(({ coordinate }) => coordinate), ["1/2/2", "1/3/1"]);
    for (const row of rows) {
        assert.equal(row.origin, "_plurnk");
        assert.equal(row.op, "READ");
        assert.equal(row.scheme, "ops");
        assert.equal(row.pathname, `/${row.coordinate.split("/").slice(0, 2).join("/")}`);
        assert.deepEqual(JSON.parse(row.initial_folded), [[1, -1]]);
        assert.equal(row.active, 1);
    }
    assert.equal(previous(provider.received[0]), "");
    assert.equal(previous(provider.received[1]), canonical, "normalization preserves each operation at its position");
    assert.equal(JSON.parse(rows[0].rx).content, canonical, "the frozen row preserves the complete admitted program, interstitial text as NOTEs at their positions");
    assert.match(userText(provider.received[1]), /### log:\/\/\/1\/2\/1\/SEND[\s\S]*### log:\/\/\/1\/2\/2\/emission[\s\S]*### log:\/\/\/1\/2\/4\/READ/u);
    const request = provider.received[1];
    assert.deepEqual(request.map(({ role }) => role), ["system", "user", "assistant", "user"], "the turn replays as one assistant message");
    assert.match(chatMessageText(request[1]), /### log:\/\/\/1\/2\/1\/SEND[\s\S]*### log:\/\/\/1\/2\/2\/emission[^\n]*$/u, "incoming observations precede the content operations");
    assert.match(chatMessageText(request[3]), /^### log:\/\/\/1\/2\/3\/NOTE[\s\S]*### log:\/\/\/1\/2\/4\/READ/u, "the turn's results follow the operations that caused them");
});

test("{§turn-source-resources}: curation retires the immediately preceding emission without reviving an older one", async (t) => {
    const mode = process.env.PLURNK_SERVICE_EMISSION_HISTORY;
    process.env.PLURNK_SERVICE_EMISSION_HISTORY = "latest";
    t.after(() => { if (mode === undefined) delete process.env.PLURNK_SERVICE_EMISSION_HISTORY; else process.env.PLURNK_SERVICE_EMISSION_HISTORY = mode; });
    const newest = frame("NOTE", "Newest memory.");
    const f = await run("envelope-retire", "Work.", [say(`${surveyRead}\n\n${frame("NOTE", "Older memory.")}`), say(`${newest}\n\n${frame("SEND", "Newest program.")}`)], 2);
    t.after(() => f.db.close());
    const builder = new PacketBuilder({ db: f.db, schemes: f.schemes, executors: () => undefined });
    const build = () => builder.buildRequestPacket({ ...f, initialMessages: [], currentTurnSeq: 5, gitStatus: null });
    assert.equal(PacketWire.sectionContent(await build(), "emission-history"), `${newest}\n\n${frame("SEND", "Newest program.")}`);
    const last = f.rows.at(-1)!;
    const turnId = await insertTurn(f.db, f.loopId, 4);
    const result = await f.engine.dispatch({ ...f, turnId, sequence: 1, origin: "model", statement: killStmt(urlPath("log", `/${last.coordinate}/emission`)) });
    assert.equal(result.status, 200);
    assert.equal(PacketWire.sectionContent(await build(), "emission-history"), "");
    assert.ok(PacketWire.sectionContent(await build(), "log").includes("log:///1/2/2/emission"), "an older live emission is not replayed");
});

test("{§turn-source-resources}: a scoped KILL cannot partially curate a program; a sweep preserves it and an unscoped KILL retires it", async (t) => {
    const { db, result, provider, rows } = await run("envelope-scope", "Answer.\nSecond line.\nThird line.", [
        say(frame("EDIT (workspace:///scope.md)", "line one\nline two\nline three")),
        say(frame("KILL (log:///1/2/2/emission) <1,-1>", null)),
        say(frame("KILL (log:///1/2/*) <2,3>", null)),
        say(frame("KILL (log:///1/2/2/emission)", null)), say(frame("SEND [200]", "Answer.")),
    ], 6);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.match(userText(provider.received[2]), /### log:\/\/\/1\/3\/\d+\/KILL[^\n]*\n\{[^\n]*"status":422/u);
    assert.match(userText(provider.received[2]), /is an emission; curate it without a line scope/u);
    assert.match(userText(provider.received[2]), /KILL \(log:\/\/\/1\/2\/2\/emission\) retires it\./u, "the recovery names the one form that retires it");
    assert.match(userText(provider.received[2]), /### log:\/\/\/1\/2\/2\/emission/u);
    assert.match(userText(provider.received[3]), /### log:\/\/\/1\/2\/2\/emission/u, "a partial sweep leaves it intact");
    assert.doesNotMatch(userText(provider.received[4]), /### log:\/\/\/1\/2\/2\/emission/u, "the unscoped KILL retires it");
    const retired = rows.find(({ coordinate }) => coordinate === "1/2/2")!;
    assert.equal(retired.active, 0);
    assert.deepEqual(JSON.parse(retired.folded), []);
});

test("{§turn-source-resources} {§emission-admission}: an echoed emission heading is tolerated and dropped, never a NOTE, never replayed", async (t) => {
    const { db, result, provider, rows } = await run("envelope-echo", "Answer.", [
        say(`### log:///1/2/2/emission (ops://exampleSessionName/1/2) · 30\n\n${surveyRead}\n\n${frame("NOTE", "Noted.")}`), say(frame("SEND [200]", "Answer.")),
    ], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.equal((JSON.parse(rows.find(({ coordinate }) => coordinate === "1/2/2")!.rx) as { content: string }).content, `${surveyRead}\n\n${frame("NOTE", "Noted.")}`,
        "the echo is absent from the canonical program; the text beside the operations that was not an echo would be a NOTE");
    assert.equal(previous(provider.received[1]), `${surveyRead}\n\n${frame("NOTE", "Noted.")}`, "the replay carries the admitted operations, not the echo");
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

test("{§entry-owner} parser roundtrip: EDIT writes the resource", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = parseOne("````EDIT (workspace:///countries/france/capital)\nParis\n````") as EditStatement;
        const result = await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entry = await db.test_parser_entries_first.get<{ workspace_id: number; scheme: string; pathname: string }>();
        assert.ok((entry?.workspace_id ?? 0) >= 1, "owner stamped ({§entry-owner})");
        assert.equal(entry?.scheme, "workspace");
        assert.equal(entry?.pathname, "/countries/france/capital");
        const body = await db.test_parser_body_first.get<{ content: string }>();
        assert.equal(body?.content, "Paris");

    } finally { await db.close(); }
});

// {§empty-section} {§text-scope-semantics}
test("{§empty-section} parser roundtrip: an empty EDIT section performs a scoped deletion", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-empty-edit");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const statements = [
            parseOne("````EDIT (workspace:///scoped-delete)\nalpha\nbeta\ngamma\n````"),
            parseOne("````EDIT (workspace:///scoped-delete) <2>````"),
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
        const text = `\`\`\`\`EDIT (workspace:///a)
first
\`\`\`\`

\`\`\`\`EDIT (workspace:///b)
second
\`\`\`\`

\`\`\`\`EDIT (workspace:///c)
third
\`\`\`\``;
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
            statement: parseOne("````EDIT (workspace:///france)\nThe capital is Paris.\n````"),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });

        const readResult = await engine.dispatch({
            statement: parseOne("````READ (workspace:///france)````"),
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

        const stmt = parseOne("````READ (https://en.wikipedia.org/wiki/Paris)````") as ReadStatement;
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

test("{§fence-boundary} parser roundtrip: real DSL preserves serialized query + fragment on opaque scheme", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, "ws-roundtrip-params");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const stmt = parseOne("````READ (workspace:///france?lang=fr#History)````") as ReadStatement;
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

// {§fence-boundary}
const stripVolatile = (stmt: PlurnkStatement): object => {
    const { position: _position, ...rest } = stmt;
    return rest;
};

for (const [header, body] of [
    ["EDIT (workspace:///countries/france/capital)", "Paris"],
    ["FIND (workspace:///users.json) $.name", ""],
    ["SEND (workspace:///result)", "Paris"],
    ["sh", "uname -r"],
]) {
    test(`{§fence-boundary} parser: fence length does not change the AST (${header})`, () => {
        const lines = body === "" ? "" : `${body}\n`;
        const short = parseOne(`\`\`\`\`${header}\n${lines}\`\`\`\``);
        const long = parseOne(`\`\`\`\`\`${header}\n${lines}\`\`\`\`\``);
        assert.deepEqual(stripVolatile(short), stripVolatile(long));
    });
}

test("{§fence-closer} parser: a 3-backtick block stays literal in a 4-backtick body", () => {
    const body = "quoted section:\n```EDIT (workspace:///inner)\nhello\n```";
    const stmts = parseAll(`\`\`\`\`EDIT (workspace:///demo)\n${body}\n\`\`\`\``);
    assert.equal(stmts.length, 1, "a shorter inner fence never closes the body");
    assert.equal(stmts[0]?.op, "EDIT");
    assert.equal((stmts[0]).body, body);
});

// {§unclosed-mutation-yields}: an example inside an EDIT is written with a wider fence; at the
// EDIT's own width a native heading is an operation, closed or not.
test("{§unclosed-mutation-yields} parser: an equal-width EDIT heading inside an EDIT body runs; a wider fence holds it as body", () => {
    const body = "quoted section:\n````EDIT (workspace:///inner)\nhello\n````";
    const bare = parseAll("````EDIT (workspace:///demo)\n" + body + "\n````");
    assert.deepEqual(bare.map(({ op }) => op), ["EDIT", "EDIT"], "at equal width the inner heading is a second mutation");
    assert.equal((bare[0] as EditStatement).body, "quoted section:");
    assert.equal((bare[1] as EditStatement).body, "hello");
    const wider = parseAll("`````EDIT (workspace:///demo)\n" + body + "\n`````");
    assert.equal(wider.length, 1, "a wider fence holds the quoted heading as body");
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
    const frame = PlurnkParser.frame;
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
                ...[bare, url].flatMap((path) => [frame(`FIND (${path})`, null), frame(`READ (${path})`, null)]),
                frame(`READ (${PathSyntax.escapeTarget(String.raw`a\*.txt`)})`, null),
            ].join("\n\n"), 50),
            makeMockResponse(frame(`EDIT (${url}) <1,-1>`, "Revised\n"), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const client = await connect(addr);
            try {
                await rpcCall(client, 1, "workspace.create", { name: "literal-globs", projectRoot: root });
                const loop = await runLoopToTerminal(client, 2, { prompt: "Select the literal names." });
                assert.equal(loop.result.status, 200);
                const rows = (await db.engine_render_log.all<{ op: string; origin: string; pathname: string; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! }))
                    .filter(({ origin }) => origin === "model");
                assert.deepEqual(rows.filter(({ op }) => op === "READ").map(({ pathname, status_rx }) => ({ pathname, status_rx })),
                    [intended, intended, "a*.txt"].map((pathname) => ({ pathname, status_rx: 200 })));
                const finds = rows.filter(({ op }) => op === "FIND");
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
                assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ pathname, status_rx }) => ({ pathname, status_rx })), [{ pathname: intended, status_rx: 200 }]);
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

for (const op of ["EDIT", "KILL"] as const) {
    test(`{§op-methods-op-dispatch} ${op} applies a scoped matcher to every selected resource`, async (t) => {
        const { dispatch, content, rows } = await fixture(t, { "/a.txt": "foo one\nfoo two", "/b.txt": "foo three\nfoo four", "/other.md": "foo five" });
        const target = urlPath("workspace", "/@(a|b).txt");
        const statement = op === "EDIT" ? editStmt(target, "bar", { marks: [1, 1] }, regex("foo")) : killStmt(target, { marks: [1, 1] }, regex("foo"));
        const result = await dispatch(statement);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.rowsWritten, 2);
        assert.equal(Object.hasOwn(result, "commandsExecuted"), false, "dispatch accounting is not an operation result");
        assert.equal(Object.hasOwn(result, "commandsOmitted"), false);
        assert.equal(await content("/a.txt"), `${op === "EDIT" ? "bar" : ""} one\nfoo two`);
        assert.equal(await content("/b.txt"), `${op === "EDIT" ? "bar" : ""} three\nfoo four`);
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
        const result = await dispatch(op === "EDIT" ? editStmt(target, "new", fullReplace) : killStmt(target));
        assert.equal(result.status, 204, JSON.stringify(result));
        assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/missing*.txt", 204]]);
        assert.equal(await content("/a.txt"), "unchanged");
        assert.equal((await dispatch(readStmt(urlPath("workspace", "/missing*.txt")))).status, 204, "no literal wildcard resource was created");
    });
}

for (const op of ["READ", "EDIT", "KILL"] as const) {
    test(`{§op-methods-op-dispatch} ${op} preserves the selected nondefault channel`, async (t) => {
        const { db, dispatch, content, ids, rows } = await fixture(t, { "/a.txt": "body a", "/b.txt": "body b" }, "channels");
        for (const entryId of ids.values()) await db.test_seed_channel.run({ entry_id: entryId, name: "notes", content: "selected", mimetype: "text/plain", state: "static" });
        const target = urlPath("channels", "/*.txt", "notes");
        const result = await dispatch(op === "READ" ? readStmt(target) : op === "EDIT" ? editStmt(target, "replacement", fullReplace) : killStmt(target, fullReplace));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.rowsWritten, 2);
        for (const path of ids.keys()) {
            assert.equal(await content(path), `body ${path[1]}`);
            assert.equal(await content(path, "notes"), op === "EDIT" ? "replacement" : op === "KILL" ? "" : "selected");
        }
        if (op === "READ") assert.deepEqual((await rows()).map(({ rx }) => JSON.parse(rx).content), ["selected", "selected"]);
    });
}

for (const op of ["COPY", "MOVE"] as const) {
    for (const operand of ["source", "destination"] as const) {
        for (const count of [0, 1, 2]) {
            test(`{§op-methods-op-dispatch} ${op} ${operand} glob with ${count} matches`, async (t) => {
                const entries = { "/source.txt": "source\ntail", "/destination.txt": "destination", ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`/match${i}.txt`, operand === "source" ? "source\ntail" : "destination"])) };
                const { dispatch, content, rows } = await fixture(t, entries);
                const source = urlPath("workspace", operand === "source" ? "/match*.txt" : "/source.txt");
                const destination = urlPath("workspace", operand === "destination" ? "/match*.txt" : "/destination.txt");
                const result = await dispatch((op === "COPY" ? copyStmt : moveStmt)(source, destination, { marks: [1, 1] }, fullReplace));
                assert.equal(result.status, count === 1 ? 200 : 400, JSON.stringify(result));
                if (count !== 1) {
                    assert.ok(result.problem?.type.endsWith("/target-cardinality"), JSON.stringify(result));
                    assert.equal(result.problem?.detail, `${op} ${operand} matched ${count} resources; expected one.`);
                    for (const [path, original] of Object.entries(entries)) assert.equal(await content(path), original, `${path} must not change`);
                } else {
                    assert.equal(await content(operand === "destination" ? "/match0.txt" : "/destination.txt"), "source\n", "line selection preserves its separator");
                    assert.equal(await content(operand === "source" ? "/match0.txt" : "/source.txt"), op === "MOVE" ? "tail" : "source\ntail");
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

for (const op of ["EDIT", "KILL"] as const) {
    test(`{§op-methods-op-dispatch} ${op} is complete even when the FIND preview holds one item`, async (t) => {
        previewLines(t, 1);
        const entries = { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c", "/nested/d.txt": "d" };
        const { dispatch, content, rows } = await fixture(t, entries);
        const target = urlPath("workspace", "/**/*.txt");
        const result = await dispatch(op === "EDIT" ? editStmt(target, "changed", fullReplace) : killStmt(target));
        assert.ok(result.status < 300, JSON.stringify(result));
        assert.equal(result.rowsWritten, 4);
        for (const path of Object.keys(entries)) assert.equal(await content(path), op === "EDIT" ? "changed" : undefined, path);
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
            statements: TurnOps.parseInternal(PlurnkParser.frame(`EDIT (workspace:///*.txt) <${anchor}>`, "updated")),
        });
        if (failOnOperationError) await assert.rejects(execution, OperationFailureError);
        else await execution;
        assert.equal(await content("/a.txt"), "updated\nsecond");
        assert.equal(await content("/b.txt"), "different");
        assert.equal(await content("/c.txt"), "first\nsecond", "identical content in another resource does not share the READ anchor");
        const edits = (await rows()).filter(({ op }) => op === "EDIT");
        assert.deepEqual(edits.map(({ status_rx }) => status_rx), failOnOperationError ? [200, 409] : [200, 409, 409]);
        assert.match(JSON.parse(edits[1].rx).problem.type, /\/edit-collision$/);
    });
}

for (const op of ["READ", "EDIT", "KILL"] as const) for (const limit of [0, 1, 2, Infinity]) {
    test(`{§op-methods-op-dispatch} ${op} fan-out obeys concrete command limit ${limit}`, async (t) => {
        const entries = { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c" };
        const { engine, env, rows, content } = await fixture(t, entries);
        const target = urlPath("workspace", "/*.txt");
        const statement = op === "READ" ? readStmt(target) : op === "EDIT" ? editStmt(target, "changed", fullReplace) : killStmt(target);
        await engine.executeAdmittedTurn({ ...env, origin: "client", source: null, emission: null, fromSequence: 1, maxCommands: limit,
            statements: [statement, noteStmt("after targets"), dispositionStmt("WAIT")] });
        const receipts = await rows();
        assert.deepEqual(receipts.filter(({ op: actual }) => actual === op).map(({ pathname }) => pathname), Object.keys(entries).slice(0, limit));
        for (const [index, [path, original]] of Object.entries(entries).entries()) {
            assert.equal(await content(path), index >= limit || op === "READ" ? original : op === "EDIT" ? "changed" : undefined);
        }
        assert.equal(receipts.some((receipt) => receipt.op === "NOTE"), limit === Infinity);
        assert.ok(receipts.some((receipt) => receipt.op === "WAIT"), "WAIT remains exempt");
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
    await db.test_set_workspace_settings.run({ id: env.workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "EDIT" }] } }) });
    const result = await dispatch(editStmt(urlPath("workspace", "/*.txt"), "updated", fullReplace));
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.match(result.problem!.type, /\/capability-denied$/);
    assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/*.txt", 403]]);
    assert.equal(await content("/a.txt"), "original");
    assert.equal(await content("/b.txt"), "original");
});

for (const op of ["COPY", "MOVE"] as const) {
    test(`{§op-methods-op-dispatch} ${op} resolves both channel operands and preserves exact creation`, async (t) => {
        const { db, dispatch, content, ids } = await fixture(t, { "/source.txt": "body", "/destination.txt": "body" }, "channels");
        for (const [path, id] of ids) await db.test_seed_channel.run({ entry_id: id, name: "notes", content: path === "/source.txt" ? "selected" : "destination", mimetype: "text/plain", state: "static" });
        const transfer = op === "COPY" ? copyStmt : moveStmt;
        const result = await dispatch(transfer(urlPath("channels", "/source*.txt", "notes"), urlPath("channels", "/destination*.txt", "notes"), fullReplace, fullReplace));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(await content("/source.txt"), "body");
        assert.equal(await content("/destination.txt"), "body");
        assert.equal(await content("/source.txt", "notes"), op === "COPY" ? "selected" : undefined, "whole-channel MOVE removes only the selected source channel");
        assert.equal(await content("/destination.txt", "notes"), "selected");
        const created = await dispatch(transfer(urlPath("channels", "/destination*.txt", "notes"), urlPath("workspace", "/new.txt")));
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.equal((await dispatch(readStmt(urlPath("workspace", "/new.txt")))).content, "selected");
    });
    test(`{§op-methods-op-dispatch} ${op} rejects ambiguity beyond the preview page`, async (t) => {
        previewLines(t, 1);
        const entries = { "/source.txt": "original", "/destination1.txt": "one", "/destination2.txt": "two" };
        const { dispatch, content } = await fixture(t, entries);
        const result = await dispatch((op === "COPY" ? copyStmt : moveStmt)(urlPath("workspace", "/source*.txt"), urlPath("workspace", "/destination*.txt")));
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
    assert.equal(receipts.some((receipt) => receipt.op === "NOTE"), false);
    const problem = receipts.map(({ rx }) => JSON.parse(rx).problem).find((candidate) => candidate?.type.endsWith("/max-commands-exceeded"));
    assert.equal(problem?.omittedOperations, 1);
});
});

describe("same-turn-visibility", () => {
// {§op-methods-op-dispatch} {§op-methods-op-dispatch}






test("{§turn-record}: log KILL selects the pre-program snapshot, not rows emitted earlier by its own program", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        { assistant: { content: "````FIND (workspace:///*)````\n````KILL (log:///1/2/*)````\n````NOTE\nContinue after curating the observed pre-program row.\n````", reasoning: null } },
        { assistant: { content: "````SEND [200]\ndone\n````", reasoning: null } },
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
            const firstModelTurnId = rows.find(({ origin, op }) => origin === "model" && op === "FIND")?.turn_id;
            assert.ok(firstModelTurnId !== undefined);
            const firstModelTurn = rows.filter(({ turn_id }) => turn_id === firstModelTurnId);
            const prompt = firstModelTurn.find(({ op, origin }) => op === "SEND" && origin === "_plurnk");
            assert.equal(prompt?.active, 0, "the pre-program arrival row was in the selected snapshot");
            for (const op of ["FIND", "KILL", "NOTE"] as const) {
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
        makeMockResponse("\n````EDIT (workspace:///abs/module-loader-spec.md)\nthe spec body\n````\n\n````FIND (workspace:///abs/**)````\n````NOTE\nwrote and listed\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "probe360" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: loopId });
            const modelFind = (rows ?? []).filter((r) => r.op === "FIND" && r.origin === "model");
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
        makeMockResponse("\n````EDIT (workspace:///mode.md)\none\ntwo\nthree\nfour\n````\n\n````NOTE\nfixture created\n````", 10),
        makeMockResponse("\n````READ (workspace:///mode.md)````\n````EDIT (workspace:///mode.md) <4>\nFOUR\n````\n\n````EDIT (workspace:///mode.md) <2>\nTWO\n2.5\n````\n\n````NOTE\nmutated and observed\n````", 10),
        makeMockResponse("\n````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-batch" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const reads = rows.filter((row) => row.op === "READ" && row.origin === "model");
            assert.equal(reads.length, 1);
            const receipt = JSON.parse(reads[0].rx) as { content?: string };
            assert.equal(receipt.content, "one\ntwo\nthree\nfour");
            const edits = rows
                .filter((row) => row.op === "EDIT" && row.origin === "model")
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
        makeMockResponse("````EDIT (workspace:///atomic.md)\none\ntwo\nthree\n````\n\n````NOTE\nfixture\n````", 10),
        makeMockResponse("````EDIT (workspace:///atomic.md) <1,2>\nchanged\n````\n\n````EDIT (workspace:///atomic.md) <2,3>\nalso changed\n````\n\n````READ (workspace:///atomic.md)````\n````NOTE\nchecked\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-atomic-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const failedEdits = rows.filter((row) => row.op === "EDIT" && row.origin === "model"
                && (JSON.parse(row.rx) as { status?: number }).status === 200);
            assert.equal(failedEdits.length, 2);
            const read = rows.find((row) => row.op === "READ" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "changed\nalso changed");
        } finally { ws.close(); }
    });
});

test("{§edit}: a two-anchor whole-line range survives the composed EDIT path", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const content = "alpha\nbeta\ngamma\ndelta";
    const [alpha, beta] = LineAnchors.tokens("workspace:///anchored-range.md", content);
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("\n````EDIT (workspace:///anchored-range.md)\nalpha\nbeta\ngamma\ndelta\n````\n\n````NOTE\ncreated\n````", 10),
        makeMockResponse(`
\`\`\`\`EDIT (workspace:///anchored-range.md) <${alpha},${beta}>\`\`\`\`
\`\`\`\`READ (workspace:///anchored-range.md)\`\`\`\`
\`\`\`\`NOTE
verify
\`\`\`\``, 10),
        makeMockResponse("\n````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "anchored-range" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const read = rows.findLast((row) => row.op === "READ" && row.origin === "model");
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
        makeMockResponse(`
\`\`\`\`EDIT (workspace:///anchor-batch.md)
${content}
\`\`\`\`

\`\`\`\`NOTE
created
\`\`\`\``, 10),
        makeMockResponse(`
\`\`\`\`EDIT (workspace:///anchor-batch.md) <${one},${two}>\`\`\`\`
\`\`\`\`EDIT (workspace:///anchor-batch.md) <${three},${four},${five},${six},${seven},${eight}>
replacement
\`\`\`\`

\`\`\`\`READ (workspace:///anchor-batch.md)\`\`\`\`
\`\`\`\`NOTE
verify
\`\`\`\``, 10),
        makeMockResponse("\n````SEND [200]\ndone\n````", 10),
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
                .filter((row) => row.op === "EDIT" && row.origin === "model")
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

            const read = rows.findLast((row) => row.op === "READ" && row.origin === "model");
            assert.equal(
                (JSON.parse(read?.rx ?? "{}") as { content?: string }).content,
                "three\nfour\nfive\nsix\nseven\neight",
                "the invalid operation does not reverse an earlier successful EDIT",
            );
        } finally { ws.close(); }
    });
});
});
