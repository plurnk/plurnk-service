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
import { OperationFailureError } from "../../src/core/results.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { logEntries } from "./_packet.ts";
import { statement } from "./reasoning-fixture.ts";
import { testExecutors } from "./_execs.ts";

const frame = PlurnkParser.frame;

test("{§reasoning-reboot-configuration}: invalid input is a repairable configuration failure before inference", async () => {
    const key = "PLURNK_SERVICE_REASONING_REBOOT";
    const saved = process.env[key];
    const db = await openMigrated();
    try {
        process.env[key] = "yes";
        const workspaceId = await insertWorkspace(db, "invalid-reboot-control");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("KILL", "Done."), reasoning: null } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await assert.rejects(engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] }), (error) => {
            assert.ok(error instanceof OperationFailureError);
            assert.equal(error.result.status, 503);
            assert.equal(error.result.problem.key, key);
            assert.match(error.message, /must be 0 or 1/u);
            return true;
        });
        assert.equal(provider.received.length, 0);
        process.env[key] = "1";
        assert.equal((await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] })).status, 200,
            "repairing the setting restores inference on the same engine");
    } finally {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
        await db.close();
    }
});

for (const [global, alias, reboot] of [["1", undefined, true], ["0", undefined, false], ["1", "0", false], ["0", "1", true]] as const) {
    test(`{§reasoning-reboot-configuration}: global=${global}, alias=${alias} controls cutoff, not admission`, async () => {
        const key = "PLURNK_SERVICE_REASONING_REBOOT";
        const aliasKey = `${key}_reboottest`;
        const saved = [process.env[key], process.env[aliasKey]];
        const db = await openMigrated();
        try {
            process.env[key] = global;
            if (alias === undefined) delete process.env[aliasKey];
            else process.env[aliasKey] = alias;
            const workspaceId = await insertWorkspace(db, "reasoning-reboot-control");
            const workerId = await insertWorker(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, workerId, 1);
            await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Observed fact." });
            const reasoning = `${frame("READ (worker:///fact.txt)", null)}\n\nContinuing thought.\n${frame("NOTE", "After fact-finding.")}\n`;
            const provider = new AiSdkProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
                fetchTimeoutMs: 5000, operationTimeoutMs: 5000, firstContentTimeoutMs: 0,
                temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null },
                fetch: async () => new Response([
                    { choices: [{ index: 0, delta: { reasoning_content: reasoning } }] },
                    { choices: [{ index: 0, delta: { content: frame("KILL", "A racing conclusion.") }, finish_reason: "stop" }] },
                ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
            });
            ProviderInstantiate.registerConfigurationScope(provider, "reboottest");
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const result = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
            assert.equal(result.status, 102, "reasoning READ still requires observation when reboot is off");
            const calls = await db.test_model_calls.all<{ response: string }>({ turn_id: result.turnId });
            assert.equal(calls.length, 1);
            assert.equal(JSON.parse(calls[0]!.response).reasoningYield !== undefined, reboot);
            const reads = await db.test_log_entries_by_worker_op_full.all<{ pathname: string; rx: string }>({ worker_id: workerId, op: "READ" });
            assert.ok(reads.some(({ pathname, rx }) => pathname === "/fact.txt" && rx.includes("Observed fact.")));
            const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
            assert.equal(sources.some(({ kind, content }) => kind === "note" && content === "After fact-finding."), !reboot,
                "only disabling interruption admits the completed response's later NOTE");
        } finally {
            [key, aliasKey].forEach((name, index) => {
                if (saved[index] === undefined) delete process.env[name];
                else process.env[name] = saved[index];
            });
            await db.close();
        }
    });
}

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
            const emissions = provider.received[1]!.filter(({ role }) => role === "assistant");
            assert.match(JSON.stringify(emissions), /READ \(worker:\/\/\/fact\.txt\)/u, "the admitted reasoning operation appears in the emission projection");
            assert.doesNotMatch(JSON.stringify(rows), /No valid Operation|no_operation/u);
            const raw = await engine.look({ ...context, statement: statement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
            assert.equal(raw.content, reasoning);
            const ops = await engine.look({ ...context, statement: statement(frame("READ (ops://alice/1/2) <1,-1>", null)) });
            assert.equal(ops.content ?? "", content, "the provider's content evidence is not rewritten");
        } finally { await db.close(); }
    });
}

test("{§reasoning-yield}: HTTP interruption admits one ordinary turn, retains evidence and resumes with its results", async () => {
    const db = await openMigrated();
    const batch = [frame("NOTE", "Use the actual fact."), frame("FIND (worker:///fact.txt)", null), frame("READ (worker:///fact.txt) <1,-1>", null)].join("\n\n") + "\n";
    const reasoning = batch + `\nNow I would speculate.\n${frame("NOTE", "This lookahead must not execute.")}\n`;
    const racingContent = frame("EDIT (worker:///fact.txt)", "Unobserved edit must not run.");
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const disconnected = Promise.withResolvers<void>();
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
            id: `request-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
        if (requests.length === 1) {
            response.on("close", () => disconnected.resolve());
            emit({ reasoning_content: reasoning, content: racingContent });
        } else {
            emit({ content: frame("KILL", "The fact is established.") }, "stop");
            response.end("data: [DONE]\n\n");
        }
    });
    try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const workspaceId = await insertWorkspace(db, "yield-integration");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Established fact." });
        const phases: string[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            reasoningEventNotify: (_workspace, event) => { phases.push(event.phase); },
        });
        const provider = new AiSdkProvider({ model: "fixture", url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
            contextWindow: 100_000, fetchTimeoutMs: 5000, operationTimeoutMs: 5000, firstContentTimeoutMs: 0,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null }, rawBody: true,
        });
        const first = await engine.runTurn({ ...context, provider, messages: [], signal: AbortSignal.timeout(3000) });
        assert.equal(first.status, 102);
        await disconnected.promise;
        assert.deepEqual(phases, ["start", "content", "end"]);
        assert.deepEqual((await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first.turnId })).map(({ accepted }) => accepted), [1]);
        const second = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(second.status, 200);
        assert.equal(requests.length, 2, "the next inference is a new turn, not a resampled attempt");
        const nextPacket = JSON.stringify(requests[1]!.messages);
        assert.match(nextPacket, /Established fact/u);
        assert.match(nextPacket, /READ \(worker:\/\/\/fact\.txt\)/u);
        assert.doesNotMatch(nextPacket, /This lookahead must not execute|Unobserved edit must not run/u);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
        assert.ok(sources.some(({ kind, content }) => kind === "reasoning" && content === reasoning), "received reasoning is retained verbatim");
        assert.ok(sources.some(({ kind, content }) => kind === "ops" && content === racingContent), "received content is retained verbatim");
        assert.equal(sources.filter(({ kind, content }) => kind === "note" && content === "Use the actual fact.").length, 1);
        assert.ok(sources.every(({ kind, content }) => kind !== "note" || content !== "This lookahead must not execute."));
        const fact = await engine.look({ ...context, statement: statement(frame("READ (worker:///fact.txt) <1,-1>", null)) });
        assert.equal(fact.content, "Established fact.");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await db.close();
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
