import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import NoticeChannel from "../../src/core/NoticeChannel.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import Daemon from "../../src/server/Daemon.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import ProblemLog from "../../src/core/ProblemLog.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import GitMembership from "../../src/core/git-membership.ts";
import ResourceState from "./resource-state.ts";
import { completeStmt, sendStmt, dispositionStmt, noteStmt, editStmt, readStmt, urlPath, findStmt } from "./_dsl.ts";
import { TurnDisposition, type EditStatement, type LineMarker, type PlurnkStatement, type ReadStatement, isExecution, Validator } from "@plurnk/plurnk-contracts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { type ReasoningEventNotify, type ReasoningEventPayload } from "../../src/core/ReasoningEvent.ts";
import { type StoredPacketSection } from "../../src/core/StoredPacket.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { Mock, validateProviderRequestAccounting, type MockResponse, ProviderError, chatMessageText } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel, rootWorkspace } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { ownSession, TEST_OWNER } from "./_approval.ts";
import { testProviderCapacity, viableWindow } from "./_provider.ts";
import { rm, readFile, mkdtemp, writeFile } from "node:fs/promises";
import { liveWorkspace, seedEntry } from "../_live-harness.ts";
import { namedModelSession } from "./_sessions.ts";
import { Lexer } from "marked";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { testExecutors } from "./_execs.ts";
import { fixtureExecutors } from "./_mock.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";

describe("Engine.run-turn", () => {
// {§edit}: a fixed full-replace marker makes a
// repeated EDIT of the same path stays a legal, IDENTICAL-fingerprint 200 across
// turns (the cycle-detection tests below depend on that repeatability), never a
// refusal once the first turn has created the path.
const fullReplace: LineMarker = { marks: [1, -1] };

const wsEditStmt = (pathname: string, body: string, marker: LineMarker | null = fullReplace): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: urlPath("workspace", pathname),
    lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 },
});

// A response with content but NO pre-parsed ops, so the engine runs the parser.
const contentResp = (content: string, completion: number = 0): MockResponse => ({
    assistant: {
        content,
        reasoning: null,
    },
    usage: { inputTokens: 0, outputTokens: completion, totalTokens: completion },
});

const response = (ops: PlurnkStatement[], content: string = "", completion: number = 0): MockResponse => ({
    assistant: {
        content, ops, reasoning: null,
    },
    usage: { inputTokens: 0, outputTokens: completion, totalTokens: completion },
});

// The deterministic HARD-failure (403 writableBy) generator for the strike/notice tests:
// a scheme the model can't write. Log does not serve this role — {§log-history-projection}
// admits the model through its gate for the KILL curation lever (other ops 501, a SOFT failure).
class Sealed {
    static manifest = {
        name: "sealed", channels: {}, defaultChannel: "", category: "data",
        writableBy: ["_plurnk"], volatile: false, modelVisible: true,
    };
}

const setup = async (reasoningEventNotify?: ReasoningEventNotify) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "subject");
    const loopId = await insertLoop(db, sessionId, 1, "test prompt");
    const schemes = new SchemeRegistry();
    schemes.register("sealed", new Sealed());
    const engine = new Engine({ db, schemes, reasoningEventNotify });
    return { db, engine, workspaceId, sessionId, loopId };
};

test("{§loop-completion} Engine.runTurn: EDIT + SEND turn writes entry, log rows, turn row with status from SEND", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            // {§loop-completion} — an EDIT's receipt lands next packet, so the turn continues.
            responses: [response([wsEditStmt("/x", "y"), noteStmt("continuing")], "content", 42)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [
                { role: "system", content: "You are an agent." },
                { role: "user", content: "Do the thing." },
            ],
        });
        assert.equal(result.status, 102, "turn status from the SEND");
        assert.deepEqual(result.outcomes, [
            { op: "EDIT", status: 201, problemType: null },
            { op: "NOTE", status: 200, problemType: null },
        ], "EDIT creates content; NOTE retains memory; the turn continues implicitly");

        const turn = await db.test_get_turn.get<{ loop_id: number; sequence: number; status: number }>({ id: result.turnId });
        if (turn === undefined) throw new Error("turn not found");
        assert.equal(turn.loop_id, loopId);
        assert.equal(turn.sequence, 2, "the packetless initialization owns durable turn 1");
        assert.equal(turn.status, 102);
        assert.equal((await engine.loopUsage(loopId)).accounting.usage?.outputTokens, 42);

        // Three log entries: one inbound SEND and two model ops
        // (EDIT, SEND). Mock's pre-parsed seam supplied no Plurnk source, so
        // the producer-neutral batch must not fabricate a turnOps artifact.
        // The initialization operations belong to their preceding packetless turn.
        const logCount = (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: result.turnId }))?.n;
        assert.equal(logCount, 3);

        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "a continuing SEND leaves the loop live");
    } finally { await db.close(); }
});

test("{§turn-record}: initialization and inference preserve turnOps beside ordinary operation outcomes", async () => {
    // The surveys are the initialization program; with the preview off there is none, so this witness turns it on.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const { db, engine, workspaceId, sessionId, loopId } = await setup();
        try {
            // A workspace entry, so the workspace survey selects something and the initialization program exists.
            await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
            const source = "````SEND [200]\ndone\n````";
            const provider = new Mock({
                contextWindow: 100000,
                responses: [contentResp(source)],
            });
            const result = await engine.runTurn({
                provider, workspaceId, sessionId, loopId,
                messages: [{ role: "user", content: "Conclude." }],
            });
            assert.equal(result.status, 200);

            const turns = await db.test_list_turns_in_loop.all<{
                id: number;
                producer: string;
                kind: string;
            }>({ loop_id: loopId });
            assert.deepEqual(
                turns.map(({ producer, kind }) => ({ producer, kind })),
                [
                    { producer: "_plurnk", kind: "initialization" },
                    { producer: "model", kind: "inference" },
                ],
            );

            const rowsFor = (turnId: number) => db.test_log_entries_by_turn.all<{
                op: string | null;
                origin: string;
                attrs: string;
                rx: string;
                initial_folded: string;
                folded: string;
            }>({ turn_id: turnId });
            const initializationRows = await rowsFor(turns[0].id);
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string; producer: string }>({ session_id: sessionId });
            const initializationSource = sources.find((row) => row.turn_id === turns[0].id && row.kind === "ops");
            assert.equal(initializationSource?.producer, "_plurnk");
            assert.match(initializationSource.content, /^```/m);
            assert.doesNotMatch(initializationSource.content, /^(`{4,})\w[^\n]*\1$/m, "initialization never teaches inline operation fences");
            assert.match(initializationSource.content, /^```FIND [^\n]*\n```$/m, "the initialization program renders each operation with a separate closing line");
            assert.ok(!initializationRows.some(({ op }) => op === null));
            assert.ok(initializationRows.some(({ op }) => op === "FIND"), "source retention does not replace executed results");
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
            assert.deepEqual(logEntries(packet).filter(({ logPath }) => logPath.endsWith("/emission")), [],
                "`_plurnk` initialization never fabricates a content announcement ({§turn-source-resources}); its READ of its own program is an ordinary row");

            const inferenceRows = await rowsFor(turns[1].id);
            const inferenceSource = sources.find((row) => row.turn_id === turns[1].id && row.kind === "ops");
            assert.equal(inferenceSource?.producer, "model");
            assert.equal(inferenceSource?.content, source, "the admitted source stays exact");
            assert.ok(!inferenceRows.some(({ op }) => op === null));
            assert.ok(inferenceRows.some(({ op }) => op === "SEND"));
        } finally { await db.close(); }
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});

test("{§edit} Engine.runTurn: exact request accounting preserves reasoning-inclusive pricing", async () => {
    const events: ReasoningEventPayload[] = [];
    const { db, engine, workspaceId, sessionId, loopId } = await setup((_workspaceId, event) => events.push(event));
    try {
        const usage = {
            inputTokens: 100,
            outputTokens: 250,
            totalTokens: 350,
            outputTokenDetails: { textTokens: 50, reasoningTokens: 200 },
        };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{
                assistant: { content: "", ops: [completeStmt("done")], reasoning: "deliberated at length" },
                usage,
                cost: {
                    kind: "estimated",
                    amount: { amount: "0.35", currency: "USD" },
                    source: "reasoning billing fixture",
                },
            }],
        });
        const result = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [
                { role: "system", content: "You are an agent." },
                { role: "user", content: "Think hard, then answer." },
            ],
        });
        assert.equal(result.status, 200);

        const accounting = (await engine.loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, "0.35");
        assert.deepEqual(accounting.usage, usage);
        assert.deepEqual(accounting.requests[0]?.cost, {
            kind: "estimated",
            amount: { amount: "0.35", currency: "USD" },
            source: "reasoning billing fixture",
        });
        assert.equal(events.length, 3);
        assert.deepEqual(events.map(({ phase }) => phase), ["start", "content", "end"]);
        assert.equal(events[1]?.phase === "content" ? events[1].delta : null, "deliberated at length");
        assert.ok(events.every((event) => event.sessionId === sessionId && event.loopId === loopId));
        assert.ok(events.every((event) => event.turnId === result.turnId));
        assert.ok(events.every((event) => event.modelCallId === events[0]?.modelCallId));
        assert.ok((events[0]?.modelCallId ?? 0) > 0);
    } finally { await db.close(); }
});

test("{§notifications}: retries produce distinct physical-request reasoning segments", async () => {
    const events: ReasoningEventPayload[] = [];
    const { db, engine, workspaceId, sessionId, loopId } = await setup((_workspaceId, event) => events.push(event));
    try {
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        const abandonedReasoning = PlurnkParser.frame("NOTE", "Abandoned retry note.");
        const acceptedReasoning = PlurnkParser.frame("NOTE", "Accepted retry note.");
        const failed = validateProviderRequestAccounting({
            provider: "provider:mock",
            model: provider.model,
            outcome: "error",
            cost: { kind: "unknown", reason: "stream ended after partial output" },
        });
        const succeeded = validateProviderRequestAccounting({
            provider: "provider:mock",
            model: provider.model,
            outcome: "response",
            usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
            cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "retry fixture" },
        });
        provider.generate = async (args) => {
            const capacity = await provider.assessRequestCapacity(args.messages, args.maxOutputTokens);
            const settleFailed = await args.observeRequest?.({ provider: failed.provider, model: failed.model });
            args.observeReasoning?.(abandonedReasoning);
            await settleFailed?.(failed);
            const settleSucceeded = await args.observeRequest?.({ provider: succeeded.provider, model: succeeded.model });
            args.observeReasoning?.(acceptedReasoning);
            await settleSucceeded?.(succeeded);
            return {
                assistant: {
                    content: "",
                    reasoning: acceptedReasoning,
                    finishReason: "stop",
                    model: provider.model,
                    ops: [completeStmt("done")],
                },
                assistantRaw: null,
                accounting: [failed, succeeded],
                capacity,
            };
        };

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "Recover cleanly." }],
        });

        assert.equal(result.status, 200);
        assert.deepEqual(events.map(({ phase }) => phase), ["start", "content", "end", "start", "content", "end"]);
        assert.deepEqual(events.map(({ requestSequence }) => requestSequence), [1, 1, 1, 2, 2, 2]);
        assert.deepEqual(
            events.flatMap((event) => event.phase === "content" ? [event.delta] : []),
            [abandonedReasoning, acceptedReasoning],
        );
        assert.ok(events.every(({ modelCallId }) => modelCallId === events[0]?.modelCallId));
        const turn = await db.test_turn_id_by_seq.get<{ id: number }>({ loop_id: loopId, sequence: events[0]?.turnSeq });
        const loop = await db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId });
        assert.ok(events.every((event) => event.turnId === turn?.id && event.loopSeq === loop?.sequence && event.turnSeq === events[0]?.turnSeq),
            "every event names its turn's ordinals in the session's log, the same across a retry");
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        const notes = sources.filter(({ kind }) => kind === "note");
        assert.equal(notes.filter(({ content }) => content === "Accepted retry note.").length, 1);
        assert.ok(notes.every(({ content }) => content !== "Abandoned retry note."), "streamed reasoning from failed requests remains evidence, not committed memory");
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: only accepted durable messages enter Open Messages", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "");  // empty input = no message arrival
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [response([noteStmt("ok")])] });
        const result = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [
                { role: "system", content: "system prompt body" },
                { role: "user", content: "first user msg" },
                { role: "user", content: "second user msg" },
            ],
        });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { assistant: unknown };
        const definition = packetSection(packet, "definition");
        assert.equal(definition, "system prompt body");
        assert.equal(packetSection(packet, "messages"), "[]", "provider-message scaffolding is not an accepted source");
        assert.ok(packet.assistant !== null);
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: admitted response does not change packet request-weight semantics", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([completeStmt("ok")], "a deliberately non-empty admitted response")],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(row !== undefined);
        const packet = JSON.parse(row.packet) as { weight: number; sections: StoredPacketSection[] };
        assert.equal(PacketWire.sectionContent(packet, "emission-history"), "", "the first request never contains its own forthcoming response");
        const requestWeight = PacketWire.packetToWireMessages(packet)
            .reduce((sum, { content }) => sum + contentWeight(content), 0);
        assert.equal(packet.weight, requestWeight, "all request text is charged once within its message");
    } finally { await db.close(); }
});

test("{§loop-completion} Engine.runTurn: multi-op turn - the arrival row precedes model ops", async () => {
    // The packetless initialization is durable turn 1. The first model turn is
    // turn 2 and starts its own operation sequence with the arrival row.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([
                wsEditStmt("/a", "1"), wsEditStmt("/b", "2"), wsEditStmt("/c", "3"),
                noteStmt("continuing"), // {§loop-completion} — edit receipts land next packet
            ])],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.deepEqual(result.outcomes, [
            { op: "EDIT", status: 201, problemType: null },
            { op: "EDIT", status: 201, problemType: null },
            { op: "EDIT", status: 201, problemType: null },
            { op: "NOTE", status: 200, problemType: null },
        ]);
        const indices = await db.test_log_entries_by_turn.all<{ sequence: number; op: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(
            indices.map((r) => ({ idx: r.sequence, op: r.op })),
            [
                { idx: 1, op: "SEND" },
                { idx: 2, op: "EDIT" },
                { idx: 3, op: "EDIT" },
                { idx: 4, op: "EDIT" },
                { idx: 5, op: "NOTE" },
            ],
        );
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: a trusted disposition-less program continues with only its authored operations", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([wsEditStmt("/x", "y")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes, [{ op: "EDIT", status: 201, problemType: null }]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op, origin }) => op !== null && !(op === "SEND" && origin === "_plurnk")).map(({ op }) => op), ["EDIT"]);
        const channel = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/x", name: "body" });
        assert.equal(channel?.content, "y");
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: an empty trusted batch fails without leaving a producer turn open", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100000, responses: [response([])] });
        await assert.rejects(engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] }), Error);
        const turns = await db.test_list_turns_in_loop.all<{
            producer: string; kind: string; status: number; completed_at: string | null;
        }>({ loop_id: loopId });
        assert.ok(turns.every(({ completed_at }) => completed_at !== null), "an internal failure leaves no producer-owned turn open");
        assert.deepEqual(
            turns.map(({ producer, kind, status }) => ({ producer, kind, status })),
            [
                { producer: "_plurnk", kind: "initialization", status: 200 },
                { producer: "model", kind: "inference", status: 500 },
            ],
        );
    } finally { await db.close(); }
});

// PLURNK_SERVICE_MAX_COMMANDS cap. The html-attrs demo surfaced a pathology where
// the model emitted 635 ops in a single assistant turn; without a cap the
// engine dispatches every one (each is a real DB write + handler call).
// Cap dispatches at the configured limit; overflow ops are silently dropped
// (no per-op log rows, to keep forensics from drowning in identical refusals)
// and a single max_commands_exceeded failure tells the model next turn.
test("{§edit} Engine.runTurn: PLURNK_SERVICE_MAX_COMMANDS caps dispatched actions; overflow drops + a durable failure pointer", async () => {
    const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "3";
    try {
        const { db, engine, workspaceId, sessionId, loopId } = await setup();
        try {
            const provider = new Mock({
                contextWindow: 100000,
                responses: [
                    // Turn 1 emits 5 actions plus its disposition; cap = 3;
                    // expect 3 actions dispatched, 2 dropped, and SEND dispatched.
                    response([
                        wsEditStmt("/a", "1"),
                        wsEditStmt("/b", "2"),
                        wsEditStmt("/c", "3"),
                        wsEditStmt("/d", "4"),
                        wsEditStmt("/e", "5"),
                        dispositionStmt("WAIT", "Observe the admitted edits."),
                    ]),
                    // Turn 2 clean — gives us a packet carrying turn 1's failure pointer.
                    response([wsEditStmt("/z", "z"), sendStmt(null, "ok")]),
                ],
            });
            const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
            assert.equal(t1.outcomes.length, 4, "3 actions plus the disposition dispatched");

            // Confirm only 3 model EDITs landed — overflow didn't sneak through.
            for (const [index, pathname] of ["/a", "/b", "/c", "/d", "/e"].entries()) {
                const entry = await db.test_get_channel_by_pathname_scheme.get({ scheme: "workspace", pathname, name: "body" });
                assert.equal(entry?.content, index < 3 ? String(index + 1) : undefined, "overflow operations never reach schemes");
            }

            // Turn 2 packet carries the cap failure as a terse 'Max Commands Exceeded' (429) log row,
            // surfaced via its derived LogCoordinate pointer. The emitted/dropped counts live on the row.
            const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
            const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
            const packet = JSON.parse(row?.packet ?? "{}");
            const capErrors = (JSON.parse(packetSection(packet, "errors") || "[]") as Array<{ status: number; path: string }>)
                .filter((e) => e.status === 429 && e.path.endsWith("/error"));
            assert.equal(capErrors.length, 1, "exactly one Max Commands Exceeded (429) error pointer from turn 1");
            assert.doesNotMatch(JSON.stringify(capErrors[0]), /cap/, "engine bookkeeping does not leak into the pointer");
        } finally { await db.close(); }
    } finally {
        if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
        else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
    }
});

// Default (`-1`) = no cap: every generated op dispatches. Dropping already-generated
// work is not the runaway guard (that lives at the sampler); a legitimate high-op turn
// must land in full with no max_commands_exceeded signal.
test("{§tokenomics} Engine.runTurn: PLURNK_SERVICE_MAX_COMMANDS=-1 (default) leaves the action ceiling off", async () => {
    const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "-1";
    try {
        const { db, engine, workspaceId, sessionId, loopId } = await setup();
        try {
            const provider = new Mock({
                contextWindow: 100000,
                responses: [
                    response([
                        wsEditStmt("/a", "1"), wsEditStmt("/b", "2"), wsEditStmt("/c", "3"),
                        wsEditStmt("/d", "4"), wsEditStmt("/e", "5"),
                        noteStmt("continue"),
                    ]),
                    response([wsEditStmt("/z", "z"), sendStmt(null, "ok")]),
                ],
            });
            const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
            assert.equal(t1.outcomes.length, 6, "all five edits and the note dispatched — no cap");
            for (const [index, pathname] of ["/a", "/b", "/c", "/d", "/e"].entries()) {
                const entry = await db.test_get_channel_by_pathname_scheme.get({ scheme: "workspace", pathname, name: "body" });
                assert.equal(entry?.content, String(index + 1), "every authored edit landed");
            }

            // Next packet carries NO max_commands_exceeded — the ceiling never engaged.
            const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
            const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
            const packet = JSON.parse(row?.packet ?? "{}");
            assert.doesNotMatch(packetSection(packet, "errors"), /"status":429/, "no Max Commands Exceeded when off");
        } finally { await db.close(); }
    } finally {
        if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
        else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
    }
});

// {§tokenomics}: maxTurns ends the loop at 429 independently of strikes.

test("{§tokenomics} Engine.runLoop: hitting maxTurns terminates the loop at 429 (max_turns)", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Every turn continues, so the turn ceiling is what stops it.
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, (_, i) => response([wsEditStmt(`/x-${i}`, "v"), noteStmt("more")])),
        });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 3 });
        assert.equal(result.hitMaxTurns, true);
        assert.equal(result.reason, "max_turns");
        assert.equal(result.result.status, 429, "the turn ceiling terminates the loop at 429 Too Many Requests {§tokenomics}");
    } finally { await db.close(); }
});

// {§engine-rails}: hard outcomes accumulate consecutive strikes;
// soft outcomes (404, 501) and clean turns reset the streak.

test("{§edit} Engine.runLoop: three consecutive hard failures abandon at 500 with strike_threshold reason", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // EDIT sealed:/// → 403 (writableBy denial = hard). In-progress inventory continues.
        // Vary the path per turn so the failures stay DISTINCT (no cycle) — this isolates
        // the failure path → 500 (an identical-repeat would also trip cycle → 508).
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, (_, i) => contentResp([
                "````EDIT (sealed:///x-" + (i) + ")",
                "v",
                "````",
                "````NOTE",
                "going",
                "````",
            ].join("\n"))),
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10, maxStrikes: 3,
        });
        assert.equal(result.result.status, 500, "distinct hard failures abandon at 500 Internal Server Error");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.hitMaxTurns, false);
        assert.equal(result.turnIds.length, 4, "initialization plus three struck model turns");
    } finally { await db.close(); }
});

test("{§loop-completion} Engine.runLoop: soft failures (404) do NOT accumulate strikes", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // READ a missing workspace:/// path → 404 (soft). With maxStrikes=2 and
        // 4 consecutive soft turns, no abandon should fire.
        // Vary path each turn to keep cycle detection orthogonal.
        const readMissing = (delimiter: string): ReadStatement => ({
            metadata: null,
            op: "READ", aside: null,
            target: urlPath("workspace", `/not-there-${delimiter}`),
            lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([readMissing("a"), noteStmt("1")]),
                response([readMissing("b"), noteStmt("2")]),
                response([readMissing("c"), noteStmt("3")]),
                response([readMissing("d"), noteStmt("4")]),
                // Complete on a clean turn; a READ plus same-turn completion requires observation.
                // ({§loop-completion}), which would confound this 404-soft-failure assertion.
                response([completeStmt("done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.reason, "external");
        assert.equal(result.turnIds.length, 6); // initialization + 4 soft-404 model turns + 1 clean terminal
    } finally { await db.close(); }
});

test("{§edit} Engine.runLoop: clean turn between hard failures resets the streak", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            metadata: null,
            op: "EDIT", aside: null,
            target: urlPath("sealed", "/x"),
            lineMarker: null, matcher: null, body: "v", position: { line: 1, column: 1 },
        });
        const goodEdit = (p: string): EditStatement => ({
            metadata: null,
            op: "EDIT", aside: null,
            target: urlPath("workspace", p),
            lineMarker: null, matcher: null, body: "v", position: { line: 1, column: 1 },
        });
        // maxStrikes=2. Pattern: hard, clean, hard, hard, done.
        // After turn 1: streak=1. After turn 2: streak=0 (reset). After
        // turn 3: streak=1. After turn 4: streak=2 → abandon.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied(), noteStmt("1")]),
                response([goodEdit("/ok"), noteStmt("2")]),
                response([denied(), noteStmt("3")]),
                response([denied(), noteStmt("4")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.result.status, 500, "distinct hard failures → 500");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 5, "initialization plus four model turns; the clean second model turn reset the streak");
    } finally { await db.close(); }
});

test("{§operation-results} Engine.runLoop: strike is engine-internal — model sees action_failure but NOT a strike notice", async () => {
    // Per SPEC {§operation-results} gamification policy: model sees the failed action
    // (action_failure surfaces the 403), never the engine's strike
    // counter. Telling the model "strike 1 of 5" would let it optimize
    // for the meter instead of the task.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            metadata: null,
            op: "EDIT", aside: null,
            target: urlPath("sealed", "/x"),
            lineMarker: null, matcher: null, body: "v", position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied(), noteStmt("1")]),
                response([denied(), noteStmt("2")]),
                response([completeStmt("done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10, maxStrikes: 5,
        });
        assert.equal(result.result.status, 200);
        const t2 = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds[2] });
        const t2packet = JSON.parse(t2?.packet ?? "{}");
        const errors = packetSection(t2packet, "errors");
        // The 403 action failure DOES surface (a real error that happened) as a LogCoordinate pointer.
        assert.match(errors, /"status":403,"path":"log:\/\/\/[^"]+\/EDIT"/, "the 403 action failure surfaces as a log-coordinate pointer");
        // The strike count does NOT — every surfaced error is a real log-row failure; gamification never leaks.
        assert.doesNotMatch(packetSection(t2packet, "notices"), /strike/, "strike accounting stays engine-internal");
    } finally { await db.close(); }
});

// {§engine-rails}: identical-fingerprint turns repeated MIN_CYCLES
// times trip the detector and strike the turn.

test("{§engine-rails} creation differs from repeated period-1 no-op edits", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Creation returns 201; only the following 304 results repeat.
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 8 }, () => contentResp("````EDIT (workspace:///fixed) <1,-1>\nv\n````\n````NOTE\ngo\n````")),
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 20, maxStrikes: 3, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.result.status, 508, "cycle-driven strike → 508 Loop Detected");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 7, "initialization plus creation, then five repeated no-op turns");
        const edits = (await db.test_log_entries_by_session.all<{ op: string; status_rx: number }>({ session_id: sessionId }))
            .filter(({ op }) => op === "EDIT");
        assert.deepEqual(edits.map(({ status_rx }) => status_rx), [201, 304, 304, 304, 304, 304]);
    } finally { await db.close(); }
});

test("{§loop-completion} Engine.runLoop: varied per-turn fingerprints don't trip cycle detection", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Vary EDIT path each turn → distinct fingerprints → no cycle.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([wsEditStmt("/a", "1"), noteStmt("1")]),
                response([wsEditStmt("/b", "2"), noteStmt("2")]),
                response([wsEditStmt("/c", "3"), noteStmt("3")]),
                response([wsEditStmt("/d", "4"), noteStmt("4")]),
                response([wsEditStmt("/e", "5"), sendStmt(null, "done")]),
                response([completeStmt("done")]), // {§loop-completion} — the last edit's observation turn
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10, maxStrikes: 2, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.turnIds.length, 7, "initialization plus five edit turns and the observation turn");
    } finally { await db.close(); }
});

test("{§engine-rails} period-2 no-op edits cycle after initial creations", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Two creations precede the six repeated no-op turns; the next
        // repeated turn crosses maxStrikes=2.
        const A = (): EditStatement => wsEditStmt("/A", "v");
        const B = (): EditStatement => wsEditStmt("/B", "v");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([A(), noteStmt("Update A")]),
                response([B(), noteStmt("Update B")]),
                response([A(), noteStmt("Update A")]),
                response([B(), noteStmt("Update B")]),
                response([A(), noteStmt("Update A")]),
                response([B(), noteStmt("Update B")]),
                response([A(), noteStmt("Update A")]),
                response([B(), noteStmt("Update B")]),
                response([A(), noteStmt("Update A")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 20, maxStrikes: 2, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.result.status, 508, "period-2 cycle-driven strike → 508 Loop Detected");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 10, "initialization, two creations, then seven alternating no-op turns");
        const edits = (await db.test_log_entries_by_session.all<{ op: string; status_rx: number }>({ session_id: sessionId }))
            .filter(({ op }) => op === "EDIT");
        assert.deepEqual(edits.map(({ status_rx }) => status_rx), [201, 201, 304, 304, 304, 304, 304, 304, 304]);
    } finally { await db.close(); }
});

test("{§operation-results} Engine.runLoop: cycle detection is internal — NO model-facing notice", async () => {
    // {§operation-results} — cycle and strike state are engine bookkeeping.
    // The model sees admitted operation failures, not the accounting.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 20 }, () => response([wsEditStmt("/x", "v"), noteStmt("go")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 20, maxStrikes: 10, minCycles: 3, maxCyclePeriod: 4,
        });
        const t4 = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds[3] });
        const packet = JSON.parse(t4?.packet ?? "{}");
        // None of the engine-bookkeeping kinds surface.
        for (const kind of ["cycle", "strike"]) {
            assert.equal(packetSection(packet, "notices").includes(kind), false, `${kind} is engine bookkeeping per gamification policy`);
        }
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: the durable failure projection shows once, then ages out", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            metadata: null,
            op: "EDIT", aside: null,
            target: urlPath("sealed", "/x"),
            lineMarker: null, matcher: null, body: "v", position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied(), noteStmt("1")]),                // turn 1: 403 action_failure
                response([wsEditStmt("/b", "2"), noteStmt("go")]),   // turn 2: clean (drains buffer)
                response([wsEditStmt("/c", "3"), sendStmt(null, "ok")]),   // turn 3: clean
            ],
        });
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const get403s = async (turnId: number): Promise<number[]> => {
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
            const packet = JSON.parse(row?.packet ?? "{}");
            return (JSON.parse(packetSection(packet, "errors") || "[]") as Array<{ status: number }>)
                .filter((e) => e.status === 403)
                .map((e) => e.status);
        };
        // The errors section is a recency window (current + immediately-prior turn), so a failure
        // surfaces once and ages out.
        // T1's packet: the 403 hasn't surfaced yet (it happens during T1's dispatch).
        assert.deepEqual(await get403s(t1.turnId), []);
        // T2's packet: the prior-turn 403 surfaces as a log-coordinate pointer.
        assert.deepEqual(await get403s(t2.turnId), [403]);
        // T3's packet: the 403 has aged out of the window (T2 was clean), doesn't replay.
        assert.deepEqual(await get403s(t3.turnId), []);
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: assistantRaw passes through into turn.packet.assistantRaw", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const raw = { vendor: "anthropic", id: "msg_xyz" };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{
                assistant: { content: "", ops: [completeStmt("")], reasoning: null },
                assistantRaw: raw,
            }],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { assistantRaw: { vendor: string; id: string } };
        assert.deepEqual(packet.assistantRaw, raw);
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: sequence increments across multiple turn calls in the same loop", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([noteStmt("1")]),
                response([noteStmt("2")]),
                response([completeStmt("3")]),
            ],
        });
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const seqs = await db.test_list_turns_in_loop.all<{ id: number; sequence: number; packet: string | null }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3, 4]);
        assert.equal(seqs[0]?.packet, null, "turn 1 is packetless initialization");
        assert.deepEqual([t1.turnId, t2.turnId, t3.turnId], seqs.slice(1).map((s) => s.id));
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200, "loop terminal after final completed inventory");
    } finally { await db.close(); }
});

test("{§op-shapes} Engine.runTurn: a trusted batch with two dispositions dispatches both as one park", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([dispositionStmt("WAIT", "first"), dispositionStmt("WAIT", "last")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(result.status, 102, "nothing is in flight, so the park continues at once");
        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        assert.ok(turn);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null }>({ turn_id: turn.id });
        assert.equal(rows.filter(({ op }) => typeof op === "string" && TurnDisposition.isOp(op)).length, 2, "both WAITs are rows of the one turn");
    } finally { await db.close(); }
});

// {§packet} {§packet} — chronological log-section rows.

test("{§message-arrival} Engine.runTurn: the first turn's log section contains the arrival row", async () => {
    // {§message-arrival}: the message is published before the model packet is built.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([wsEditStmt("/x", "y"), sendStmt(null, "done")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const log = logEntries(JSON.parse(row?.packet ?? "{}"));
        // The arrival is the model turn's first row: an inbound SEND with no target.
        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; log_entry_id: number | null }>;
        assert.deepEqual(inbox.map(({ ordinal }) => ordinal), [1], "the loop's one message");
        assert.ok(inbox[0].log_entry_id !== null, "the inbox row was stamped with the row it became");
        const prompt = log.find((e) => e.logPath.endsWith("/SEND"));
        assert.ok(prompt, "the arrival row is in the log");
        // {§message-arrival} — every other sender has an address; the operator's message is named,
        // or it reads as the model's own SEND.
        assert.equal(prompt.origin, "user", "the operator's message says whose it is");
        assert.equal(prompt.source, undefined, "the operator has no actor address");
        assert.equal("path" in prompt, false, "an arrival has no addressed operand");
        assert.match(prompt.logPath, /\/SEND$/, "the path owns the SEND delimiter");
    } finally { await db.close(); }
});

test("{§session-initialization-entry} Engine.runTurn: the second turn's log section captures prior actions", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([wsEditStmt("/a", "1"), noteStmt("keep going")]),
                response([wsEditStmt("/b", "2"), sendStmt(null, "done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const log = logEntries(JSON.parse(row?.packet ?? "{}"));
        // Turn 2 packet sees the arrival row + the prior turn's two model ops (an
        // EDIT and a SEND). Found by identity (an untargeted SEND without a reply receipt),
        // robust to the turn-0 initialization ({§session-initialization-entry}) and a
        // catalog-preview foist that shift coordinates between the arrival and the model's ops.
        assert.ok(log.find((e) => e.logPath.endsWith("/SEND") && !("path" in e) && !("answers" in e)), "arrival row logged");
        const edit = log.find((e) => (e.origin ?? "model") === "model" && e.logPath.endsWith("/EDIT"));
        assert.ok(edit, "model EDIT logged");
        assert.equal(edit.status, 201);
        assert.equal(edit.path, "workspace:///a");
        const send = log.find((e) => (e.origin ?? "model") === "model" && e.logPath.endsWith("/NOTE"));
        assert.ok(send, "model NOTE logged");
        assert.match(String(send.body), /keep going/);
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} Engine.runTurn: the log section parses an application/json rx body", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([wsEditStmt("/x", "v"), noteStmt("more")]),
                response([completeStmt("done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        const log = logEntries(packet);
        // Found by identity, robust to a turn-0 catalog-preview foist.
        const edit = log.find((e) => (e.origin ?? "model") === "model" && e.logPath.endsWith("/EDIT"));
        assert.ok(edit, "model EDIT logged");
        assert.equal(edit.status, 201);
        // The EDIT's result span renders as an anchored coordinate line —
        // observable proof #buildLog parsed the JSON rx: a string rx couldn't yield
        // rx.span, so the render would fall back to the authored statement instead.
        assert.match(String(edit.body), /^1<@[0-9A-Za-z]{5}>v\n$/, "{§edit-result-receipt-projection}");
    } finally { await db.close(); }
});

// {§operation-results}: action-bound failures project into
// the next packet's Errors section.

test("{§edit} Engine.runTurn: Errors is empty on a clean first turn", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([wsEditStmt("/x", "y"), sendStmt(null, "done")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.equal(packetSection(packet, "errors"), "");
    } finally { await db.close(); }
});

test("{§edit} Errors pointers use the canonical projected operation of a materialization row", async () => {
    const { db, sessionId, loopId } = await setup();
    try {
        const turnId = await insertTurn(db, loopId, 1, 102);
        await db.engine_insert_log_entry.get({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "_plurnk", source: "test", model_call_id: null, op: "EDIT",
            scheme: "https", username: null, password: null, hostname: "example.org", port: null,
            pathname: "/rejected", query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: "{}", mimetype_rx: "application/json", status_rx: 422, weight: 0,
            state: "resolved", outcome: null, attrs: JSON.stringify({ kind: "entry_materialized" }),
        });
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        assert.deepEqual(await packets.buildFailurePointers(loopId, 2), [{
            status: 422,
            coordinate: "1/1/1/READ",
        }]);
    } finally { await db.close(); }
});

test("{§operation-results} Engine.runTurn: previous-turn 403 surfaces in the next packet's Errors section", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Model attempts to EDIT sealed:/// — denied 403 (writableBy=['_plurnk']).
        const denied: EditStatement = {
            metadata: null,
            op: "EDIT", aside: null,
            target: urlPath("sealed", "/illegal"),
            lineMarker: null, matcher: null, body: "x", position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied, noteStmt("keep going")]),
                response([completeStmt("done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        // {§operation-results}: the pointer targets the OP ROW — the row carries its own
        // failure message on its meta line, so the pointer leads to a record that states its why.
        // The initialization is turn 1. In model turn 2, the prompt precedes
        // the denied EDIT, whose stable coordinate is therefore 1/2/2.
        assert.equal(packetSection(packet, "errors"), '[{"status":403,"path":"log:///1/2/2/EDIT"}]', "the pointer targets the failing op row itself");
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: Errors includes only the immediately previous turn", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const denied: EditStatement = {
            metadata: null,
            op: "EDIT", aside: null,
            target: urlPath("sealed", "/a"),
            lineMarker: null, matcher: null, body: "x", position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied, noteStmt("t1 had a failure")]),
                response([wsEditStmt("/ok", "v"), noteStmt("t2 was clean")]),
                response([completeStmt("done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });   // t1: 1 failure
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });   // t2: clean
        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t3.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.equal(packetSection(packet, "errors"), "", "t3 mirrors t2 only (clean); t1's failure stays in log:///, off-screen");
    } finally { await db.close(); }
});

test("{§outside-text}: free text is the turn's outside source, never delivered, and the following operation still runs", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{ assistant: { content: "Just thinking out loud here.\n\n````SEND\ndone\n````", reasoning: null } }],
        });
        const result = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        assert.deepEqual(result.outcomes, [
            { op: "NOTE", status: 200, problemType: null },
            { op: "SEND", status: 200, problemType: null },
        ], "the text beside the message is the turn's NOTE at its position; the message is delivered without a corrective failure");
        assert.equal(result.status, 102);
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === result.turnId && row.kind === "outside"), undefined, "beside a fenced operation the text is a NOTE, not an outside source");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ origin, op }) => origin === "model" && op === "NOTE").map(({ tx }) => JSON.parse(tx).body), ["Just thinking out loud here."]);
    } finally { await db.close(); }
});

test("{§edit} Engine.runTurn: NOTE carries literal working memory separate from provider reasoning", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([wsEditStmt("/note", "finding"), noteStmt("Review the edit result.")], "", 10)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        assert.deepEqual(result.outcomes, [
            { op: "EDIT", status: 201, problemType: null },
            { op: "NOTE", status: 200, problemType: null },
        ]);
        const ops = await db.test_log_entries_by_loop.all<{ op: string; tx: string }>({ loop_id: loopId });
        assert.ok(ops.some((row) => row.op === "NOTE" && JSON.parse(row.tx).body === "Review the edit result."));
    } finally { await db.close(); }
});
});

describe("contract-notices", () => {
const UNACCOUNTED = "> [!WARNING]\n> 5000 output tokens billed; 1 visible across content and reasoning @ 2:3 [output_unaccounted]";
// {§operation-results} — the turns under test continue without a NOTE, and the next packet says so.
const CONTINUED = "> [!WARNING]\n> YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn. The turn continued without a NOTE. [continued_without_note]";
const scope = (requested: string, canonical: string): string =>
    `> [!WARNING]\n> YOU SHOULD write the normalized scope. Scope <${requested}> was normalized to <${canonical}>. [scope_normalized]`;

// Response from raw content WITHOUT ops - forces the engine to run the real
// PlurnkParser rather than Mock's trusted pre-parsed seam.
const contentResponse = (content: string): MockResponse => ({
    assistant: {
        content,
        reasoning: null,
    },
    assistantRaw: null,
});

// A complete, admitted draining turn. Its only job is to run so the model's
// next packet drains the notices buffer on read.
const drainTurn = contentResponse("````SEND [200]\ndrained\n````");

// A provider transport anomaly notice: the provider notice path carries observations
// such as a decode escaping into a discarded channel ({§provider-instantiation} grades nothing).
// `extraDrains` clean turns follow so the buffer can be observed draining.
const NOTICE_CONTENT = "\n````SEND\nnoted\n````";
const NOTICE_POS = Array.from(NOTICE_CONTENT.slice(0, NOTICE_CONTENT.indexOf("````SEND") + 3)).length;
const noticeProvider = (extraDrains: number) => {
    const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: extraDrains }, () => drainTurn) });
    const real = provider.generate.bind(provider);
    let did = false;
    provider.generate = async (req) => {
        if (did) return real(req);
        did = true;
        const accounting = {
            provider: "provider:mock",
            model: "mock",
            outcome: "response",
            usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
            cost: {
                kind: "estimated",
                amount: { amount: "0", currency: "USD" },
                source: "notice fixture",
            },
        } as const;
        const settle = await req.observeRequest?.({ provider: accounting.provider, model: accounting.model });
        await settle?.(accounting);
        return {
            assistant: { content: NOTICE_CONTENT, reasoning: null, finishReason: "stop", model: "mock" },
            assistantRaw: { id: "x", filtered: true },
            accounting: [accounting],
            capacity: testProviderCapacity(req.messages, provider.contextWindow),
            notices: [{ source: "provider:mock", kind: "output_unaccounted", level: "warn", message: "5000 output tokens billed; 1 visible across content and reasoning", position: NOTICE_POS }],
        };
    };
    return provider;
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "what is the capital of france?");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, workspaceId, sessionId, loopId };
};

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    return JSON.parse(row?.packet ?? "{}") as { sections: Array<Record<string, unknown>> };
};

test("{§operation-results} a content-offset NOTICE (output_unaccounted) carries a line:col pointer, no embedded snippet", async () => {
    // A NOTICE points at exact source retrievable through ops://<session>/, not an automatic log row.
    // ({§log-history-projection}) — the model READs it at the cited lines. No snippet duplicating the bytes.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = noticeProvider(1);
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const p1 = await getPacket(db, t1.turnId) as { assistant?: { content?: string } };
        assert.equal(p1.assistant?.content, NOTICE_CONTENT, "a transport notice does not discard completed model bytes");
        const p2 = await getPacket(db, t2.turnId);
        const notice = packetSection(p2, "notices");
        assert.equal(
            notice,
            `${UNACCOUNTED}\n\n${CONTINUED}`,
            "the notice surfaced on the next packet with its bounded message and content-offset",
        );

        // The wire: a meta line carrying the position, no snippet / error:// fence. The Errors
        // section is framework status (uri+status pointers) in the user slot's status clump
        // ({§packet-assembly}); render it alone so the log's JSON rows don't blur the assertions.
        const wire = PacketWire.renderSection(p2.sections.find((s) => s.name === "notices")!);
        assert.match(wire, /## Notices/);
        assert.doesNotMatch(wire, /\{"/, "no JSON dump — the section renders terse lines, not events");
        assert.match(wire, /^> 5000 output tokens billed; 1 visible across content and reasoning @ 2:3 \[output_unaccounted\]$/m);

        const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const source = programs.find(({ turn_id, kind }) => turn_id === t1.turnId && kind === "ops");
        assert.ok(source?.content, "the notice's source is retained for a scoped ops READ");
        const echo = (await db.test_log_entries_by_loop.all<{ op: string | null; turn_id: number }>({ loop_id: loopId }))
            .find((row) => row.turn_id === t1.turnId && row.op === null);
        assert.equal(echo, undefined, "a notice does not reintroduce automatic source log rows");
    } finally { await db.close(); }
});

test("{§operation-results} the notice buffer drains — a notice appears on exactly one packet, then is gone", async () => {
    // Errors persist (log items); engine NOTICES are ephemeral — drain-on-read, one packet only.
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = noticeProvider(2);
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const kindsOf = async (turnId: number) =>
            packetSection(await getPacket(db, turnId), "notices")
                .split("\n")
                .filter((line) => line.includes("output_unaccounted")).length;

        assert.equal(await kindsOf(t1.turnId), 0, "notice not visible on the turn that produced it");
        assert.equal(await kindsOf(t2.turnId), 1, "notice drained exactly once on read");
        assert.equal(await kindsOf(t3.turnId), 0, "drained notice does not reappear on subsequent packets");
    } finally { await db.close(); }
});

for (const fail of [false, true]) {
    test(`{§operation-results} ${fail ? "exceptional exit" : "normal completion"} releases undelivered notices`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "notice-cleanup");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Record the observation, then finish.");
        const pushed = t.mock.method(NoticeChannel.prototype, "push");
        const cause = new Error("notice delivery fixture failed");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_workspaceId, { notice }) => {
            if (fail && notice.kind === "parse_advisory") throw cause;
        } });
        const provider = new Mock({ contextWindow: 100_000, responses: [contentResponse("````NOTE remember\n````\n\n````SEND [200]\ndone\n````")] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        if (fail) await assert.rejects(running, (error) => error === cause);
        else assert.equal((await running).result.status, 200);
        const warning = pushed.mock.calls.find(({ arguments: args }) => args[2] === loopId && args[3].kind === "parse_advisory");
        assert.ok(warning, "the last emission produced a pending warning");
        assert.deepEqual((warning.this as NoticeChannel).drain(loopId), [], "no future model packet exists to consume the buffer");
    });
}

test("a tolerated three-coordinate scope reports its exact canonical region on the next packet ({§zero-width-column-one-insert})", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    await seedEntryWithChannel(db, {
        workspaceId,
        pathname: "/x",
        content: "alpha\nbeta\ngamma\ndelta",
        mimetype: "text/markdown",
    });
    try {
        const stmtTurn = (ops: PlurnkStatement[]): MockResponse => ({
            assistant: {
                content: "",
                ops,
                reasoning: null,
            },
        });
        const scopedRead = readStmt(urlPath("workspace", "/x"));
        scopedRead.lineMarker = { marks: [2, 1, 3] };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                stmtTurn([scopedRead, noteStmt("read")]),
                stmtTurn([completeStmt("done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);

        const read = logEntries(packet).find(({ logPath, body }) =>
            typeof logPath === "string" && logPath.endsWith("/READ") && /2<@[0-9A-Za-z]{5}>beta/.test(String(body)));
        assert.match(String(read?.body), /^2<@[0-9A-Za-z]{5}>beta\n3<@[0-9A-Za-z]{5}>gamma\n$/);
        assert.equal(
            packetSection(packet, "notices"),
            scope("2,1,3", "2,1,3,6"),
        );
    } finally { await db.close(); }
});

test("{§slicer-text-algebra}: a zero-start READ delivers its body and one warning without a failed operation", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        await seedEntryWithChannel(db, { workspaceId, pathname: "/zero-start", content: "alpha\nbeta\ngamma", mimetype: "text/plain" });
        const scopedRead = readStmt(urlPath("workspace", "/zero-start"));
        scopedRead.lineMarker = { marks: [0, 120] };
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "", ops: [scopedRead], reasoning: null } },
            { assistant: { content: "", ops: [completeStmt("done")], reasoning: null } },
        ] });
        const first = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        const read = logEntries(packet).find(({ logPath, body }) => logPath.endsWith("/READ") && /1<@[0-9A-Za-z]{5}>alpha/.test(String(body)));
        assert.match(String(read?.body), /1<@[0-9A-Za-z]{5}>alpha\n2<@[0-9A-Za-z]{5}>beta\n3<@[0-9A-Za-z]{5}>gamma/);
        assert.equal(packetSection(packet, "notices"),
            `${scope("0,120", "1,120")}\n\n${CONTINUED}`);
        const receipts = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: first.turnId });
        assert.deepEqual(receipts.filter(({ op }) => op === "READ").map(({ status_rx }) => status_rx), [200]);
        assert.doesNotMatch(packetSection(packet, "notices"), /strike|failed/i);
    } finally { await db.close(); }
});

test("an EDIT batch reports each tolerated scope once in authored order ({§zero-width-column-one-insert})", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    const target = urlPath("workspace", "/x");
    await seedEntryWithChannel(db, {
        workspaceId,
        pathname: "/x",
        content: "alpha\nbeta\ngamma\ndelta",
        mimetype: "text/markdown",
    });
    try {
        const stmtTurn = (ops: PlurnkStatement[]): MockResponse => ({
            assistant: {
                content: "",
                ops,
                reasoning: null,
            },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                stmtTurn([
                    editStmt(target, "A", { marks: [1, 2, 1] }),
                    editStmt(target, "G", { marks: [3, 2, 3] }),
                    noteStmt("edited"),
                ]),
                stmtTurn([completeStmt("done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        assert.equal(
            packetSection(await getPacket(db, second.turnId), "notices"),
            [scope("1,2,1", "1,2,1,6"), scope("3,2,3", "3,2,3,6")].join("\n\n"),
        );
    } finally { await db.close(); }
});

test("{§packet} a thrown ProviderError is persisted as one exact operation failure — no turn is fabricated", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // A ProviderError means no completed exchange exists (auth, network, rate
        // limit). The engine persists that failure and does not invent model bytes.
        const provider = new Mock({ contextWindow: 100000, responses: [drainTurn] });
        const realGenerate = provider.generate.bind(provider);
        let threw = false;
        provider.generate = async (req) => {
            if (threw) return realGenerate(req);
            threw = true;
            throw new ProviderError("mock", "unauthorized", "backend rejected the API key");
        };

        await assert.rejects(
            () => engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] }),
            (err: unknown) => {
                assert.ok(err instanceof OperationFailureError);
                assert.equal(err.result.status, 401);
                assert.equal(err.result.problem.type, "https://problems.plurnk.xyz/provider/mock/unauthorized");
                assert.equal(err.result.problem.detail, "backend rejected the API key");
                assert.match(err.result.problem.instance ?? "", /^log:\/\/\//);
                return true;
            },
            "the infrastructure failure propagates — no fabricated turn absorbs it",
        );

        const failures = (await db.test_log_entries_by_loop.all<{
            op: string;
            status_rx: number;
            rx: string;
        }>({ loop_id: loopId })).filter(({ op }) => op === "error");
        assert.equal(failures.length, 1, "the provider failure has one durable owner");
        const durable = JSON.parse(failures[0].rx) as { status: number; problem: { detail: string; instance: string } };
        assert.equal(durable.status, 401);
        assert.equal(durable.problem.detail, "backend rejected the API key");
        assert.match(durable.problem.instance, /^log:\/\/\//);

        // A later packet projects only a terse pointer to the durable Problem.
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.match(packetSection(p2, "errors"), /"status":401,"path":"log:\/\/\/[^"]+\/error"/);
        assert.equal(packetSection(p2, "notices").includes("unauthorized"), false, "terminal failure never masquerades as a notice");
    } finally { await db.close(); }
});

test("{§engine-rails} provider error: a terminal kind is durable product truth, never a notices notice", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => { broadcasts.push({ payload: payload }); },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };

        // {§engine-rails} — a transient infra failure never ends the loop: the turn retries with
        // backoff (the Mock tier's budget is 1.5 s) and, still failing, parks as a 202 wait.
        const turn = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(turn.status, 202, "the turn parks instead of failing the loop");
        assert.equal(turn.providerParked, true);
        assert.equal(turn.providerFailure?.status, 503);
        assert.equal(turn.providerFailure?.problem?.type, "https://problems.plurnk.xyz/provider/plurnk/network-failure");
        assert.equal(turn.providerFailure?.problem?.detail, "connection refused");
        assert.equal(
            broadcasts.filter((b) => b.payload.notice.kind === "network_failure").length,
            0,
            "the provider's own failure is not duplicated onto the notice channel",
        );
        const recovery = broadcasts.filter((b) => b.payload.notice.source === "engine:provider").map((b) => b.payload.notice);
        assert.ok(recovery.length >= 2, "every retry and the park are noticed");
        assert.ok(recovery.slice(0, -1).every((notice) => notice.kind === "provider_unavailable" && notice.level === "warn" && /retrying in/u.test(String(notice.message))));
        assert.equal(recovery.at(-1)?.level, "error");
        assert.match(String(recovery.at(-1)?.message), /parked/u);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: loopId });
        const durable = rows.find(({ op }) => op === "error");
        assert.ok(durable !== undefined);
        assert.equal((JSON.parse(durable.rx) as { problem: { detail: string } }).problem.detail, "connection refused");
    } finally { await db.close(); }
});

test("{§operation-results} engine brackets generate() with turn_awaiting_model → turn_generated notices (liveness heartbeat)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => { broadcasts.push({ payload: payload }); },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [drainTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        // The two beats bracket the provider call, in order — so a client flips "reasoning… → working…"
        // across the one long opaque window (submit → first committed op) instead of a static screen
        // that reads as a hang. Live-broadcast, info-level, scoped to the loop.
        const lifecycle = broadcasts.filter((b) => b.payload.notice.source === "engine:turn");
        assert.deepEqual(lifecycle.map((b) => b.payload.notice.kind), ["turn_awaiting_model", "turn_generated"], "two engine:turn beats, in generate()-bracket order");
        // {§operation-results} (#465) — the completion beat carries the turn's exact
        // settled wire accounting, so a live watcher accrues loop cost per turn.
        const generated = lifecycle[1].payload.notice as {
            accounting?: { requests: number; costUsd: string | null; inputTokens: number | null; outputTokens: number | null };
        };
        assert.deepEqual(generated.accounting, {
            requests: 1,
            costUsd: "0",
            knownCostUsd: "0",
            inputTokens: 0,
            knownInputTokens: 0,
            outputTokens: 0,
            knownOutputTokens: 0,
            reasoningTokens: null,
            knownReasoningTokens: null,
            cacheReadTokens: null,
            knownCacheReadTokens: null,
        }, "the exact settled derivation rides turn_generated");
        for (const b of lifecycle) {
            assert.equal(b.payload.notice.level, "info", "lifecycle beats are info-level progress notices, never errors");
            assert.equal(b.payload.loopId, loopId, "scoped to the loop");
        }
    } finally { await db.close(); }
});

test("{§operation-results} a parser warning remains advisory while the independently invalid mutation stays durable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "finish despite a recoverable grammar advisory");
        const broadcasts: Array<{ payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (_sid, payload) => {
                broadcasts.push({ payload: payload });
            },
        });
        const emission = "\n````EDIT (src/example.ts<1,-1>)\nbody\n````\n\n````SEND\ndone\n````";
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                contentResponse(emission),
            ],
        });

        const turn = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        assert.equal(turn.status, 102, "the invalid mutation prevents premature terminal completion");
        assert.equal(turn.emissionAttempts, 1, "the advisory does not reject and reroll the trustworthy frame");
        assert.ok(
            turn.outcomes.some(({ op, status }) => op === "EDIT" && status === 400),
            "the targetless mutation fails through ordinary operation execution",
        );
        const advisories = broadcasts.filter(({ payload }) => payload.notice.kind === "parse_advisory");
        assert.equal(advisories.length, 1, "the recoverable parser diagnosis is emitted once");
        assert.equal(advisories[0].payload.notice.level, "warn");
        assert.match(String(advisories[0].payload.notice.message), /The scope was inside the target slot; it was applied as the operation scope\./);
        assert.deepEqual(
            advisories[0].payload.notice.position,
            { type: "content-offset", line: 2, column: 24 },
            "the Notice retains the parser's typed source position",
        );
        const [failedEdit] = await db.test_log_entries_by_session_op_full.all<{
            status_rx: number;
        }>({ session_id: sessionId, op: "EDIT" });
        assert.equal(failedEdit?.status_rx, 400, "the operation's own row preserves its durable failure");
        assert.deepEqual(
            await db.test_error_rows_for_session.all({ session_id: sessionId }),
            [],
            "the advisory and operation failure mint no substitute error row",
        );
    } finally { await db.close(); }
});

test("{§packet} a notice broadcasts structured and drains as its terse model-facing projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "trace the broken xpath");

        // Capture the live fan-out: every Notice the engine pushes
        // to the loop's buffer also fires this callback the moment it lands.
        const broadcasts: Array<{ workspaceId: number; payload: { loopId: number; notice: Record<string, unknown> } }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (sid, payload) => { broadcasts.push({ workspaceId: sid, payload: payload }); },
        });

        const provider = noticeProvider(1);                   // turn 1: output_unaccounted NOTICE pushed + broadcast live
        // NOTE: errors are log items (no notice/event); the broadcast surface is for engine NOTICES.
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        // Client side: the notice broadcast live, scoped to the loop's workspace,
        // BEFORE turn 2 ever builds a packet.
        const liveParse = broadcasts.filter((b) => b.payload.notice.kind === "output_unaccounted");
        assert.equal(liveParse.length, 1, "the notice broadcast live exactly once");
        assert.equal(liveParse[0].workspaceId, workspaceId, "scoped to the loop's workspace");
        assert.equal(liveParse[0].payload.loopId, loopId);
        const liveNotice = liveParse[0].payload.notice;
        assert.equal(liveNotice.source, "provider:mock");
        assert.equal(liveNotice.kind, "output_unaccounted");
        assert.deepEqual(liveNotice.position, { type: "content-offset", line: 2, column: 3 });

        // Model side: the notice drains once as a bounded projection.
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        assert.equal(
            packetSection(p2, "notices"),
            `${UNACCOUNTED}\n\n${CONTINUED}`,
        );
    } finally { await db.close(); }
});

test("{§operation-fences}: literal programs inside a longer fence produce no spurious parse advisory", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const emission = "`````EDIT (workspace:///a.md) <!-- first note -->\nalpha\n````EDIT (workspace:///b.md) <!-- literal example -->\nbeta\n````\n````EDIT (workspace:///c.md)\ngamma\n````\n`````\n````NOTE\ncontinue\n````";
        const provider = new Mock({ contextWindow: 100000, responses: [contentResponse(emission), contentResponse("````SEND [200]\ndone\n````")] });
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(t1.emissionAttempts, 1);
        const edits = t1.outcomes.filter(({ op }) => op === "EDIT");
        assert.equal(edits.length, 1, "the nested programs are one EDIT's literal body");
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const p2 = await getPacket(db, t2.turnId);
        const notice = packetSection(p2, "notices");
        assert.doesNotMatch(notice, /parse_advisory|parse_error/, "literal examples are not probable mistakes");
    } finally { await db.close(); }
});
});

describe("live-harness-resources", () => {
test("{§tokenomics} live fixtures obey resource publication and query contracts", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const workspace = await liveWorkspace({ name: "harness-resource-publication" });
    try {
        const sessionId = await namedModelSession(workspace.daemon, workspace.workspaceId, "main");
        for (const content of ["alpha\nbeta\ngamma", ""]) {
            await t.test(`{§tokenomics} ${content.length === 0 ? "empty" : "nonempty"} fixtures have their actual curation weight`, async () => {
                const entryId = await seedEntry(workspace.db, workspace.workspaceId, {
                    pathname: content.length === 0 ? "empty.md" : "lines.md", content,
                });
                const channels = await workspace.db.entry_read_channels.all<{
                    name: string; content: string; weight: number;
                }>({ entry_id: entryId });
                const body = channels.find(({ name }) => name === "body");
                assert.ok(body);
                assert.equal(body.content, content);
                assert.equal(body.weight, contentWeight(content));
            });
        }

        const html = "<html><body><h1>Welcome</h1></body></html>";
        const entryId = await seedEntry(workspace.db, workspace.workspaceId, {
            pathname: "page.html", content: html, mimetype: "text/html",
        });
        await t.test("{§channel-selection} an HTML fixture retains its source and publishes its readable sibling", async () => {
            const channels = await workspace.db.entry_read_channels.all<{
                name: string; content: string; mimetype: string; weight: number;
            }>({ entry_id: entryId });
            const source = channels.find(({ name }) => name === "body");
            assert.equal(source?.content, html);
            assert.equal(source?.mimetype, "text/html");
            const readable = channels.find(({ name }) => name === "readable");
            assert.ok(readable, "the live fixture uses the production readable projection");
            assert.match(readable.content, /Welcome/u);
            assert.equal(readable.mimetype, "text/markdown");
            assert.equal(readable.weight, contentWeight(readable.content));
        });
        await t.test("{§mimetype-query} an HTML fixture answers the live story's XPath through the real dispatcher", async () => {
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [readStmt(parsePath("workspace:///page.html"), { marks: [1, -1] }, {
                    dialect: "xpath", raw: "//h1",
                })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.equal(result.matched, 1);
            assert.match(String(result.content), /Welcome/u);
        });
        await t.test("{§channel-selection} ordinary READ keeps the fixture's source text", async () => {
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [readStmt(parsePath("workspace:///page.html"), { marks: [1, -1] })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.equal(result.content, html);
        });
        await t.test("{§mimetype-query} JSON fixtures support structural READ", async () => {
            const content = '{"answer":42}';
            await seedEntry(workspace.db, workspace.workspaceId, {
                pathname: "answer.json", content, mimetype: "application/json",
            });
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [readStmt(parsePath("workspace:///answer.json"), { marks: [1, -1] }, {
                    dialect: "jsonpath", raw: "$.answer",
                })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.equal(result.matched, 1);
            assert.equal(result.content, content);
        });
        await t.test("{§matcher-dispatch} fixtures enter the ordinary full-text index", async () => {
            await seedEntry(workspace.db, workspace.workspaceId, {
                pathname: "notes.md", content: "Checkpoint retention is working.",
            });
            const [result] = await workspace.daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId, actor: TEST_OWNER, contextSessionId: sessionId,
                statements: [findStmt(parsePath("workspace:///notes.md"), { dialect: "fts", raw: "~checkpoint" })],
            });
            assert.ok(result !== undefined);
            assert.equal(result.status, 200);
            assert.deepEqual(JSON.parse(String(result.content)), [{
                region: "<1,1,1,11>", matched: "Checkpoint",
            }]);
        });
        assert.equal(inference.mock.callCount(), 0, "publishing and inspecting fixtures requires no inference");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
});
});

describe("loop-docs", () => {
class FixtureEngine extends Engine {
    documents: Array<{ pathname: string; content: string }> = [];

    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return this.documents;
    }
}

test("{§application-session-observation} {§application-session-observation} maintenance preserves work lifecycle and scheduler history", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    try {
        const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "maintenance-status");
        for (const [status, lifecycle] of [[null, "idle"], [100, "queued"], [102, "running"], [202, "parked"], [200, "completed"], [499, "cancelled"], [500, "failed"]] as const) {
            const sessionId = await insertSession(db, workspaceId, null, `session-${lifecycle}`, "model");
            const loopId = status === null ? null : await insertLoop(db, sessionId, 1, "do the work");
            if (loopId !== null) {
                await db.test_set_loop_status.run({
                    id: loopId,
                    status,
                    terminal_result: status === 500 || status === 499 ? JSON.stringify(Results.attachInstance(
                        status === 500 ? Results.failure("engine:fixture", "failed", 500, "Work failed.") : Results.failure("engine:fixture", "cancelled", 499, "Work cancelled."),
                        `session://session-${lifecycle}`,
                    ))
                        : status === 200 ? JSON.stringify({ status: 200 }) : null,
                });
            }
            engine.documents = [{ pathname: "/_plurnk/plurnk/tool.md", content: "# Tool\n\nReady." }];
            await LoopDocs.materialize(engine, db, workspaceId);
            const session = await daemon.readSession({ workspaceId, identity: { id: sessionId } });
            assert.equal(session?.lifecycle, lifecycle, "housekeeping does not replace work status");
            assert.equal((await daemon.listSessions(workspaceId)).find(({ id }) => id === sessionId)?.lifecycle, lifecycle);
            assert.deepEqual((await daemon.listSessionLoops({ workspaceId, sessionId })).map(({ id }) => id), loopId === null ? [] : [loopId],
                "status snapshots see work, not administrative housekeeping loops");
            const loops = await db.test_loop_queue_by_session.all<{ id: number }>({ session_id: sessionId });
            assert.deepEqual(loops.map(({ id }) => id), loopId === null ? [] : [loopId]);
            const maintenance = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
            assert.ok(maintenance);
            const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: maintenance.id });
            assert.deepEqual(turns.map(({ kind }) => kind), ["maintenance"], "maintenance remains ordinary durable history");
        }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§env-delta} generated child documentation is durable without publishing a task conclusion", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "child-docs-conclusion");
        const parentId = await insertSession(db, workspaceId, null, "parent");
        const childId = await insertSession(db, workspaceId, parentId, "child");
        const parentLoopId = await insertLoop(db, parentId, 1, "observe child");
        engine.documents = [{ pathname: "/_plurnk/plurnk/tool.md", content: "# Tool\n\nReady to use." }];

        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await db.test_get_loop_by_session.get({ session_id: childId }), undefined);
        const adminLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
        assert.ok(adminLoop);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: adminLoop.id }))?.status, 200,
            "the real maintenance program concluded");
        const turns = await db.test_list_turns_in_loop.all<{ id: number; producer: string; kind: string; status: number }>({ loop_id: adminLoop.id });
        assert.deepEqual(turns.map(({ producer, kind, status }) => ({ producer, kind, status })), [
            { producer: "_plurnk", kind: "maintenance", status: 200 },
        ]);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/tool.md", scheme: "workspace", name: "body",
        });
        assert.equal(doc?.content, engine.documents[0].content, "the program actually materialized its resource");
        const source = await db.test_log_sequencees_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turns[0].id });
        assert.ok(source.some(({ op, status_rx }) => op === "EDIT" && status_rx === 201), "the source operation receipt remains durable");
        assert.equal(await db.engine_session_has_undelivered_child_term.get({ session_id: parentId }), undefined,
            "housekeeping is not an unobserved child result that can wake waiting work or refuse completion");

        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Child documentation observed.")] } }] }),
            workspaceId, sessionId: parentId, loopId: parentLoopId,
            messages: [{ role: "system", content: "Observe the child." }, { role: "user", content: "continue" }],
        });
        assert.equal(result.status, 200);
        const rows = await db.engine_render_log.all<{ source: string | null }>({ session_id: parentId });
        assert.deepEqual(rows.filter((row) => row.source === "session://child"), [],
            "the parent's real packet path contains no invented child deliverable");
    } finally { await db.close(); }
});

test("{§tools-resource-materialization} session documentation materialization removes stale generated entries", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-${crypto.randomUUID()}`);
        await insertSession(db, workspaceId);
        const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            scheme: "workspace",
            authority: "",
            pathname,
        });

        engine.documents = [
            { pathname: "/_plurnk/plurnk/retired.md", content: "# Retired" },
            { pathname: "/_plurnk/plurnk/tool-retired.md", content: "# Retired tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.notEqual(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);

        engine.documents = [
            { pathname: "/_plurnk/plurnk/current.md", content: "# Current" },
            { pathname: "/_plurnk/plurnk/tool-current.md", content: "# Current tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.equal(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/current.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-current.md"), undefined);
    } finally {
        await db.close();
    }
});

for (const runtime of ["sh", "js", "python3"]) test(`{§op-shapes}: installed ${runtime} examples and fenced README programs preserve executor/target ownership`, async (t) => {
    const executors = await testExecutors();
    if (!executors.availableRuntimes().includes(runtime)) return t.skip(`${runtime} is not installed`);
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const workspaceId = await insertWorkspace(db, `${runtime}-doc-invocations`);
        await insertSession(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: `/_plurnk/plurnk/${runtime}.md`, scheme: "workspace", name: "body",
        });
        assert.ok(doc, "the installed executor's documentation reaches the session");
        const readme = await readFile(new URL("README.md", import.meta.resolve("@plurnk/plurnk-execs-common/package.json")), "utf8");
        const examples = [doc.content, readme].flatMap((content) => Lexer.lex(content)
            .filter((token) => token.type === "code" && token.lang?.split(/[ \t]/)[0] === runtime));
        assert.ok(examples.length > 0, `${runtime} has executable examples`);
        const execs = examples.flatMap(({ raw }) => {
            const parsed = PlurnkParser.parseStatements(raw, { executors: fixtureExecutors(raw) });
            assert.equal(parsed.unparsedTail, undefined, raw);
            assert.equal(parsed.items.length, 1, raw);
            assert.equal(parsed.items[0]?.kind, "statement", raw);
            return parsed.items.flatMap((item) => item.kind === "statement" && isExecution(item.statement) ? [item.statement] : []);
        });
        assert.ok(execs.length > 0);
        assert.ok(execs.every((statement) => statement.runtime === runtime), `${runtime} is the runtime, never the input target`);
        assert.ok(execs.some(({ target }) => target === null), `${runtime} demonstrates the no-target form`);
        if (runtime !== "js") assert.ok(execs.some(({ target }) => target?.kind === "local"), `${runtime} demonstrates a local script target`);
    } finally { await db.close(); }
});

test("{§tools-resource-materialization} an unchanged generated surface dispatches nothing on re-materialization", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-idem-${crypto.randomUUID()}`);
        await insertSession(db, workspaceId);
        engine.documents = [
            { pathname: "/_plurnk/plurnk/stable.md", content: "# Stable" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        const runtime = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "_plurnk" });
        assert.ok(runtime !== undefined, "maintenance has its actual runtime actor");
        const before = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: runtime.id });
        assert.ok(before !== undefined, "initial materialization recorded a maintenance loop");

        await LoopDocs.materialize(engine, db, workspaceId);
        const after = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: runtime.id });
        assert.equal(after?.id, before?.id, "the unchanged surface re-dispatches nothing — no new _plurnk turn, no 304 churn");
    } finally {
        await db.close();
    }
});

test("{§exec-stream}: materialized shell documentation demonstrates scoped READ of an execution stream", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, "shell-doc-stream-read");
        await insertSession(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/sh.md", scheme: "workspace", name: "body",
        });
        assert.ok(doc, "the installed shell's documentation reaches the session");
        const examples = Lexer.lex(doc.content).flatMap((token) =>
            token.type === "code" && token.lang?.startsWith("READ ") ? [token.raw] : []);
        const reads = examples.flatMap((source) => {
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            assert.equal(parsed.unparsedTail, undefined, source);
            assert.equal(parsed.items.length, 1, source);
            assert.equal(parsed.items[0]?.kind, "statement", source);
            return parsed.items.flatMap((item) => item.kind === "statement" && item.statement.op === "READ" ? [item.statement] : []);
        });
        assert.ok(reads.length > 0, "the doc demonstrates fetching beyond the terminal observation");
        for (const read of reads) {
            assert.equal(read.target?.kind, "url");
            if (read.target?.kind !== "url") throw new Error("The stream example must address a resource");
            assert.equal(read.target.scheme, "sh");
            assert.match(read.target.pathname, /^\/[a-f0-9]{8}$/);
            assert.equal(read.target.fragment, "stdout");
            assert.equal(read.lineMarker?.marks.length, 2, "the example selects a line interval");
        }
    } finally { await db.close(); }
});
});

describe("note12-docs", () => {
class DocStub {
    static manifest = {
        name: "docstub", channels: { body: "text/plain" }, defaultChannel: "body",
        category: "data", writableBy: ["model"], volatile: false, modelVisible: true,
        documentation: "# docstub\n\n## Summary\n\nRead docstub resources.\n\nFuller reference content.",
    };
}

test("{§tools-resource-materialization}: scheme references preserve documentation without redundant entries", async () => {
    const registry = new SchemeRegistry();
    registry.register("docstub", new DocStub());

    const docs = await registry.docs();
    const stub = docs.find((d) => d.name === "docstub");
    assert.equal(stub?.content, "# docstub\n\n## Summary\n\nRead docstub resources.\n\nFuller reference content.", "docs() carries the content the scheme reference materializes");
    assert.equal(docs.some(({ name }) => name === "log"), false, "the self-evident log resource adds no redundant pull doc");

    assert.equal(docs.some(({ name }) => name === "skill"), false, "an unregistered scheme contributes no reference");
});
});

describe("operation-replay", () => {
const frame = PlurnkParser.frame;
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });

test("{§emission-history} {§emission-history}: a turn's content operations precede their results without duplicating their requests", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "paired-operations");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Write, inspect, and answer.");
    const edit = frame("EDIT (workspace:///memo.txt)", "Unique replacement.");
    const read = frame("READ (workspace:///memo.txt) <!-- inspect -->", null);
    const note = frame("NOTE", "An authored memory.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say([edit, read, note].join("\n\n"), frame("NOTE", "Reasoning is not content.")),
        say(frame("SEND [200]", "Done.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 3 });
    const request = provider.received[1];
    assert.deepEqual(request.filter(({ role }) => role === "assistant").map(chatMessageText), [[edit, read, note].join("\n\n")],
        "the turn's operations replay together, in program order, as one assistant message");
    const at = request.findIndex(({ role }) => role === "assistant");
    assert.equal(request[at + 1].role, "user");
    const records = chatMessageText(request[at + 1]).split(/\n\n(?=### log:)/u).filter((record) => /^### log:\/\/\/1\/2\/\d+\/(?:EDIT|READ|NOTE) /u.test(record));
    const operations = { EDIT: edit, READ: read, NOTE: note } as const;
    assert.deepEqual(records.map((record) => /\/(EDIT|READ|NOTE) /u.exec(record)![1]), ["EDIT", "READ", "NOTE"], "the turn's receipts follow it, in order");
    for (const record of records) {
        const op = /\/(EDIT|READ|NOTE) /u.exec(record)![1] as keyof typeof operations;
        assert.doesNotMatch(record, /"aside"/u, "the aside stays with the replayed operation");
        if (op !== "NOTE") assert.match(record.split("\n")[0], / \(workspace:\/\/\/memo\.txt\) · \d+$/u, "the receipt names its operand");
        if (op === "NOTE") assert.doesNotMatch(record, /An authored memory/u);
        else assert.match(record, /Unique replacement\./u, "landed edit windows and READ output are returned evidence, not suppressed request bodies");
        const head = record.split("\n\n")[0];
        assert.equal(Number(/ · (\d+)/u.exec(head)![1]), contentWeight(head) + contentWeight(operations[op]), "the curation charge owns the complete operation and receipt once");
    }
    assert.match(request.filter(({ role }) => role === "user").map(chatMessageText).join("\n"), /Reasoning is not content\./u);
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source!.content, [edit, read, note].join("\n\n"));
});

test("{§op-shapes}: failed retrievals retain their annotations independently, without promoting reasoning into content", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "failed-annotation");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Inspect the available evidence.");
    const source = frame("READ (workspace:///absent.txt)", "/not-a-pattern/");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(source, frame("READ (workspace:///also-absent.txt)", "Reasoning annotation.")),
        say(frame("SEND [200]", "Neither resource exists.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 3 });
    const request = provider.received[1];
    assert.deepEqual(request.filter(({ role }) => role === "assistant").map(chatMessageText), [[frame("NOTE", "/not-a-pattern/"), frame("READ (workspace:///absent.txt)", null)].join("\n\n")]);
    const user = request.filter(({ role }) => role === "user").map(chatMessageText).join("\n");
    assert.match(user, /Reasoning annotation\./u);
    assert.match(user, /also-absent\.txt/u);
    assert.doesNotMatch(user, /not-a-pattern/u);
    assert.equal([...user.matchAll(/"status":404/gu)].length >= 2, true);
    const notes = await db.test_log_entries_by_session_op_full.all<{ tx: string }>({ session_id: sessionId, op: "NOTE" });
    assert.ok(notes.some(({ tx }) => JSON.parse(tx).body === "/not-a-pattern/"));
});

test("{§emission-history} {§op-methods-op-dispatch}: one glob replay owns concrete receipts, including failures", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "paired-fanout");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Inspect the notes.");
    const glob = frame("READ (workspace:///case-*.txt)", null);
    const missing = frame("READ (workspace:///absent.txt)", null);
    const copy = frame("COPY (workspace:///case-a.*) (workspace:///copy.txt)", null);
    const provider = new Mock({ contextWindow: 100000, responses: [
        say([frame("EDIT (workspace:///case-a.txt)", "First."), frame("EDIT (workspace:///case-b.txt)", "Second.")].join("\n\n")),
        say(`${glob}\n\n${missing}\n\n${copy}`), say(frame("SEND [200]", "The missing note was absent.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
    const request = provider.received[2];
    const index = request.findIndex((message) => message.role === "assistant" && chatMessageText(message) === [glob, missing, copy].join("\n\n"));
    assert.notEqual(index, -1, "the turn replays as one message");
    assert.equal(request.filter((message) => message.role === "assistant" && chatMessageText(message).includes(glob)).length, 1, "the glob replays once");
    const receipts = chatMessageText(request[index + 1]);
    assert.match(receipts, /case-a\.txt[\s\S]*First\.[\s\S]*case-b\.txt[\s\S]*Second\./u, "the glob owns its concrete receipts");
    assert.match(receipts, /"status":404/u, "the failed READ's receipt follows with the turn's others");
    assert.match(receipts, /^### log:\/\/\/1\/3\/\d+\/COPY \(workspace:\/\/\/case-a\.txt\) \(workspace:\/\/\/copy\.txt\)/mu, "resolved transfer operands are new result facts");
});
});

describe("problem-log", () => {
test("{§operation-results} ProblemLog persists one self-identifying RFC 9457 operation failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-problem-log-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, `problem-log-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 3, "test");
        const turnId = await insertTurn(db, loopId, 4, 102);
        const minted = await new ProblemLog(db, (text) => Math.ceil(text.length / 2)).record({
            sessionId,
            loopId,
            turnId,
            sequence: 5,
            origin: "_plurnk",
            source: "rail",
            result: Results.failure(
                "engine:rail",
                "test-failure",
                409,
                "The test contract failed.",
                {},
                { retryable: false },
            ),
        });

        Validator.assertOperationResult(minted.result);
        assert.deepEqual(minted.result, {
            status: 409,
            problem: {
                type: "https://problems.plurnk.xyz/engine/rail/test-failure",
                title: "Test failure",
                status: 409,
                detail: "The test contract failed.",
                retryable: false,
                instance: "log:///3/4/5/error",
            },
        });
        const [row] = await db.test_error_rows_for_session.all<{ rx: string; weight: number }>({ session_id: sessionId });
        assert.deepEqual(JSON.parse(row.rx), minted.result, "the returned and durable failure are identical");
        assert.equal(row.weight, 0, "the metadata-only Problem has no canonical body weight");
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{ problem?: unknown }>;
        };
        assert.deepEqual(
            digest.log_entries[0]?.problem,
            minted.result.problem,
            "the digest preserves the same complete Problem occurrence",
        );
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("resource-state-soak", () => {
const execFileP = promisify(execFile);

test("{§test-artifact-retention} soak: N turn boundaries with per-turn membership re-resolution — zero growth, zero violations, every boundary", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-soak-"));
    const db = await openMigrated();
    try {
        // A real git workspace: three tracked members.
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        for (const f of ["a.md", "b.md", "sub-c.md"]) await writeFile(join(root, f), `# ${f}\n`);
        await execFileP("git", ["add", "-A"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `soak-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const ctx: PlurnkSchemeContext = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const TURNS = 6;
        const responses = Array.from({ length: TURNS }, (_, i) => ({
            assistant: {
                content: `${i % 2 === 0 ? "````READ (a.md)````" : "````FIND (**)````"}
\`\`\`\`NOTE
continue
\`\`\`\``,
                reasoning: null,
            },
        }));
        const provider = new Mock({ contextWindow: viableWindow(), responses });

        const loopId = await insertLoop(db, sessionId, 1, "soak");
        let baseline: number | null = null;
        for (let turn = 1; turn <= TURNS; turn++) {
            // the per-turn membership pass
            await GitMembership.indexGitMembership(ctx);
            const r = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
            assert.ok(r.status < 500, `turn ${turn} completed (${r.status})`);
            const count = await ResourceState.entryCount(db);
            if (baseline === null) baseline = count;
            else assert.equal(count, baseline, `turn ${turn}: read-only turns grow the entries table by ZERO`);
            const violations = await ResourceState.check(db);
            assert.deepEqual(violations, [], `turn ${turn}: resource invariants hold at every boundary`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
});
