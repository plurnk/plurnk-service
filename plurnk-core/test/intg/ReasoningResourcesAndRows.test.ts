import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import LogEntry from "../../src/server/logEntry.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, ModelProvider } from "@plurnk/plurnk-providers";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { statement, providerWithCapacity, type Read, type Resource, original as fixtureOriginal, provider as fixtureProvider } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import { tmpdir } from "node:os";
import { RESULT_EXCEEDS_BUDGET } from "../../src/core/ContextFit.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { SessionTranslator } from "@plurnk/plurnk-acp";


describe("reasoning-budget", () => {
const task = "await plurnk.note({\"text\":\"Review the result.\"});";

for (const mode of ["fits", "receipt"] as const) test(`{§turn-source-resources} {§tokenomics}: an explicit reasoning READ is exact — ${mode === "fits" ? "whole when it fits" : "a bodiless receipt when it does not"}`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-budget-${mode}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the reasoning across successive turns.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId, messages: [] };
        const reasoning = Array.from({ length: 120 }, (_, index) => `Finding ${index + 1}: ${"evidence ".repeat(mode === "receipt" ? 100 : 2)}`).join("\n");
        const capacity = mode === "fits" ? 999_000 : 20_000;
        const first = await engine.runTurn({ ...context, provider: providerWithCapacity(capacity, [
            { assistant: { content: `await plurnk.read({"path":"reasoning://alice/1/2","range":"1,-1"}); // retain reasoning\n\n${task}`, reasoning } },
        ]) });
        const initial = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).find(({ pathname }) => pathname === "/1/2")!;
        assert.equal(initial.turn_seq, 2);
        assert.deepEqual(JSON.parse(initial.lineMarker), { marks: [1, -1] }, "an explicit READ never substitutes a smaller scope");
        const rx = JSON.parse(initial.rx) as { status: number; content: string | null; problem?: { type: string; lines: number; tokens: number; remaining: number } };
        if (mode === "fits") {
            assert.equal(rx.status, 200);
            assert.equal(rx.content, reasoning, "the whole source, exactly");
        } else {
            assert.equal(rx.status, 413, "the explicit scope is exact: it did not fit, so the row is its receipt above what fit");
            if (rx.content !== null) assert.ok(reasoning.startsWith(rx.content) && ((rx.problem as { delivered?: number } | undefined)?.delivered ?? 0) > 0, "the body is the longest prefix of lines that fit");
            assert.equal(rx.problem?.type, RESULT_EXCEEDS_BUDGET);
            assert.equal(rx.problem?.lines, 120, "the receipt names the size");
            assert.ok(rx.problem.tokens > rx.problem.remaining, "and what remained");
        }
        const firstPacket = (await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet;
        const provider = providerWithCapacity(capacity, [
            { assistant: { content: task, reasoning: "This later source is not requested." } },
            { assistant: { content: task, reasoning: null } },
        ]);
        const next = await engine.runTurn({ ...context, provider });
        assert.equal(next.status, 102);
        assert.equal(next.createdTurnIds.length, 1);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const record = logEntries(packet).find(({ logPath }) => /^log:\/\/\/1\/2\/\d+\/read$/u.test(logPath))!;
        assert.ok(record);
        assert.equal(record.aside, undefined);
        assert.ok(packetSection(packet, "emission-history").includes("plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"1,-1\"}) // retain reasoning"),
            "the paired operation retains the requested source, scope and aside");
        if (mode === "fits") {
            assert.match(String(record.body), /120:Finding 120:/);
            assert.equal(record.preview, undefined);
        } else {
            assert.equal(record.status, 413, "the receipt rides the next packet");
            assert.doesNotMatch((record.body ?? ""), /120:Finding 120:/, "the whole never arrives; at most the prefix that fit");
            // Source identity never depends on the reader ({§turn-source-resources}); alice's READs and packets are counted below.
            const observer = await insertSession(db, workspaceId, null, "observer");
            const range = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement("await plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"1,10\"});") });
            assert.equal(range.status, 200, "a range READ of the source still works ({§tokenomics})");
            assert.ok("content" in range);
            assert.equal(range.content, reasoning.split("\n").slice(0, 10).join("\n"));
            const source = (await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }))[0];
            assert.equal(source.content, reasoning, "the source stays whole");
        }
        const later = await engine.runTurn({ ...context, provider });
        assert.equal(later.status, 102);
        const laterPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: later.turnId }))!.packet);
        const laterRecord = logEntries(laterPacket).find(({ logPath }) => logPath === record.logPath)!;
        assert.equal(laterRecord.body, record.body, "no automatic re-READ or restoration follows a receipt");
        const reads = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).filter(({ pathname }) => pathname === "/1/2");
        assert.equal(reads.length, 1);
        assert.equal(reads[0].id, initial.id);
        assert.equal(reads[0].active, 1);
        assert.equal(reads[0].folded, "[]");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
    } finally { await db.close(); }
});
});

describe("reasoning-observation", () => {
const next = "await plurnk.note({\"text\":\"Continue.\"});";

test("{§session-initialization-entry}: initialization is an ordinary `_plurnk` operation turn — its survey runs as a program, authors no reasoning, and fabricates no emission", async () => {
    const db = await openMigrated();
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        const workspaceId = await insertWorkspace(db, "ops-bootstrap");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        // A workspace entry, so the workspace survey selects something and the initialization program exists.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
        const loopId = await insertLoop(db, sessionId, 3, "Inspect the initial program.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: next, reasoning: "Unrequested model reasoning." } }] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 102, "the initialization surveys do not change implicit continuation");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        assert.equal(logEntries(packet).find((row) => row.path === "reasoning://alice/3/1"), undefined, "no reasoning is authored, so nothing reads it back");
        assert.deepEqual(await db.test_reasoning_reads.all<Read>({ session_id: sessionId }), [], "initialization performs no reasoning READ");
        // Read as another session: alice's own reads and packets are what this test counts.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const reasoning = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement("await plurnk.read({\"path\":\"reasoning://alice/3/1\",\"range\":\"1,-1\"});") });
        assert.equal(reasoning.status, 204, "the initialization turn has no reasoning source");
        const program = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement("await plurnk.read({\"path\":\"ops://alice/3/1\",\"range\":\"1,-1\"});") });
        assert.equal(program.status, 200, "the survey is the turn's ops source, the program that ran");
        assert.ok("content" in program && typeof program.content === "string");
        const operations = PlurnkParser.parseStatements(program.content).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.ok(operations.some(({ op }) => op === "find"));
        assert.ok(!operations.some((operation) => operation.op === "read" && operation.target?.raw.startsWith("reasoning://")), "no READ of its own reasoning");
        assert.doesNotMatch(program.content, /READ \(prompt:\/\//, "the prompt arrives as its row, never as a second READ");
        assert.deepEqual(
            provider.received[0].filter(({ role }) => role === "assistant"),
            [{ role: "assistant", content: program.content }],
            "the initialization survey replays as the opening assistant turn in emission-history ({§emission-history})",
        );
        assert.equal(provider.received.length, 1, "the survey costs no model inference");
    } finally {
        await db.close();
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});

test("{§turn-source-resources}: a model READ of its own reasoning settles in that turn and is retained for the next request", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-current");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the fact.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const read = "plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"2,2\"}) // retain this determination";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: `${read}\n\n${next}`, reasoning: "first\nselected reasoning\nlast" } },
            { assistant: { content: next, reasoning: "Not requested." } },
        ] });
        const produced = await engine.runTurn({ ...context, provider, messages: [] });
        const before = await db.test_reasoning_reads.all<Read>({ session_id: sessionId });
        const observation = before.find(({ pathname }) => pathname === "/1/2");
        assert.ok(observation);
        assert.equal(observation.turn_id, produced.turnId);
        const result = JSON.parse(observation.rx);
        assert.equal(result.status, 200, "the READ is complete before any later model turn exists");
        assert.equal(result.content, "selected reasoning");
        const observer = await insertSession(db, workspaceId, null, "observer");
        assert.deepEqual(result, await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(read) }));
        const firstPacket = (await db.test_get_packet.get<{ packet: string }>({ id: produced.turnId }))!.packet;
        const observed = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: observed.turnId }))!.packet);
        const receipt = logEntries(packet).find((row) => /^log:\/\/\/1\/2\/\d+\/read$/u.test(row.logPath));
        assert.ok(receipt);
        assert.equal(receipt.aside, undefined);
        assert.ok(packetSection(packet, "emission-history").includes(read), "the paired operation retains the source, scope and aside");
        assert.match(String(receipt.body), /selected reasoning/);
        assert.deepEqual(await db.test_reasoning_reads.all<Read>({ session_id: sessionId }), before, "later inference neither adds nor updates reasoning READs");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: produced.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
        const absent = await engine.dispatch({ ...context, turnId: observed.turnId, sequence: 50, origin: "model",
            statement: statement("await plurnk.read({\"path\":\"reasoning://alice/1/4\",\"range\":\"1,-1\"});"),
        });
        assert.equal(absent.status, 404, "future coordinates do not create acquisition obligations");
        assert.equal(absent.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/entry-not-found");
    } finally { await db.close(); }
});
});

describe("reasoning-operations", () => {

for (const operation of [
    { name: "note", source: "await plurnk.note({\"text\":\"Retain this conclusion.\"});" },
    { name: "find", source: "await plurnk.find({\"path\":\"workspace:///fact.txt\"});" },
    { name: "read", source: "await plurnk.read({\"path\":\"workspace:///fact.txt\"});" },
]) test(`{§turn-source-resources}: reasoning ${operation.name} fence is inert text`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-inert");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the fact.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Observed fact." });
        const reasoning = `Some deliberation.\n\n${operation.source}`;
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "await plurnk.done({\"text\":\"Done.\"});", reasoning } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
        const outcomes = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(outcomes.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]),
            [["done", 200]], "only the content operation ran; reasoning fences never execute");
        const reads = await db.test_reasoning_reads.all<{ origin: string; pathname: string; turn_id: number; rx: string }>({ session_id: sessionId });
        assert.deepEqual(reads.filter(({ origin }) => origin === "_plurnk"), []);
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.ok(sources.some(({ turn_id, kind, content }) => turn_id === result.turnId && kind === "reasoning" && content === reasoning),
            "the complete original reasoning remains available for deliberate READs");
    } finally {
        await db.close();
    }
});

for (const tagged of [false, true]) test(`{§turn-source-resources} {§op-shapes}: ${tagged ? "tagged" : "structured"} HTTP reasoning completes with final usage before content operations execute`, async () => {
    const db = await openMigrated();
    const firstReasoning = "await plurnk.read({\"path\":\"workspace:///fact.txt\",\"range\":\"1,-1\"});\n\nMore deliberation.\n";
    const laterReasoning = "await plurnk.note({\"text\":\"Retain the later thought.\"});\n\nawait plurnk.find({\"path\":\"workspace:///fact.txt\"});";
    const content = `plurnk.read({"path":"workspace:///fact.txt","range":"1,-1"})\n\nplurnk.note({"text":"Content also survives."})`;
    const charge = { kind: "charged", amount: { amount: "0.0123", currency: "USD" }, source: "fixture settlement" } as const;
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let prematureClose = false;
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.on("close", () => { prematureClose ||= !response.writableEnded; });
        const emit = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
            id: `request-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
        if (requests.length === 1) {
            emit(tagged ? { content: "<think>" + firstReasoning } : { reasoning_content: firstReasoning });
            await release.promise;
            emit(tagged ? { content: laterReasoning + "</think>" } : { reasoning_content: laterReasoning });
            emit({ content }, "stop");
        } else {
            emit({ content: "await plurnk.done({\"text\":\"The fact is established.\"});" }, "stop");
        }
        response.write(`data: ${JSON.stringify({
            choices: [], charge, usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160,
                prompt_tokens_details: { cached_tokens: 80 } },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    let running: ReturnType<Engine["runTurn"]> | undefined;
    try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const workspaceId = await insertWorkspace(db, "reasoning-completion");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Read the fact and report it.");
        const context = { workspaceId, sessionId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Established fact." });
        const phases: string[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            reasoningEventNotify: (_workspace, event) => {
                phases.push(event.phase);
                if (event.phase === "content") observed.resolve();
            },
        });
        const provider = new ModelProvider({ model: "fixture", url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
            contextWindow: 100_000, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null }, rawBody: true,
            normalizeCost: ({ charge: value }) => value as typeof charge | undefined,
            ...(tagged ? { reasoningResponseStyle: "think-tags" as const } : {}),
        });
        running = engine.runTurn({ ...context, provider, messages: [] });
        await Promise.race([observed.promise, running.then(() => assert.fail("response ended before reasoning was observed"))]);
        const pendingReads = await db.test_log_entries_by_session_op_full.all<{ pathname: string }>({ session_id: sessionId, op: "read" });
        assert.deepEqual(pendingReads.filter(({ pathname }) => pathname === "/fact.txt"), [],
            "streaming an operation does not dispatch it before response completion");
        release.resolve();
        const first = await running;
        assert.equal(first.status, 102);
        assert.equal(prematureClose, false, "streaming reasoning must not disconnect the provider request");
        assert.deepEqual(phases, ["start", "content", "content", "end"]);
        const accounting = await db.test_provider_requests.all<{ outcome: string; usage_input: number; usage_output: number; usage_input_cache_read: number; cost_kind: string; cost_amount: string; cost_currency: string }>({ turn_id: first.turnId });
        assert.equal(accounting.length, 1, "one physical request, no retry or restart");
        assert.deepEqual(accounting.map(({ outcome, usage_input, usage_output, usage_input_cache_read }) =>
            ({ outcome, usage_input, usage_output, usage_input_cache_read })),
        [{ outcome: "response", usage_input: 120, usage_output: 40, usage_input_cache_read: 80 }]);
        assert.deepEqual(accounting.map(({ cost_kind, cost_amount, cost_currency }) => ({ cost_kind, cost_amount, cost_currency })),
            [{ cost_kind: "charged", cost_amount: "0.0123", cost_currency: "USD" }], "the final provider charge is retained, not estimated");
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        assert.ok(sources.some((source) => source.kind === "reasoning" && source.content === firstReasoning + laterReasoning));
        assert.ok(sources.some((source) => source.kind === "ops" && source.content === content));
        assert.equal(sources.filter((source) => source.kind === "note" && source.content === "Content also survives.").length, 1);
        assert.equal(sources.filter((source) => source.kind === "note" && source.content === "Retain the later thought.").length, 0);
        const rows = await db.test_log_entries_by_session_op_full.all<{ pathname: string }>({ session_id: sessionId, op: "read" });
        assert.equal(rows.filter(({ pathname }) => pathname === "/fact.txt").length, 1, "content READ executes once; reasoning READ does not");
        const second = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(second.status, 200);
        assert.equal(requests.length, 2);
        assert.match(JSON.stringify(requests[1].messages), /Established fact/u);
        assert.deepEqual(requests[1].messages.map(({ role }) => role), ["system", "user", "assistant", "user"]);
        assert.deepEqual(requests[1].messages.filter(({ role }) => role === "assistant").map(({ content: text }) => text), [content],
            "{§emission-history}: the content emission is the turn's replay");
    } finally {
        release.resolve();
        try { await running; } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await db.close();
        }
    }
});
});

describe("reasoning-resources", () => {
const original = fixtureOriginal;
const provider = fixtureProvider;

test("{§turn-source-resources}: model sources are read-only and hash-free; log observations remain curatable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-resources");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the fact.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const first = await engine.runTurn({ ...context, provider: provider(original,
            "await plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"1,-1\"});"), messages: [] });
        const resources = await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId });
        assert.deepEqual(resources, [{ pathname: `/1/${turn!.sequence}`, content: original }]);
        const target = `reasoning://alice${resources[0].pathname}`;
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const reads = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).filter(({ pathname }) => pathname === "/1/2");
        assert.equal(reads.length, 1);
        const read = reads[0];
        assert.equal(read.origin, "model");
        assert.deepEqual(JSON.parse(read.lineMarker), { marks: [1, -1] });
        const result = JSON.parse(read.rx) as { content: string; lineAnchors?: string[] };
        assert.equal(result.content, original);
        assert.equal(Object.hasOwn(result, "lineAnchors"), false, "read-only sources do not advertise editable anchors");
        assert.equal(Object.hasOwn(result, "lineNumberWidth"), false);
        const receipt = `log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/read`;
        let sequence = 50;
        const dispatch = (source: string) => engine.dispatch({ ...context, statement: statement(source), turnId: next.turnId, sequence: sequence++, origin: "model" });
        const copy = "session://alice/reasoning-notes.txt";
        assert.equal((await dispatch(`await plurnk.copy({"from":"${target}","to":"${copy}"});`)).status, 201);
        const copied = await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname: "/reasoning-notes.txt", name: "body" });
        assert.equal(copied?.content, original);
        assert.equal(copied?.mimetype, "text/markdown", "COPY uses the destination type without rewriting reasoning text");
        assert.equal((await dispatch(`await plurnk.copy({"from":{"path":"${target}","range":"2,3"},"to":"session://alice/reasoning-slice.md"});`)).status, 201);
        const slice = await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname: "/reasoning-slice.md", name: "body" });
        assert.equal(slice?.content, "Finding 2: evidence 2.\nFinding 3: evidence 3.\n", "COPY includes the selected lines' original terminators");
        assert.equal(slice?.mimetype, "text/markdown");
        for (const program of [
            `await plurnk.edit({"path":"${target}","range":"1","content":"Revised determination."});`,
            "await plurnk.edit({\"path\":\"reasoning://alice/9/9\",\"content\":\"Invented history.\"});",
            `await plurnk.kill({"path":"${target}"});`,
            `await plurnk.kill({"path":"${target}","range":"2"});`,
            `await plurnk.copy({"from":"${copy}","to":{"path":"${target}","range":"1,-1"}});`,
            `await plurnk.move({"from":"${target}","to":"session://alice/moved-reasoning.txt"});`,
            `await plurnk.move({"from":"${copy}","to":{"path":"${target}","range":"1,-1"}});`,
        ]) {
            const denied = await dispatch(program);
            assert.equal(denied.status, 403, program);
            assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden", program);
        }
        assert.deepEqual(await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }), resources);
        const explicit = await dispatch(`await plurnk.read({"path":"${target}","range":"2,3"});`);
        assert.equal(explicit.status, 200);
        assert.ok("content" in explicit);
        assert.equal(explicit.content, original.split("\n").slice(1, 3).join("\n"));
        assert.equal(Object.hasOwn(explicit, "lineAnchors"), false);
        const anchored = await dispatch(`await plurnk.read({"path":"${target}","range":"@abcde"});`);
        assert.equal(anchored.status, 400);
        assert.equal(anchored.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/line-anchor-unsupported");
        // Scratch is workspace-readable ({§session-scheme}); `log:///` is the reader's own log, so alice reads her receipt.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const editable = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(`await plurnk.read({"path":"${copy}","range":"1,-1"});`) });
        assert.equal(editable.status, 200, "a denied MOVE preserves its writable source");
        assert.ok("lineAnchors" in editable && Array.isArray(editable.lineAnchors));
        assert.equal(editable.lineAnchors.length, 30, "an ordinary editable copy still publishes anchors");
        const history = await clientRead(engine, db, { workspaceId, sessionId, statement: statement(`await plurnk.read({"path":"${receipt}","range":"1,-1"});`) });
        assert.ok("content" in history && "lineAnchors" in history && Array.isArray(history.lineAnchors));
        assert.equal(history.content, original);
        assert.equal(history.lineAnchors.length, 30, "explicit log READs retain anchors for line curation");
        assert.equal((await dispatch(`await plurnk.kill({"path":"${receipt}","range":"${history.lineAnchors[1]}"});`)).status, 200);
        assert.equal((await dispatch(`await plurnk.kill({"path":"${receipt}","range":"17,-1"});`)).status, 200);
        const curtailed = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).find(({ id }) => id === read.id);
        assert.ok(curtailed);
        assert.equal(curtailed.active, 1);
        assert.notEqual(curtailed.folded, "[]", "scoped log curation changes its projection");
        assert.equal(JSON.parse(curtailed.rx).content, original, "curation preserves durable observations");
        assert.equal((await dispatch(`await plurnk.kill({"path":"${receipt}"});`)).status, 200);
        assert.deepEqual(await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }), resources);
        const automaticBefore = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).filter(({ origin }) => origin === "_plurnk").length;
        await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const after = await db.test_reasoning_reads.all<Read>({ session_id: sessionId });
        assert.equal(after.filter(({ origin }) => origin === "_plurnk").length, automaticBefore, "log curation cannot cause automatic redelivery");
        assert.equal(after.find(({ id }) => id === read.id)?.active, 0);
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: first.turnId });
        assert.equal(JSON.parse(packet!.packet).assistant.reasoning, original);
    } finally { await db.close(); }
});

test("{§turn-source-resources}: immutable sources support search, FORK, restart, and independent receipt curation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-reasoning-resources-"));
    const dbPath = join(dir, "plurnk.db");
    let db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-lifecycle");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const unrelatedId = await insertSession(db, workspaceId, null, "unrelated");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the fact.");
        const schemes = new SchemeRegistry();
        let engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const producing = await engine.runTurn({ ...context, provider: provider(original,
            `await plurnk.read({"path":"reasoning://alice/1/2","range":"1,-1"});\n\nawait plurnk.send({"text":"Ready."});`), messages: [] });
        const resource = (await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }))[0];
        const target = `reasoning://alice${resource.pathname}`;
        let sequence = 20;
        const dispatch = (source: string) => engine.dispatch({ ...context,
            statement: statement(source), turnId: producing.turnId, sequence: sequence++, origin: "model",
        });
        const clientDispatch = async (source: string, owner = context) => {
            const turn = await Turn.open(db, { loopId: owner.loopId, producer: "client", kind: "operation" });
            const result = await engine.dispatch({ ...owner, statement: statement(source), turnId: turn.id, sequence: 1, origin: "client" });
            await Turn.complete(db, turn.id, result.status);
            return result;
        };
        const shared = await clientRead(engine, db, { workspaceId, sessionId: unrelatedId, statement: statement(`await plurnk.read({"path":"${target}","range":"1,-1"});`) });
        assert.equal(shared.status, 200);
        assert.equal(shared.content, original, "an explicit source address identifies the same evidence for every workspace session");
        assert.equal((await clientDispatch(`await plurnk.edit({"path":"${target}","range":"1","content":"Retained determination."});`)).status, 403);
        const found = await dispatch(`await plurnk.find({"path":"${target}","pattern":"~\\"Finding 2\\""});`);
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.ok("matchLocationCount" in found);
        assert.equal(found.matchLocationCount, 1);
        const forkId = await Fork.fork(db, sessionId, "reasoning-branch");
        const forkLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: forkId });
        assert.ok(forkLoop);
        const forkContext = { workspaceId, sessionId: forkId, loopId: forkLoop.id };
        await engine.runTurn({ ...forkContext, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ session_id: forkId })).filter(({ pathname }) => pathname === "/1/2").length, 1,
            "the fork inherits the existing ordinary observation without requesting another");
        assert.equal((await clientDispatch(`await plurnk.edit({"path":"${target}","range":"1","content":"Branch-only decision."});`, forkContext)).status, 403);
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }))[0].content, original);
        const stillFound = await dispatch(`await plurnk.find({"path":"${target}","pattern":"~\\"Finding 2\\""});`);
        assert.equal(stillFound.status, 200, "denied writes leave indexed source unchanged");
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const observations = await db.test_reasoning_reads.all<Read>({ session_id: sessionId });
        const read = observations.find(({ pathname, ambient_event_id }) => pathname === "/1/2" && ambient_event_id === null);
        assert.ok(read, "the parent's deliberate READ retains its own observation identity");
        assert.equal(JSON.parse(read.rx).content, original);
        assert.equal((await engine.dispatch({ ...context, turnId: next.turnId, sequence: 30, origin: "model",
            statement: statement(`await plurnk.kill({"path":"log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/read"});`),
        })).status, 200);
        const forkAfterRead = await Fork.fork(db, sessionId, "already-observed");
        await db.close();
        db = await openMigrated(dbPath);
        engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ session_id: forkId }))[0].content, original);
        const secondForkLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: forkAfterRead });
        assert.ok(secondForkLoop);
        await engine.runTurn({ workspaceId, sessionId: forkAfterRead, loopId: secondForkLoop.id, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ session_id: forkAfterRead })).filter(({ pathname, ambient_event_id }) => pathname === "/1/2" && ambient_event_id === null).length, 1,
            "fork and restart never automatically reread a KILLed observation");
        assert.equal((await clientDispatch(`await plurnk.kill({"path":"${target}"});`)).status, 403);
        const ids = await db.test_log_entries_by_turn.all<{ id: number }>({ turn_id: producing.turnId });
        const journal = await Promise.all(ids.map(({ id }) => LogEntry.fetchLogEntry(db, id)));
        const replayed = SessionTranslator.replay(
            new SessionTranslator({ acpSessionId: "history", workspaceId, sessionId, origin: "http://acp.test" }),
            journal,
            [],
            { historyLoops: 5 },
        );
        assert.deepEqual(
            replayed.updates
                .filter(({ update }) => update.sessionUpdate === "agent_thought_chunk")
                .map(({ update }) => {
                    const content = (update as { content?: { type?: string; text?: string } }).content;
                    return content?.type === "text" ? content.text : null;
                }),
            [original],
        );
        const digestDir = join(dir, "digest");
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir, sessionId });
        const evidence = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.ok(evidence.includes(original));
        assert.ok(!evidence.includes("Revised conclusion."), "denied source edits cannot alter forensic reasoning");
        // Only a reader with its own 1/2 source can witness substitution, and a client READ joins its reader's log:
        // alice reads last, after her history has been counted and forked.
        assert.equal((await clientRead(engine, db, { workspaceId, sessionId, statement: statement("await plurnk.read({\"path\":\"reasoning://unrelated/1/2\"});") })).status, 404,
            "an address never substitutes another session's history for a missing source");
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§turn-source-resources}: only exposed final reasoning becomes a resource at its producing turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-admission");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the fact.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId, messages: [] };
        for (const reasoning of [null, ""]) await engine.runTurn({ ...context, provider: provider(reasoning) });
        assert.deepEqual(await db.test_model_reasoning_resources.all({ session_id: sessionId }), []);
        const source = "await plurnk.note({\"text\":\"Continue.\"});";
        const admitted = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "await plurnk.read({\"path\":\"workspace:///invalid-program", reasoning: "Private rejected reasoning." } },
            { assistant: { content: source, reasoning: "Admitted reasoning." } },
        ] }) });
        assert.equal(admitted.emissionAttempts, 2);
        const failed = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "await plurnk.read({\"path\":\"workspace:///first-invalid-program", reasoning: "First private reasoning." } },
            { assistant: { content: "await plurnk.read({\"path\":\"workspace:///last-invalid-program", reasoning: "Final rejected reasoning." } },
        ] }) });
        assert.equal(failed.emissionExhausted, true);
        const rows = await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId });
        assert.deepEqual(rows.map(({ content }) => content), ["Admitted reasoning.", "Final rejected reasoning."]);
        const admittedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: admitted.turnId });
        const failedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: failed.turnId });
        assert.equal(rows[0].pathname, `/1/${admittedTurn!.sequence}`);
        assert.equal(rows[1].pathname, `/1/${failedTurn!.sequence}`);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: failed.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0]);
    } finally { await db.close(); }
});

test("{§turn-source-resources}: an existing turn without provider reasoning reads empty; a turn that does not exist is 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-empty");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the fact.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        // The provider returns no reasoning for the model's turn (1/2); the initialization turn (1/1) authors none either.
        const silent = await engine.runTurn({ ...context, provider: provider(null,
            `await plurnk.read({"path":"reasoning://alice/1/2","range":"1,-1"});\n\nawait plurnk.send({"text":"Ready."});`), messages: [] });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: silent.turnId });
        assert.equal(turn?.sequence, 2);
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId })).length, 0, "no substitute source is recorded");
        const own = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).find(({ pathname, turn_id }) => pathname === "/1/2" && turn_id === silent.turnId);
        assert.ok(own, "the model's READ of its own reasoning coordinate produced a receipt");
        // A client read opens a loop on its reader, and alice's loop 2 must stay absent: another session reads
        // ({§turn-source-resources}).
        const observer = await insertSession(db, workspaceId, null, "observer");
        const read = (source: string) => clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(source) });
        const empty = await read("await plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"1,-1\"});");
        assert.equal(empty.status, 204, "an existing turn with nothing from the provider reads as the ordinary empty resource");
        assert.ok("content" in empty);
        assert.equal(empty.content, "");
        const program = await read("await plurnk.read({\"path\":\"ops://alice/1/2\",\"range\":\"1,-1\"});");
        assert.equal(program.status, 200);
        assert.ok("content" in program && typeof program.content === "string" && program.content.includes("reasoning://alice/1/2"), "the same turn's admitted program is present");
        const future = await read("await plurnk.read({\"path\":\"reasoning://alice/1/9\",\"range\":\"1,-1\"});");
        assert.equal(future.status, 404, "a turn that has not happened is missing, not empty");
        assert.equal(future.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/entry-not-found");
        assert.equal((await read("await plurnk.read({\"path\":\"reasoning://alice/2/1\",\"range\":\"1,-1\"});")).status, 404, "so is a loop that does not exist");
    } finally { await db.close(); }
});
});

