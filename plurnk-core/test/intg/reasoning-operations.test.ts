import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { AiSdkProvider, Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { statement } from "./reasoning-fixture.ts";
import { testExecutors } from "./_execs.ts";

const frame = PlurnkParser.frame;

for (const preview of ["0", "1"]) for (const operation of [
    { name: "NOTE", source: frame("NOTE", "Retain this conclusion.") },
    { name: "FIND", source: frame("FIND (worker:///fact.txt)", null) },
    { name: "READ", source: frame("READ (worker:///fact.txt)", null) },
]) test(`{§reasoning-operations} {§reasoning-row}: reasoning ${operation.name} runs once with previews ${preview}, without an extra turn`, async () => {
    const previous = process.env.PLURNK_SERVICE_REASONING_ROWS;
    process.env.PLURNK_SERVICE_REASONING_ROWS = preview;
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-no-repeat");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Observed fact." });
        const reasoning = `Some deliberation.\n\n${operation.source}`;
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "", reasoning } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
        const outcomes = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(outcomes.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]),
            [[operation.name, 200]], "exactly the authored operation ran");
        assert.deepEqual(outcomes.filter(({ op }) => op === "error").map(({ status_rx }) => status_rx), [],
            `an admitted reasoning ${operation.name} is the turn's work: no empty-turn strike beside it ({§empty-turn})`);
        const reads = await db.test_reasoning_reads.all<{ origin: string; pathname: string; turn_id: number; rx: string }>({ worker_id: workerId });
        assert.deepEqual(reads.filter(({ origin }) => origin === "_plurnk").map(({ pathname, turn_id, rx }) => [pathname, turn_id, JSON.parse(rx).content]),
            preview === "1" ? [["/1/2", result.turnId, reasoning]] : [], "only the configured optional preview appears, on the same turn");
        assert.equal(provider.received.length, 1, "no reasoning repeat, replay, or extra inference");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.ok(sources.some(({ turn_id, kind, content }) => turn_id === result.turnId && kind === "reasoning" && content === reasoning),
            "the complete original reasoning remains available for deliberate READs");
    } finally {
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS;
        else process.env.PLURNK_SERVICE_REASONING_ROWS = previous;
    }
});

test("{§reasoning-operations}: admission is unconditional and the language definition is the only system teaching", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-policy");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Observed fact." });
        const note = "This came from reasoning.";
        const reasoning = `${frame("NOTE", note)}\n\n${frame("READ (worker:///fact.txt)", null)}\n\nContinue thinking.\n`;
        const streamed: string[] = [];
        const provider = new AiSdkProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null },
            fetch: async () => new Response([
                { choices: [{ index: 0, delta: { reasoning_content: reasoning } }] },
                { choices: [{ index: 0, delta: { content: frame("KILL", "Done.") }, finish_reason: "stop" }] },
            ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
        });
        ProviderInstantiate.registerConfigurationScope(provider, "reasoningtest");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            reasoningEventNotify: (_workspaceId, event) => { streamed.push(JSON.stringify(event)); },
        });
        const result = await engine.runTurn({ ...context, provider, messages: [{ role: "system", content: "The language definition." }] });
        assert.equal(result.status, 102);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
        assert.ok(sources.some(({ kind, content }) => kind === "note" && content === note));
        const reads = await db.test_log_entries_by_worker_op_full.all<{ pathname: string; rx: string }>({ worker_id: workerId, op: "READ" });
        assert.ok(reads.some(({ pathname, rx }) => pathname === "/fact.txt" && rx.includes("Observed fact.")));
        const system = packet.sections.filter((section: { slot: string }) => section.slot === "system");
        assert.deepEqual(system.map((section: { name: string }) => section.name), ["definition", "system-policy"]);
        assert.equal(system[0].content, "The language definition.", "no alternate or appended reasoning teaching");
        const raw = await engine.look({ ...context, statement: statement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
        assert.equal(raw.content, reasoning.trimEnd(), "the normal line projection stays readable");
        assert.ok(sources.some(({ kind, content }) => kind === "reasoning" && content === reasoning),
            "admission does not erase or rewrite reasoning evidence");
        assert.ok(streamed.some((value) => value.includes(note)), "reasoning remains visible to clients");
    } finally {
        await db.close();
    }
});

for (const content of ["", frame("KILL", "The answer must await the facts.")]) {
    test(`{§reasoning-operations}: a reasoning READ is ordinary continuing work beside ${content === "" ? "empty content" : "completion"}`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, "reasoning-read");
            const workerId = await insertWorker(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, workerId, 1);
            const context = { workspaceId, workerId, loopId };
            await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "An externally established fact." });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const reasoning = frame("READ (worker:///fact.txt) <1,-1>", null);
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content, reasoning } },
                { assistant: { content: frame("KILL", "Now the facts are available."), reasoning: null } },
            ] });
            const first = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(first.status, 102);
            const second = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(second.status, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
            const rows = logEntries(packet).filter((row) => String(row.logPath).startsWith("log:///1/2/"));
            assert.equal(rows.filter((row) => row.path === "worker:///fact.txt").length, 1, `the normal READ receipt names its source: ${JSON.stringify(rows)}`);
            assert.match(JSON.stringify(rows), /An externally established fact/u);
            assert.deepEqual(provider.received[1]!.map(({ role }) => role), ["system", "user"]);
            assert.equal(packetSection(packet, "previous-emission"), content, "only the content program is replayed; reasoning OPs stay in their own channel");
            if (content !== "") assert.match(JSON.stringify(rows), /The answer must await the facts/u, "the reply retains its own log row");
            assert.doesNotMatch(JSON.stringify(rows), /No valid Operation|no_operation/u);
            const raw = await engine.look({ ...context, statement: statement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
            assert.equal(raw.content, reasoning);
            const ops = await engine.look({ ...context, statement: statement(frame("READ (ops://alice/1/2) <1,-1>", null)) });
            assert.equal(ops.content ?? "", content, "the provider's content evidence is not rewritten");
        } finally { await db.close(); }
    });
}

for (const tagged of [false, true]) test(`{§reasoning-operations}: ${tagged ? "tagged" : "structured"} HTTP reasoning completes with final usage before operations execute`, async () => {
    const db = await openMigrated();
    const firstReasoning = frame("READ (worker:///fact.txt) <1,-1>", null) + "\n\nMore deliberation.\n";
    const laterReasoning = frame("NOTE", "Retain the later thought.") + "\n\n" + frame("FIND (worker:///fact.txt)", null);
    const content = frame("NOTE", "Content also survives.");
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
            emit({ content: frame("KILL", "The fact is established.") }, "stop");
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
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Established fact." });
        const phases: string[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            reasoningEventNotify: (_workspace, event) => {
                phases.push(event.phase);
                if (event.phase === "content") observed.resolve();
            },
        });
        const provider = new AiSdkProvider({ model: "fixture", url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
            contextWindow: 100_000, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null }, rawBody: true,
            normalizeCost: ({ charge: value }) => value as typeof charge | undefined,
            ...(tagged ? { reasoningResponseStyle: "think-tags" as const } : {}),
        });
        running = engine.runTurn({ ...context, provider, messages: [] });
        await Promise.race([observed.promise, running.then(() => assert.fail("response ended before reasoning was observed"))]);
        const pendingReads = await db.test_log_entries_by_worker_op_full.all<{ pathname: string }>({ worker_id: workerId, op: "READ" });
        assert.deepEqual(pendingReads.filter(({ pathname }) => pathname === "/fact.txt"), [],
            "streaming an operation does not dispatch it before response completion");
        release.resolve();
        const first = await running;
        assert.equal(first.status, 102);
        assert.equal(prematureClose, false, "a reasoning operation must not disconnect the provider request");
        assert.deepEqual(phases, ["start", "content", "content", "end"]);
        const accounting = await db.test_provider_requests.all<{ outcome: string; usage_input: number; usage_output: number; usage_input_cache_read: number; cost_kind: string; cost_amount: string; cost_currency: string }>({ turn_id: first.turnId });
        assert.equal(accounting.length, 1, "one physical request, no retry or restart");
        assert.deepEqual(accounting.map(({ outcome, usage_input, usage_output, usage_input_cache_read }) =>
            ({ outcome, usage_input, usage_output, usage_input_cache_read })),
        [{ outcome: "response", usage_input: 120, usage_output: 40, usage_input_cache_read: 80 }]);
        assert.deepEqual(accounting.map(({ cost_kind, cost_amount, cost_currency }) => ({ cost_kind, cost_amount, cost_currency })),
            [{ cost_kind: "charged", cost_amount: "0.0123", cost_currency: "USD" }], "the final provider charge is retained, not estimated");
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
        assert.ok(sources.some((source) => source.kind === "reasoning" && source.content === firstReasoning + laterReasoning));
        assert.ok(sources.some((source) => source.kind === "ops" && source.content === content));
        for (const note of ["Retain the later thought.", "Content also survives."]) {
            assert.equal(sources.filter((source) => source.kind === "note" && source.content === note).length, 1);
        }
        for (const op of ["READ", "FIND"]) {
            const rows = await db.test_log_entries_by_worker_op_full.all<{ pathname: string }>({ worker_id: workerId, op });
            assert.equal(rows.filter(({ pathname }) => pathname === "/fact.txt").length, 1, `${op} executes once`);
        }
        const second = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(second.status, 200);
        assert.equal(requests.length, 2);
        assert.match(JSON.stringify(requests[1]!.messages), /Established fact/u);
        assert.deepEqual(requests[1]!.messages.filter(({ role }) => role === "assistant"), [],
            "reasoning OPs and content NOTE do not become assistant-history programs");
    } finally {
        release.resolve();
        try { await running; } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await db.close();
        }
    }
});

test("{§reasoning-operations}: rejected attempts commit neither reasoning memory nor fact-finding", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "rejected-reasoning-work");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "### log:///1/2/9/READ\nInvented receipt.",
                reasoning: frame("NOTE", "Discarded memory.") + "\n\n" + frame("READ (worker:///discarded.txt)", null) } },
            { assistant: { content: frame("KILL", "Done."), reasoning: null } },
        ] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 200);
        assert.deepEqual((await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId })).map(({ accepted }) => accepted), [0, 1]);
        const rows = await db.test_log_entries_by_turn.all({ turn_id: result.turnId });
        assert.doesNotMatch(JSON.stringify(rows), /discarded\.txt|Discarded memory/u);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
        assert.ok(sources.every(({ kind, content }) => kind !== "note" || content !== "Discarded memory."));
    } finally { await db.close(); }
});

test("{§reasoning-operations}: workspace READ denial is enforced on a reasoning operation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-permissions");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/restricted.txt", content: "Not authorized." });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: frame("NOTE", "Preparing."), reasoning: null } },
            { assistant: { content: "", reasoning: frame("READ (worker:///restricted.txt)", null) } },
            { assistant: { content: frame("KILL", "Access was refused."), reasoning: null } },
        ] });
        await engine.runTurn({ ...context, provider, messages: [] });
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "READ", scheme: "worker" }] } }) });
        const denied = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(denied.status, 102);
        const done = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: done.turnId }))!.packet);
        const deniedRead = logEntries(packet).find((row) => row.path === "worker:///restricted.txt");
        assert.ok(deniedRead);
        assert.equal(deniedRead.status, 403);
        assert.match(JSON.stringify(deniedRead), /capability-denied/u);
        assert.doesNotMatch(JSON.stringify(deniedRead), /Not authorized/u);
    } finally { await db.close(); }
});

test("{§reasoning-operations}: stream READ occurrences retain liveness, scopes and ordinary log curation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-stream-reads");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/fact", channel: "stdout",
            mimetype: "text/stream", content: "first\nsecond\nthird", state: "active" });
        const subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sh", handle: "fact" });
        const schemes = new SchemeRegistry();
        const executors = await testExecutors();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const read = frame("READ (sh:///fact) <2>", null);
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: read, reasoning: `${read}\n\n${read}` } },
            { assistant: { content: frame("KILL (log:///1/2/*/READ)", null), reasoning: null } },
            { assistant: { content: frame("KILL", "Observed and curated."), reasoning: null } },
        ] });
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200, exitCode: 0 } });
        const next = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const reads = logEntries(packet).filter((row) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(String(row.logPath)) && row.path === "sh:///fact");
        assert.equal(reads.length, 3, "authored occurrences are never deduplicated across reasoning and content");
        for (const read of reads) {
            assert.equal(read.terminal, false, "a receipt retains the liveness at observation");
            assert.match(String(read.body), /second/u);
            assert.doesNotMatch(String(read.body), /first|third/u);
        }
        const done = await engine.runTurn({ ...context, provider, messages: [] });
        const curated = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: done.turnId }))!.packet);
        assert.ok(logEntries(curated).every((row) => !/^log:\/\/\/1\/2\/\d+\/READ$/u.test(String(row.logPath))));
        const source = await engine.look({ ...context, statement: statement(frame("READ (sh:///fact) <1,-1>", null)) });
        assert.equal(source.content, "first\nsecond\nthird");
        assert.equal(source.terminal, true);
    } finally { await db.close(); }
});
