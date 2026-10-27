import test, { describe, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import Turn from "../../src/core/Turn.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import ClientInteractions, { type ClientInteractionPendingEvent } from "../../src/core/ClientInteractions.ts";
import MessageResources from "../../src/core/MessageResources.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { serverProposals, ownSession, TEST_OWNER } from "./_approval.ts";
import { TurnDisposition, Validator, type EntryReadResult, type ParsedPath, type CapabilityPolicy, type ProposalPolicy } from "@plurnk/plurnk-contracts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { openMigrated, seedEnvelope, insertWorkspace, insertSession, insertLoop, insertOperationTurn } from "./_db.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { MessageScheme, type SchemeHandler, type SchemeManifest, type RepresentationPreparationRequest, type SchemeCtx } from "@plurnk/plurnk-schemes";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { contentWeight } from "../../src/core/content-weight.ts";
import { killStmt, urlPath, localPath, editStmt, readStmt, copyStmt, moveStmt, execStmt, sendStmt, noteStmt } from "./_dsl.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import { type Effect, type Executor } from "@plurnk/plurnk-execs";
import { schemeManifest } from "./_scheme.ts";


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

test("{§op-methods-op-dispatch} {§operation-results}: competing interaction answers admit exactly one envelope before wake", async (t) => {
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

test("{§methods} {§proposal-projection}: a pending request is durable, projected, resolved once, then removed", async (t) => {
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

test("{§proposal-projection}: owner cancellation removes the durable request and rejects its waiter", async (t) => {
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

test("{§proposal-projection}: invalid response content leaves the same interaction answerable", async () => {
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

test("{§methods} {§proposal-projection}: a retired interrupt identity never addresses a subsequent input request", async () => {
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

test("{§proposal-projection}: insertion requires one exact workspace/session/loop/turn ownership chain", async (t) => {
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

test("{§proposal-projection}: boot recovery removes a request whose process-local owner vanished", async (t) => {
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
        // {§message-arrival} The arrival's receipt names the message by its short address.
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

        // {§methods} The channel an address selects, complete: its fragment's, else its scheme's default.
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

test("{§manifest} runtime scheme traits participate in the same selector space", async () => {
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

// {§op-shapes} {§emission-admission}
test("{§op-shapes} a KILL after SEND executes: curation and the reply persist before a later conclusion", async () => {
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

test("{§matcher-prefix-claims} SEND authored first: later operations run in authored order and completion waits for their results", async () => {
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
            "the reply, mutations, retrieval, and the refused matcher ({§matcher-prefix-claims}) retain authored order");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; attrs: string }>({ turn_id: result.turnId });
        const read = rows.find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
        assert.ok(read);
        assert.equal(JSON.parse(read.rx).content, "Created before READ.", "the actual READ observed the EDIT that preceded it");
    } finally { await db.close(); }
});

test("{§parse-recovery} a lost boundary refuses only what follows it: the statements before it run, the loss is a row", async () => {
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

test("{§op-shapes} internal turn programs admit a disposition anywhere like model turns", () => {
    const source = "```KILL (log:///1/1/*)\n```\n\n```WAIT\nContinue.\n```";
    const statements = TurnOps.parseInternal(source);
    assert.deepEqual(statements.map(({ op }) => op), ["KILL", "WAIT"]);
    assert.equal(TurnOps.renderInternal(statements), source);
    // {§op-shapes} — a program that authors an operation after its disposition is valid turnOps.
    const first = TurnOps.parseInternal("```WAIT\nContinue.\n```\n```KILL (log:///1/1/*)```");
    assert.deepEqual(first.map(({ op }) => op), ["WAIT", "KILL"]);
});
});

