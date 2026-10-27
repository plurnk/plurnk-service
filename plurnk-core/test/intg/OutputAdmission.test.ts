import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import Dsl from "./dsl.ts";
import Turn from "../../src/core/Turn.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, seedEntryWithChannel } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { Mock, type MockResponse, ModelProvider, type ProviderCost } from "@plurnk/plurnk-providers";
import { urlPath, readStmt } from "./_dsl.ts";
import { waitForDb, withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { serverProposals } from "./_approval.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeMockResponse } from "./_mock.ts";
import { assertContextFitEvidence, seedAttachmentFixture } from "./_context-fit.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { clientRead } from "./_client-read.ts";

describe("cancellation-accounting", () => {
for (const reported of [false, true]) {
    for (const stop of ["KILL", "shutdown"] as const) {
        test(`{§tokenomics} ${stop} retains cancelled child accounting; reported=${reported} (#971)`, async () => {
            const charge: ProviderCost = {
                kind: "charged", amount: { amount: "0.0123", currency: "USD" }, source: "fixture response",
            };
            let calls = 0;
            const provider = new ModelProvider({
                model: "cancellation-witness", url: "https://example.test/v1/chat/completions",
                contextWindow: 100_000,
                fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
                temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 3,
                normalizeCost: (evidence) => evidence.charge as ProviderCost | undefined,
                fetch: async (_url, init) => {
                    calls++;
                    return new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                                id: "cancelled-child", model: "cancellation-witness",
                                choices: [{ index: 0, delta: {
                                    reasoning_content: "Still reasoning.",
                                    content: "````EDIT (workspace:///must-not-exist.txt)\nnot authorized after cancellation\n````",
                                }, finish_reason: null }],
                                ...(reported ? {
                                    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, charge,
                                } : {}),
                            })}\n\n`));
                            init?.signal?.addEventListener("abort", () => {
                                controller.error(new DOMException("Request aborted", "AbortError"));
                            }, { once: true });
                        },
                    }), { headers: { "content-type": "text/event-stream" } });
                },
            });
            await withDaemon(provider, async (db, daemon) => {
                const { workspaceId } = await daemon.createWorkspace({ name: `cancellation-${stop}-${reported}` });
                const parent = await namedModelSession(daemon, workspaceId, "main");
                await insertLoop(db, parent, 1, "parent delegation");
                const child = await insertSession(db, workspaceId, parent, "child", "model");
                const observed = Promise.withResolvers<void>();
                const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
                    const event = params as { sessionId?: number; phase?: string };
                    if (method === "reasoning/event" && event.sessionId === child && event.phase === "content") observed.resolve();
                });
                try {
                    const task = await daemon.runLoop({ workspaceId, sessionId: child, prompt: "Think about the task." });
                    await observed.promise;
                    if (stop === "KILL") {
                        // The parent's own KILL of its child.
                        const result = await modelOperation(daemon, db, {
                            workspaceId, sessionId: parent,
                            statement: Dsl.parseSingleStatement("````KILL (session://child)\n````"),
                        });
                        assert.equal(result.status, 200);
                    } else {
                        await daemon.stop();
                    }
                    const turns = await waitForDb(
                        () => db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; completed_at: string | null }>({ loop_id: task.loopId }),
                        (rows) => rows.some(({ kind }) => kind === "inference") && rows.every(({ completed_at }) => completed_at !== null),
                    );
                    const turn = turns.find(({ kind }) => kind === "inference")!;
                    assert.equal(turn.status, 499);
                    const requests = await db.test_provider_requests.all<{
                        state: string; outcome: string; usage_input: number | null; usage_output: number | null;
                        cost_kind: string; cost_amount: string | null; evidence: string;
                    }>({ turn_id: turn.id });
                    assert.equal(requests.length, 1);
                    assert.equal(requests[0].state, "settled");
                    assert.equal(requests[0].outcome, "error");
                    assert.equal(requests[0].usage_input, reported ? 100 : null);
                    assert.equal(requests[0].usage_output, reported ? 10 : null);
                    assert.equal(requests[0].cost_kind, reported ? "charged" : "unknown");
                    assert.equal(requests[0].cost_amount, reported ? "0.0123" : null);
                    const evidence = JSON.parse(requests[0].evidence);
                    assert.equal(evidence.reasoning, "Still reasoning.");
                    assert.match(evidence.content, /must-not-exist.txt/);
                    assert.equal(evidence.rawBody[0].id, "cancelled-child");
                    assert.match(JSON.stringify(evidence.error), /cancel|abort|shutdown/i);
                    const descendants = await daemon.sessionAccounting({ workspaceId, sessionId: parent });
                    assert.equal(descendants.requests.length, 1);
                    assert.equal(descendants.costUsd, reported ? "0.0123" : null);
                    assert.equal(descendants.usage?.inputTokens, reported ? 100 : undefined);
                    assert.deepEqual(descendants, await daemon.engine.sessionAccounting(parent));
                    assert.equal(calls, 1, "cancellation never starts a replacement request");
                    assert.equal(await db.test_get_entry_by_pathname_scheme.get({ pathname: "/must-not-exist.txt", scheme: "workspace" }), undefined,
                        "a cancelled partial emission never executes");
                    assert.deepEqual(await db.test_error_rows_for_session.all({ session_id: child }), [],
                        "cancellation is lifecycle truth, not a new model-facing provider error");
                } finally {
                    unsubscribe();
                    if (stop === "KILL") await daemon.cancelSession({ workspaceId, sessionId: parent });
                }
            });
        });
    }
}
});

describe("demo-context-fit", () => {
test("{§methods-workspace-create} {§packet}: one oversized attachment lands as its first page, cut inside its one long line, and a range READ reaches its answer", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const fixture = await seedAttachmentFixture();
    const content = `Telemetry: ${"sample nominal; ".repeat(12_000)}\nRecovery site: ${fixture.answer}.\n`;
    const provider = new Mock({ contextWindow: 20_000, responses: [
        makeMockResponse("````READ (incident.txt) <2>````\n````NOTE\nInspect the recovery site.\n````"),
        makeMockResponse(`\`\`\`\`SEND [200]
${fixture.answer}
\`\`\`\``),
    ] });
    try {
        await writeFile(join(fixture.workspace, "incident.txt"), content);
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "oversized-attachment", projectRoot: fixture.workspace });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: ["incident.txt"],
                });
                assert.equal(result.finalStatus, 200);
                const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: result.loopId });
                assert.equal(turns.filter(({ kind }) => kind === "overflow").length, 0, "no recovery turn is manufactured");
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                const attachment = rows.find((row) => row.origin === "_plurnk" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(attachment);
                assert.equal(attachment.status_rx, 200, "the page is an ordinary result");
                const page = JSON.parse(attachment.rx) as { content: string; region?: { startLine: number; endLine: number; endColumn: number } };
                const chars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);
                assert.equal(page.content.length, chars, "the character bound cuts the one long line");
                assert.equal(content.startsWith(page.content), true, "the page is the head of the line");
                assert.equal(page.region?.startLine, 1);
                assert.equal(page.region?.endLine, 1, "the cut is inside line 1 and says so");
                const answer = rows.find((row) => row.origin === "model" && row.op === "READ" && row.pathname === "incident.txt");
                assert.ok(answer, "the model's own range READ ran");
                assert.equal(answer.status_rx, 200);
                assert.match((JSON.parse(answer.rx) as { content: string }).content, new RegExp(fixture.answer, "u"), "a range of the same file fits and answers");
                assert.equal(await readFile(join(fixture.workspace, "incident.txt"), "utf8"), content);
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally { await fixture.cleanup(); }
});

for (const retire of [false, true]) test(`{§tokenomics}: sixteen attachments land whole until the budget runs out, then as receipts, with the READ rows ${retire ? "retired" : "retained"}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const fixture = await seedAttachmentFixture();
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({
        contextWindow: 20_000,
        responses: [
            makeMockResponse("````KILL (log:///**/FIND)````\n````READ (incident.txt) <2>````\n````NOTE\nInspect the recovery site.\n````"),
            makeMockResponse(`${retire ? "````KILL (log:///**/READ)````\n" : ""}\`\`\`\`SEND [200]
${fixture.answer}
\`\`\`\``),
        ],
    });
    try {
        await withDaemon(provider, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: "attachments-fit", projectRoot: fixture.workspace });
                assert.equal(created.error, undefined);
                const workspaceId = (created.result as { id: number }).id;
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: fixture.prompt, openPaths: fixture.openPaths,
                     maxTurns: 6,
                }, { timeoutMs: 20_000 });
                assert.equal(result.finalStatus, 200);
                assert.ok(result.modelSessionId);
                const evidence = await assertContextFitEvidence({
                    db, daemon, workspaceId, sessionId: result.modelSessionId,
                    turnIds: result.turnIds ?? [], fixture,
                });
                assert.ok(evidence.landed > 0, "the first attachments fit and landed whole");
                assert.ok(evidence.receipts > 0, "the budget ran out: the rest are receipts");
                assert.equal(evidence.modelTurns, 2, "receipts cost no turn; the model answered in two");
                assert.equal(evidence.receiptActive, !retire);
                const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                const recovered = rows.filter((row) => row.origin === "model" && row.op === "READ" && row.pathname === "incident.txt");
                assert.equal(recovered.length, 1, "the model made its own recovery READ");
                assert.equal(recovered[0].status_rx, 200);
                assert.match(JSON.parse(recovered[0].rx).content, new RegExp(fixture.answer, "u"), "the scripted answer is backed by a delivered result");
                assert.equal(provider.remaining, 0);
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
        await fixture.cleanup();
    }
});
});

describe("output-admission", () => {
const messages = [{ role: "system" as const, content: "An agent." }, { role: "user" as const, content: "Review the evidence." }];
const response = (content: string): MockResponse => ({ assistant: { content, reasoning: null } });
const providerAt = (capacity: number, responses: MockResponse[]): Mock => {
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(1_000_000 - capacity);
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        return new Mock({ contextWindow: 1_000_000, responses });
    } finally {
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
};
const continuing = "````NOTE\nReview the evidence.\n````";

const receipt = (row: Record<string, unknown>): { lines: number; tokens: number; remaining: number; detail: string } => {
    const problem = (row.problem ?? {}) as { detail?: string; lines?: number; tokens?: number; remaining?: number };
    return { lines: Number(problem.lines), tokens: Number(problem.tokens), remaining: Number(problem.remaining), detail: problem.detail ?? "" };
};

// {§packet} — the room a test pins is measured, not guessed: the first packet's weight
// plus the margin the story needs.
const floorWeight = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, sessionId: number, loopId: number): Promise<number> => {
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    const packet = await builder.buildRequestPacket({ initialMessages: messages, workspaceId, sessionId, loopId, provider: providerAt(999_000, []), currentTurnSeq: 1, gitStatus: null });
    return packet.weight;
};
const pageLines = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES);
const pageChars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);

test("{§packet}: a READ without a scope lands as its first page, bounded by lines and characters, naming the page of the whole; a range READ reaches the rest", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `first-page-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        const provider = providerAt(999_000, [
            response(`\`\`\`\`READ (workspace:///large.md)\`\`\`\`\n${continuing}`),
            response(`\`\`\`\`READ (workspace:///large.md) <2,3>\`\`\`\`\n${continuing}`),
            response(continuing),
        ]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: first.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 200, "the page is an ordinary result");
        const stored = JSON.parse(read.rx) as { content: string; range: { total: number; returned: [number, number] } };
        const [from, to] = stored.range.returned;
        assert.equal(from, 1);
        assert.ok(to < 600 && to <= pageLines, `the page is bounded: ${to} lines`);
        assert.ok(stored.content.length <= pageChars + 1, "and by characters");
        assert.equal(stored.content, content.split("\n").slice(0, to).join("\n"), "the page is the first lines, cut at a line boundary");
        assert.equal(stored.range.total, 600, "the whole is named beside the page");
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 2, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const row = logEntries(packet).find((entry) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(entry.logPath))!;
        assert.equal(row.range, `<1,${to}> of 600 lines`, "{§log-wire-format}: one fact, one notation");
        assert.equal(String(row.body).trimEnd().split("\n").length, to, "the row shows exactly the page");
        const sliced = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: second.turnId }))
            .find((entry) => entry.op === "READ" && !LogEntryProjection.isEmission(entry))!;
        assert.equal(sliced.status_rx, 200, "an explicit scope is exact");
        assert.equal((JSON.parse(sliced.rx) as { content: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const whole = await clientRead(engine, db, { statement: readStmt(urlPath("workspace", "/large.md"), { marks: [1, -1] }), workspaceId, sessionId });
        assert.equal((whole as { content?: string }).content, content, "`<1,-1>` is the whole thing");
    } finally { await db.close(); }
});

test("{§tokenomics}: a page that does not fit the room lands as the longest prefix of its lines above a 413 receipt naming the lines delivered; the prefix holds the room until the receipt is killed, then a range READ succeeds", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-fit-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        // A room 1,500 over the floor: the first page (about 8,000) cannot land whole, a few lines can.
        const room = await floorWeight(db, workspaceId, sessionId, loopId) + 1_500;
        const provider = providerAt(room, [
            response(`\`\`\`\`READ (workspace:///large.md)\`\`\`\`\n${continuing}`),
            response(`\`\`\`\`KILL (log:///**/READ)\`\`\`\`\n\`\`\`\`READ (workspace:///large.md) <2,3>\`\`\`\`\n${continuing}`),
            response(continuing),
        ]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: first.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 413, "the page does not fit the remaining budget");
        const stored = JSON.parse(read.rx) as { content: unknown; problem: { type: string; detail: string; lines: number; tokens: number; remaining: number; delivered: number }; range?: { total: number; returned?: [number, number] } };
        const delivered = stored.problem.delivered;
        assert.ok(Number.isSafeInteger(delivered) && delivered > 0 && delivered < stored.problem.lines, `a prefix of the page fit: ${delivered} of ${stored.problem.lines}`);
        assert.equal(stored.content, `${content.split("\n").slice(0, delivered).join("\n")}\n`, "the row carries the first lines delivered, cut at a line boundary");
        assert.equal(stored.problem.type, "https://problems.plurnk.xyz/engine/context/result-exceeds-budget");
        assert.match(stored.problem.detail, new RegExp(`^${stored.problem.lines} lines, \\d+ tokens; \\d+ tokens remain: ${delivered} lines? delivered; READ a range, or KILL first\\.$`, "u"));
        assert.ok(stored.problem.tokens > stored.problem.remaining, "the page did not fit");
        assert.deepEqual(stored.range?.returned, [1, delivered], "the returned range closes on the last line delivered");
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 2, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        assert.ok(packet.weight <= room, "the receipt and its prefix fit where the page could not");
        const row = logEntries(packet).find((entry) => entry.status === 413 && /^log:\/\/\/1\/2\/\d+\/READ$/u.test(entry.logPath))!;
        assert.ok(row, "the receipt is a row of the next packet");
        assert.equal(String(row.body).trimEnd().split("\n").length, delivered, "the row shows exactly the lines delivered");
        const facts = receipt(row);
        assert.ok(facts.tokens > 0 && facts.remaining >= 0 && facts.tokens > facts.remaining);
        assert.match(facts.detail, /READ a range, or KILL first/u);
        assert.doesNotMatch(packetSection(packet, "budget"), /WARNING|MUST/u, "{§tokenomics}: the gauge is state, not a mandate");
        const sliced = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: second.turnId }))
            .find((entry) => entry.op === "READ" && !LogEntryProjection.isEmission(entry))!;
        assert.equal(sliced.status_rx, 200, "{§tokenomics}: the prefix held the room; KILL first, then a range READ takes a piece of what did not fit");
        assert.equal((JSON.parse(sliced.rx) as { content: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const whole = await clientRead(engine, db, { statement: readStmt(urlPath("workspace", "/large.md"), { marks: [1, -1] }), workspaceId, sessionId });
        assert.equal((whole as { content?: string }).content, content, "the complete result is where it was read from");
    } finally { await db.close(); }
});

test("{§tokenomics}: a READ whose first line does not fit is a bodiless receipt", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-fit-line-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // One line longer than the page's characters: the page is a cut of that line, about 8,000 tokens.
        await seedEntryWithChannel(db, { workspaceId, pathname: "/line.md", content: "evidence ".repeat(4_000) });
        const room = await floorWeight(db, workspaceId, sessionId, loopId) + 1_500;
        const provider = providerAt(room, [response(`\`\`\`\`READ (workspace:///line.md)\`\`\`\`\n${continuing}`)]);
        const turn = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const read = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: turn.turnId }))
            .find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!;
        assert.equal(read.status_rx, 413);
        const stored = JSON.parse(read.rx) as { content: unknown; problem: { detail: string; lines: number; delivered?: number } };
        assert.equal(stored.content, null, "not one line fit: the row carries no body");
        assert.equal(stored.problem.delivered, undefined);
        assert.match(stored.problem.detail, /^1 line, \d+ tokens; \d+ tokens remain: READ a range, or KILL first\.$/u);
    } finally { await db.close(); }
});

test("{§tokenomics}: KILL first — the fit measure honours curation within the same turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `context-verbs-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const filler = Array.from({ length: 100 }, (_, i) => `filler ${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        const wanted = Array.from({ length: 100 }, (_, i) => `wanted ${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/filler.md", content: filler });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/wanted.md", content: wanted });
        // `<1,-1>` asks for the whole file, so each READ is the whole 14,000 and not its page ({§packet}).
        const provider = providerAt(24_000, [
            response(`\`\`\`\`READ (workspace:///filler.md) <1,-1>\`\`\`\`\n${continuing}`),
            response([
                "````READ (workspace:///wanted.md) <1,-1>````",
                "````KILL (log:///1/*/*/READ)````",
                "````READ (workspace:///wanted.md) <1,-1>````",
                continuing,
            ].join("\n")),
        ]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 1, provider });
        const filled = (await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: first.turnId })).find((row) => row.op === "READ")!;
        assert.equal(filled.status_rx, 200, "the first file fits an empty room");
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, turnNumber: 2, provider });
        const reads = (await db.test_log_entries_by_turn.all<{ sequence: number; op: string; status_rx: number }>({ turn_id: second.turnId }))
            .filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))
            .toSorted((a, b) => a.sequence - b.sequence)
            .map(({ status_rx }) => status_rx);
        assert.deepEqual(reads, [413, 200], "before the KILL the room is full; after it the same READ fits");
    } finally { await db.close(); }
});

test("{§tokenomics}: over budget but under the wall, the packet goes with one 413 row at its head, the gauge shows it over, and authored state is untouched", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-authorship-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const note = "Remember ".repeat(5000);
        const wide = providerAt(999_000, [response(`\`\`\`\`NOTE\n${note}\n\`\`\`\``)]);
        const first = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: wide });
        const before = await db.engine_render_log.all({ session_id: sessionId });
        // A 12,000-token budget inside a million-token window: far over the budget, far under the wall.
        const small = providerAt(12_000, [response(continuing), response(continuing)]);
        const second = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: small });
        assert.equal(second.status, 102, "the over-budget packet is submitted, not ended");
        assert.equal(small.remaining, 1, "the provider was asked once");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const gauge = JSON.parse(packetSection(packet, "budget")) as { tokens: number; budget: number };
        assert.ok(gauge.tokens > gauge.budget, `the gauge shows the packet over: ${gauge.tokens} of ${gauge.budget}`);
        const rows = logEntries(packet).filter((row) => row.logPath.endsWith("/error"));
        assert.equal(rows.length, 1, "one row, at the head of the turn");
        const problem = (rows[0].problem ?? {}) as { detail?: string; excess?: number };
        assert.equal(problem.detail, "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn."); // {§operation-results}
        assert.equal(problem.excess, undefined, "{§tokenomics}: the gauge is the one home for the numbers");
        assert.equal(rows[0].origin, "_plurnk");
        const third = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: small });
        const next = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: third.turnId }))!.packet);
        const nextRows = logEntries(next).filter((row) => row.logPath.endsWith("/error"));
        assert.equal(nextRows.length, 1, "shown once: the earlier mandate has retired from the projection; a packet that is still over carries its own (#1097)");
        assert.notEqual(nextRows[0].logPath, rows[0].logPath, "the row in the next packet is that packet's own");
        const minted = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; active: number }>({ turn_id: second.turnId });
        assert.ok(minted.some(({ op, status_rx, active }) => op === "error" && status_rx === 413 && active === 1), "the retired mandate stays durable and active at its coordinate; only the packet projection drops it");
        const after = await db.engine_render_log.all<{ id: number }>({ session_id: sessionId });
        for (const row of before as Array<{ id: number }>) assert.deepEqual(after.find(({ id }) => id === row.id), row, "authored state cannot be removed or folded to manufacture a fit");
        const firstRows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; folded: string }>({ turn_id: first.turnId });
        assert.ok(firstRows.some(({ op, tx }) => op === "NOTE" && JSON.parse(tx).body === note), "the authored NOTE stands whole");
    } finally { await db.close(); }
});

for (const origin of ["client", "_plurnk"] as const) test(`{§tokenomics}: ${origin} output crosses maintenance and loop boundaries whole, result and all`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-origin-${origin}-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const earlier = await Turn.open(db, { loopId, producer: origin, kind: "operation" });
        const content = "result ".repeat(1_000);
        const result = { ...Results.failure("scheme:session", "output-failure", 503, "Connection closed."), content, mimetype: "text/plain", startLine: 1 };
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: earlier.id, sequence: 1, origin,
            source: null, model_call_id: null, op: "READ", scheme: "workspace", pathname: "/result",
            username: null, password: null, hostname: null, port: null, query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json", rx: JSON.stringify(result), mimetype_rx: "application/json",
            status_rx: 503, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await Turn.complete(db, earlier.id, 102);
        const maintenance = await Turn.open(db, { loopId, producer: "_plurnk", kind: "maintenance" });
        await Turn.complete(db, maintenance.id, 200);
        const laterLoop = await insertLoop(db, sessionId, 2);
        const schemes = new SchemeRegistry();
        const provider = providerAt(999_000, [response(continuing)]);
        const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
        await builder.buildRequestPacket({ initialMessages: messages, workspaceId, sessionId, loopId: laterLoop, provider, currentTurnSeq: 1, gitStatus: null });
        const before = await db.engine_render_log.all<{ id: number; folded: string; rx: string }>({ session_id: sessionId });
        assert.equal(before.find(({ id }) => id === inserted!.id)!.folded, "[]", "speculative construction has no projection effects");
        const next = await new Engine({ db, schemes }).runTurn({ workspaceId, sessionId, loopId: laterLoop, messages, provider });
        assert.equal(provider.remaining, 0);
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const row = logEntries(packet).find(({ logPath: path }) => path === `log:///1/${earlier.sequence}/1/READ`)!;
        assert.equal(row.status, 503, "the actual operation result is not restamped");
        assert.equal((row.problem as { detail: string }).detail, "Connection closed.");
        assert.match(String(row.body), /result result/u, "the retained result arrives whole: nothing is withheld");
        const projected = await db.engine_render_log.all<{ id: number; folded: string; rx: string }>({ session_id: sessionId });
        assert.equal(projected.find(({ id }) => id === inserted!.id)!.folded, "[]");
        assert.deepEqual(JSON.parse(projected.find(({ id }) => id === inserted!.id)!.rx), result);
    } finally { await db.close(); }
});
});
