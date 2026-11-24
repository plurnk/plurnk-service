import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import Turn from "../../src/core/Turn.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import ClientInteractions, { type ClientInteractionPendingEvent } from "../../src/core/ClientInteractions.ts";
import MessageResources from "../../src/core/MessageResources.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { serverProposals, ownSession, TEST_OWNER } from "./_approval.ts";
import { TurnDisposition, Validator, type EntryReadResult, type ParsedPath, type SendStatement } from "@plurnk/plurnk-contracts";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import { openMigrated, seedEnvelope, insertWorkspace, insertSession, insertLoop } from "./_db.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { makeMockResponse, mcpMockTurn, mcpToolCalls, parseDsl } from "./_mock.ts";
import { MessageScheme, type SchemeHandler, type SchemeManifest } from "@plurnk/plurnk-schemes";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { contentWeight } from "../../src/core/content-weight.ts";
import { killStmt } from "./_dsl.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";


describe("operation-order", () => {
const target = "workspace:///ordered.md";
const content = "one\ntwo\nthree\nfour\nfive\nsix";
const anchors = LineAnchors.tokens(target, content);
const cases = [
    {
        name: "READs observe the state at their authored position, not a future EDIT",
        ops: [`await plurnk.read({"path":"${target}","range":"1,-1"});`, `await plurnk.edit({"path":"${target}","range":"2","content":"TWO\\nextra"});`, `await plurnk.read({"path":"${target}","range":"1,-1"});`, `await plurnk.edit({"path":"${target}","range":"4","content":"THREE"});`, `await plurnk.read({"path":"${target}","range":"1,-1"});`],
        order: ["read", "edit", "read", "edit", "read"],
        reads: [content, "one\nTWO\nextra\nthree\nfour\nfive\nsix", "one\nTWO\nextra\nTHREE\nfour\nfive\nsix"],
        statuses: [200, 200],
    },
    {
        name: "an EDIT can create a resource and a later EDIT can change it in the same turn",
        ops: ["await plurnk.edit({\"path\":\"workspace:///new.md\",\"content\":\"alpha\\nbeta\"});", "await plurnk.edit({\"path\":\"workspace:///new.md\",\"range\":\"2\",\"content\":\"BETA\"});", "await plurnk.read({\"path\":\"workspace:///new.md\",\"range\":\"1,-1\"});"],
        order: ["edit", "edit", "read"],
        reads: ["alpha\nBETA"],
        statuses: [201, 200],
    },
    {
        name: "an invalid EDIT does not roll back an earlier effect or suppress a later one",
        ops: [`await plurnk.edit({"path":"${target}","range":"1","content":"ONE"});`, `await plurnk.edit({"path":"${target}","range":"99","content":"invalid"});`, `await plurnk.edit({"path":"${target}","range":"2","content":"TWO"});`, `await plurnk.read({"path":"${target}","range":"1,-1"});`],
        order: ["edit", "edit", "edit", "read"],
        reads: ["ONE\nTWO\nthree\nfour\nfive\nsix"],
        statuses: [200, 416, 200],
    },
    {
        name: "a surviving hash follows its target through an adjacent numeric insertion",
        ops: [`await plurnk.edit({"path":"${target}","range":"0","content":"prefix"});`, `await plurnk.read({"path":"${target}","range":"1,-1"});`, `await plurnk.edit({"path":"${target}","range":"${anchors[1]}","content":"TWO"});`, `await plurnk.read({"path":"${target}","range":"1,-1"});`],
        order: ["edit", "read", "edit", "read"],
        reads: [`prefix\n${content}`, "prefix\none\nTWO\nthree\nfour\nfive\nsix"],
        statuses: [200, 200],
    },
    {
        name: "an overwritten hash target is not rebound to replacement content",
        ops: [`await plurnk.edit({"path":"${target}","range":"${anchors[1]}","content":"replacement"});`, `await plurnk.edit({"path":"${target}","range":"${anchors[1]}","content":"wrong"});`, `await plurnk.read({"path":"${target}","range":"1,-1"});`],
        order: ["edit", "edit", "read"],
        reads: ["one\nreplacement\nthree\nfour\nfive\nsix"],
        statuses: [200, 409],
    },
    {
        name: "an untouched hash range survives a preceding scoped entry KILL",
        ops: [`await plurnk.kill({"path":"${target}","range":"1"});`, `await plurnk.edit({"path":"${target}","range":"${anchors[2]},${anchors[3]}","content":"THREE\\nFOUR"});`, `await plurnk.read({"path":"${target}","range":"1,-1"});`],
        order: ["kill", "edit", "read"],
        reads: ["two\nTHREE\nFOUR\nfive\nsix"],
        statuses: [200],
    },
];

for (const fixture of cases) test(`{§op-methods-op-dispatch}: ${fixture.name}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse(`await plurnk.edit(${JSON.stringify({ path: target, content })});

await plurnk.note({"text":"created"});`, 10),
        makeMockResponse(`${fixture.ops.join("\n")}

await plurnk.note({"text":"verify"});`, 10),
        makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ordered" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "run" });
            assert.equal(result.finalStatus, 200);
            const rows = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string; tx: string }>({ loop_id: result.loopId }))
                .filter(({ origin, op }) => origin === "model" && op !== "send" && op !== "done" && op !== "fail" && op !== "note"
                    && !TurnDisposition.isOp(op)).slice(1);
            assert.deepEqual(rows.map(({ op }) => op), fixture.order);
            assert.deepEqual(rows.filter(({ op }) => op === "read").map(({ rx }) => JSON.parse(rx).content), fixture.reads);
            assert.deepEqual(rows.filter(({ op }) => op === "edit").map(({ rx }) => JSON.parse(rx).status), fixture.statuses);
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
            const source = [
                `await plurnk.edit(${JSON.stringify({ path: target, content })});`,
                `await plurnk.read({"path":"${target}","range":"1,-1"});`,
                `await plurnk.edit({"path":"${target}","range":"99","content":"invalid"});`,
                `await plurnk.edit({"path":"${target}","range":"2","content":"TWO"});`,
                ...(hasNote ? ['await plurnk.note({"text":"note"});'] : []),
            ].join("\n\n");
            const execution = engine.executeAdmittedTurn({
                ...env, origin, source, emission: null, statements: TurnOps.parseInternal(source),
                fromSequence: 1, failOnOperationError,
            });
            if (failOnOperationError) await assert.rejects(execution, OperationFailureError);
            else assert.equal((await execution).status, 200, "the administrative program finished without ending a model loop");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: env.turnId });
            assert.deepEqual(rows.filter(({ op }) => op !== null).map(({ op }) => op),
                failOnOperationError ? ["edit", "read", "edit"] : ["edit", "read", "edit", "edit", ...(hasNote ? ["note"] : [])]);
            assert.equal(JSON.parse(rows.find(({ op }) => op === "read")!.rx).content, content);
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
        reasoned("await plurnk.note({\"text\":\"One.\\nTwo.\\nThree.\"});", thought),
        makeMockResponse("await plurnk.done({\"text\":\"The answer.\"});"),
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
        const note = rows.find(({ op }) => op === "note");
        // {§message-arrival} The arrival's receipt names the message by its short address.
        const short = rows.flatMap(({ origin, rx }) => origin === "_plurnk" && typeof (rx as { resource?: unknown } | null)?.resource === "string"
            ? [(rx as { resource: string }).resource] : []).find((resource) => resource.startsWith("message://"));
        assert.ok(note !== undefined && short !== undefined, "the turn noted, and its arrival names its message");
        const coordinate = `${note.loopSeq}/${note.turnSeq}/${note.sequence}`;
        // {§log-kill-scope} A deliberate scoped KILL trims the row's second line from every later reader.
        const trimmed = await modelOperation(daemon, db, { workspaceId, sessionId, statement: killStmt(parsePath(`log:///${coordinate}/note`), { marks: [2] }) });
        assert.equal(trimmed.status, 200);
        const read = async (target: string, slice: { channel?: string; offset?: number } = {}): Promise<EntryReadResult> =>
            Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, sessionId, target, ...slice }));

        // A log row is computed: no stored entry, the canonical coordinate, its unnamed default channel, trimmed.
        const kept = "One.\nThree.";
        assert.deepEqual(await read(`log:///${coordinate}/note`), { status: 200, entry: {
            entryId: null, target: `log:///${coordinate}/note`,
            channels: { "": { content: kept, contentOffset: 0, contentLength: kept.length, mimetype: "text/plain", weight: contentWeight(kept), state: "static" } },
        } });
        assert.deepEqual((await read(`log:///${coordinate}/note`, { channel: "", offset: 5 })).entry?.channels[""],
            { content: "Three.", contentOffset: 5, contentLength: kept.length, mimetype: "text/plain", weight: contentWeight(kept), state: "static" },
            "a computed channel slices by code points, as a stored one does");
        const unknownChannel = await read(`log:///${coordinate}/note`, { channel: "patch" });
        assert.deepEqual([unknownChannel.status, typeOf(unknownChannel)], [404, "channel-not-found"]);

        // A turn's sources are computed by the session they name; its reasoning is the text its first operation row projects.
        assert.equal(note.reasoning, thought);
        const reasoning = await read(`reasoning://main/${note.loopSeq}/${note.turnSeq}`);
        assert.equal(reasoning.entry?.entryId, null);
        assert.deepEqual(reasoning.entry?.channels.body && [reasoning.entry.channels.body.content, reasoning.entry.channels.body.mimetype], [thought, "text/plain"]);
        const answer = rows.find(({ origin, turnSeq }) => origin === "model" && turnSeq !== note.turnSeq);
        assert.equal((await read(`reasoning://main/${note.loopSeq}/${answer?.turnSeq}`)).entry?.channels.body?.content, "", "a turn that reasoned none reads empty");
        const program = await read(`ops://main/${note.loopSeq}/${note.turnSeq}`);
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
            [`log:///${coordinate}/note`, "", kept],
            [`reasoning://main/${note.loopSeq}/${note.turnSeq}`, "body", thought],
            [`${minted}#body`, "body", "Think, then answer."],
        ] as const) {
            const one = await selected(target);
            assert.deepEqual([Object.keys(one.entry?.channels ?? {}), one.entry?.channels[channel]?.content], [[channel], content], target);
        }
        const absent = await selected(`log:///${coordinate}/note#patch`);
        assert.deepEqual([absent.status, typeOf(absent)], [404, "channel-not-found"]);

        // Another workspace reads none of this session's addresses.
        const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "entry-acquisition-elsewhere" });
        await assert.rejects(daemon.readEntry({ workspaceId: elsewhere, sessionId, target: `reasoning://main/${note.loopSeq}/${note.turnSeq}` }),
            (error: unknown) => (error as { result?: { status?: number } }).result?.status === 409);

        // The scheme's own refusals stand.
        for (const [target, status, code] of [
            ["log:///x", 400, "coordinate-malformed"],
            [`log:///9/9/9/note`, 404, "entry-not-found"],
            [`reasoning://main/${note.loopSeq}/99`, 404, "entry-not-found"],
        ] as const) {
            const refused = await read(target);
            assert.deepEqual([refused.status, typeOf(refused), refused.entry], [status, code, null], target);
        }
    }, readers === undefined ? {} : { readers });
});
});


describe("Message.attachments", () => {
const turn = (content: string) => mcpMockTurn(content);
const next = "await plurnk.note({\"text\":\"Deliver selected resources.\"});";
const done = "await plurnk.done({\"text\":\"Attachment handling verified.\"});";

test("{§op-methods-op-dispatch}: session SEND snapshots only selected resources and a failed source sends nothing", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [
        turn(`await plurnk.edit({"path":"workspace:///selected.md","content":"original"});

await plurnk.edit({"path":"workspace:///private.md","content":"unselected"});

${next}`),
        turn(`await plurnk.send({"target":"session://receiver","attachments":["workspace:///selected.md","workspace:///missing.md"],"text":"Do not deliver a partial message."});

${next}`),
        turn("await plurnk.send({\"target\":\"session://receiver\",\"attachments\":[\"workspace:///selected.md\"],\"text\":\"Review this.\"});\n\nawait plurnk.edit({\"path\":\"workspace:///selected.md\",\"range\":\"1,-1\",\"content\":\"changed\"});\n\nawait plurnk.wait({});"),
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
        const failed = rows.filter((row) => row.op === "send" && row.statusRx === 404);
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
            const serialized = JSON.stringify(response.assistant.toolCalls ?? []);
            if (!serialized.includes("$RESOURCE")) return response;
            const packet = args[0].messages.map(chatMessageText).join("\n");
            const path = /<(session:\/\/receiver\/attachments\/[^>]+)>/u.exec(packet)?.[1];
            assert.ok(path, "the peer gets an ordinary attachment link");
            return {
                ...response,
                assistant: {
                    ...response.assistant,
                    toolCalls: JSON.parse(serialized.replaceAll("$RESOURCE", path)) as NonNullable<typeof response.assistant.toolCalls>,
                },
            };
        }
    }
    const provider = new Reader({ contextWindow: 100_000, responses: [turn(`await plurnk.read({"path":"$RESOURCE","range":"1,-1"});

${next}`), turn(done)] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "session-attachments", projectRoot: null });
        const receiver = await daemon.createSession({ workspaceId, name: "receiver" });
        const program = PlurnkParser.parseStatements([
            "await plurnk.edit({\"path\":\"workspace:///report.md\",\"content\":\"original peer report\"});",
            "await plurnk.send({\"target\":\"session://receiver\",\"attachments\":[\"workspace:///report.md\"],\"text\":\"Do not deliver invalid input.\"});",
            `await plurnk.send({"target":"session://receiver","attachments":["workspace:///report.md"],"text":${JSON.stringify(body)}});`,
            "await plurnk.edit({\"path\":\"workspace:///report.md\",\"range\":\"1,-1\",\"content\":\"changed\"});",
        ].join("\n\n"));
        assert.ok(program.items.every((item) => item.kind === "statement"));
        const statements = program.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        statements[1] = { ...(statements[1] as SendStatement), attachments: ["   "] };
        // A person's operation sends to the session ({§connection-lifecycle}).
        const results = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements });
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
const response = (content: string) => mcpMockTurn(content);

// {§op-shapes} {§emission-admission}
test("{§op-shapes} a KILL after SEND executes: curation and the reply persist before a later conclusion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "disposition-order");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Deliver the answer and curate the note.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const seed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("await plurnk.edit({\"path\":\"workspace:///note.md\",\"content\":\"Evidence.\"});\n\nawait plurnk.note({\"text\":\"Review.\"});")] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        const originalRows = await db.test_log_entries_by_turn.all<{ id: number; sequence: number; op: string; active: number }>({ turn_id: seed.turnId });
        const plan = originalRows.find(({ op }) => op === "note");
        assert.ok(plan);
        const turn = await db.test_latest_model_turn_in_loop.get<{ sequence: number }>({ loop_id: loopId });
        assert.ok(turn);
        const source = `await plurnk.send({"text":"Answer."});

await plurnk.kill({"path":"log:///1/${turn.sequence}/${plan.sequence}/note"});`;
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "a progress reply leaves the message unresolved");
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["send", 200], ["kill", 200]]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; tx: string; attrs: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter((row) => row.op !== null && row.op !== "prompt" && !LogEntryProjection.isEmission(row)).map(({ op }) => op), ["send", "kill"]);
        const send = rows.find(({ op }) => op === "send");
        assert.ok(send);
        assert.equal(JSON.parse(send.tx).body.raw, "Answer.");
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, PlurnkParser.stringify(parseDsl(source)));
        const curated = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({ turn_id: seed.turnId });
        assert.equal(curated.find(({ id }) => id === plan.id)?.active, 0, "the KILL authored after SEND curated the earlier note");
        assert.equal((await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [response("await plurnk.done({});")] }),
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
        const source = "await plurnk.send({\"text\":\"Inspect results.\"});\n\nawait plurnk.edit({\"path\":\"workspace:///note.md\",\"content\":\"Created before READ.\"});\n\nawait plurnk.read({\"path\":\"workspace:///note.md\"});\n\nawait plurnk.find({\"path\":\"workspace:///*\",\"pattern\":\"/[/\"});";
        const result = await engine.runTurn({ provider: new Mock({ contextWindow: 100_000, responses: [response(source)] }), workspaceId, sessionId, loopId, messages: [] });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["send", 200], ["edit", 201], ["read", 200], ["find", 400]],
            "the reply, mutations, retrieval, and the refused matcher ({§matcher-prefix-claims}) retain authored order");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; attrs: string }>({ turn_id: result.turnId });
        const read = rows.find((row) => row.op === "read" && !LogEntryProjection.isEmission(row));
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
            provider: new Mock({ contextWindow: 100_000, responses: [{
                assistant: {
                    content: "",
                    reasoning: null,
                    finishReason: "tool_calls",
                    toolCalls: [
                        ...mcpToolCalls("await plurnk.edit({\"path\":\"workspace:///before-loss.md\",\"content\":\"Kept.\"});\n\nawait plurnk.wait({\"text\":\"Continue.\"});"),
                        { id: "mock_call_2", name: "mcp", arguments: "{\"server\":\"plurnk\",\"tool\":\"read\",\"arguments\":{\"path\":\"unfinished" },
                    ],
                },
            }] }), workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "the failed row keeps the loop going; nothing was resampled");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors).map(({ line, column, source }: { line: number; column: number; source: string }) => ({ line, column, source }))]), [[1, [{
            line: 3, column: 0, source: "parser",
        }]]], "the one attempt is admitted and carries the malformed call as its diagnostic");
        const [{ message }] = JSON.parse(attempts[0].parse_errors) as [{ message: string }];
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.some(({ op }) => op === "edit"), true, "the statement that closed before the loss ran");
        const loss = rows.find(({ op }) => op === "error");
        assert.ok(loss, "the loss is a failed row of the same turn");
        const problem = JSON.parse(loss.rx).problem;
        assert.equal(problem.detail, message, "the loss row carries the attempt's tail diagnostic");
        assert.equal(problem.siblingsRetained, true);
    } finally { await db.close(); }
});

test("{§op-shapes} internal turn programs admit a disposition anywhere like model turns", () => {
    const source = "plurnk.kill({\"path\":\"log:///1/1/*\"})\n\nplurnk.wait({}) // Continue.";
    const statements = TurnOps.parseInternal(source);
    assert.deepEqual(statements.map(({ op }) => op), ["kill", "wait"]);
    assert.equal(TurnOps.renderInternal(statements), source);
    // {§op-shapes} — a program that authors an operation after its disposition is valid turnOps.
    const first = TurnOps.parseInternal("await plurnk.wait({}); // Continue.\n\nawait plurnk.kill({\"path\":\"log:///1/1/*\"});");
    assert.deepEqual(first.map(({ op }) => op), ["wait", "kill"]);
});
});

