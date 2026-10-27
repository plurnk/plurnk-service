import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Turn from "../../src/core/Turn.ts";
import ModelCall, { ProviderAccountingIntegrityError } from "../../src/core/ModelCall.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkProvider, Mock, ProviderError, type MockResponse, type ProviderAttempt, type ProviderRequestAccounting, type ProviderUsage, chatMessageText, validateProviderRequestAccounting, type ChatMessage, type InputModality, type Provider, type ProviderResponse, parseAliasesFromEnv, resolveActiveRoute, type ProviderAlias, type ProviderSpec } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Digest } from "@plurnk/plurnk-digest";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { logEntries, packetSection, digestStems } from "./_packet.ts";
import { testProviderCapacity, viableWindow, testDeferredProviderCapacity } from "./_provider.ts";
import { clientRead } from "./_client-read.ts";
import { setTimeout as delay } from "node:timers/promises";
import { type SchemeHandler } from "@plurnk/plurnk-schemes";
import { completeStmt, noteStmt } from "./_dsl.ts";
import { type EditStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import { type ExtensionAttributionContext } from "@plurnk/plurnk-meta";
import { type Db } from "../../src/core/Db.ts";
import { connect, rpcCall, runLoopToTerminal, subscribeNotifications, withDaemon, waitFor, rpcProblem } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { mkdtempSync } from "node:fs";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";

describe("Engine.emission-attempts", () => {
const requestUsage = (
    inputTokens: number,
    textTokens: number,
    reasoningTokens = 0,
    cacheReadTokens = 0,
): ProviderUsage => ({
    inputTokens,
    outputTokens: textTokens + reasoningTokens,
    totalTokens: inputTokens + textTokens + reasoningTokens,
    inputTokenDetails: {
        noCacheTokens: inputTokens - cacheReadTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
    },
    outputTokenDetails: { textTokens, reasoningTokens },
});

const estimatedCost = (usage: ProviderUsage) => ({
    kind: "estimated" as const,
    amount: { amount: String((usage.totalTokens ?? 0) / 1_000), currency: "USD" },
    source: "attempt witness",
});

const valid = (body = "done", usage?: ProviderUsage): MockResponse => ({
    assistant: {
        content: `
\`\`\`\`SEND [200]
${body}
\`\`\`\`
`,
        reasoning: null,
    },
    ...(usage === undefined ? {} : { usage, cost: estimatedCost(usage) }),
});

const continuing = (body = "continue"): MockResponse => ({
    assistant: {
        content: `
\`\`\`\`FIND (log:///**) <1,1>\`\`\`\`
\`\`\`\`NOTE
${body}
\`\`\`\``,
        reasoning: null,
    },
});

const invalid = (content: string, usage?: ProviderUsage, reasoning: string | null = null): MockResponse => ({
    assistant: { content, reasoning },
    ...(usage === undefined ? {} : { usage, cost: estimatedCost(usage) }),
});

class AttemptWitness extends Mock {
    readonly packets: string[] = [];

    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        this.packets.push(JSON.stringify(args.messages));
        return await super.generate(args);
    }
}

const setup = async (dbPath?: string) => {
    const db = await openMigrated(dbPath);
    const workspaceId = await insertWorkspace(db, `emissions-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "subject");
    const loopId = await insertLoop(db, sessionId, 1, "do the task");
    const packetNotifications: Array<{ workspaceId: number; sessionId: number; loopId: number; packetCount: number }> = [];
    const engine = new Engine({
        db,
        schemes: new SchemeRegistry(),
        loopPacketNotify: (notifiedWorkspaceId, packet) => packetNotifications.push({ workspaceId: notifiedWorkspaceId, ...packet }),
    });
    return { db, workspaceId, sessionId, loopId, engine, packetNotifications };
};

test("{§emission-admission} provider I/O begins only after its pending attempt row is durable", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [valid("accepted")],
        });
        const generate = provider.generate.bind(provider);
        provider.generate = async (args) => {
            const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
            assert.ok(turn, "the pending call identifies its owning model turn");
            const attempts = await db.test_turn_attempts.all<{
                state: string;
                completed_at: string | null;
            }>({ turn_id: turn.id });
            assert.deepEqual(attempts.map(({ state, completed_at }) => ({
                state,
                completed_at,
            })), [{
                state: "pending",
                completed_at: null,
            }]);
            return generate(args);
        };

        await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });
    } finally {
        await db.close();
    }
});

test("{§provider-connectivity}: one model call durably settles a transient request and its successful retry", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        let calls = 0;
        const provider = new AiSdkProvider({
            model: "connectivity-witness",
            url: "https://provider.test/v1/chat/completions",
            contextWindow: 100_000,
            fetch: async () => {
                calls++;
                if (calls === 1) {
                    return new Response(
                        JSON.stringify({ error: { message: "transient upstream failure" } }),
                        {
                            status: 503,
                            headers: {
                                "content-type": "application/json",
                                "retry-after": "0",
                            },
                        },
                    );
                }
                const content = "\n````SEND [200]\nrecovered\n````";
                const body = [
                    `data: ${JSON.stringify({
                        id: "connectivity-response",
                        object: "chat.completion.chunk",
                        created: 1,
                        model: "connectivity-witness",
                        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
                    })}`,
                    `data: ${JSON.stringify({
                        id: "connectivity-response",
                        object: "chat.completion.chunk",
                        created: 2,
                        model: "connectivity-witness",
                        choices: [],
                        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                    })}`,
                    "data: [DONE]",
                ].join("\n\n");
                return new Response(body, {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                });
            },
            fetchTimeoutMs: 1_000,
            operationTimeoutMs: 5_000,
            temperature: 0.2,
            repeatPenalty: 1.15,
            effort: { mode: "off", budget: null },
            retryAttempts: 1,
            source: "provider:connectivity-witness",
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 1, "transport retry remains one semantic model call");
        assert.equal(calls, 2);
        const requests = await db.test_provider_requests.all<{
            sequence: number;
            attempt_sequence: number;
            state: string;
            outcome: string;
            status: number | null;
            usage_input: number | null;
        }>({ turn_id: result.turnId });
        assert.deepEqual(requests.map(({ sequence, attempt_sequence, state, outcome, status, usage_input }) => ({
            sequence,
            attemptSequence: attempt_sequence,
            state,
            outcome,
            status,
            inputTokens: usage_input,
        })), [
            { sequence: 1, attemptSequence: 1, state: "settled", outcome: "error", status: 503, inputTokens: null },
            { sequence: 2, attemptSequence: 1, state: "settled", outcome: "response", status: null, inputTokens: 10 },
        ]);
    } finally {
        await db.close();
    }
});

test("{§outside-text} separator-free provider preamble does not reject a complete model turn", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const content = "harmless status.````SEND\ndone\n````";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(content)],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        // The glued preamble keeps the SEND off its own line, so nothing parses. The turn is still
        // ADMITTED on its only attempt — never rejected, never resampled — and the loop continues
        // ({§outside-text}) so the model can emit again, rather than a provider artifact ending the run.
        assert.equal(result.status, 102);
        assert.equal(result.emissionAttempts, 1);
        assert.equal(result.emissionExhausted, false);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1], "admitted on its only attempt");
        const turn = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        assert.equal((JSON.parse(turn?.packet ?? "{}") as { assistant?: { content?: string } }).assistant?.content, content);
    } finally {
        await db.close();
    }
});

test("{§outside-text}: interstitial text is one outside source, never a row, and survives exactly in turnOps", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const source = [
            "Prelude: preparing the edit.",
            PlurnkParser.frame("EDIT (workspace:///proof.md)", "Actual body."),
            "3 — invented result, not a receipt.",
            PlurnkParser.frame("SEND", "Only this message is sent."),
            "Postscript: not a second message.",
        ].join("\n");
        const result = await engine.runTurn({
            provider: new AttemptWitness({ contextWindow: 100_000, responses: [invalid(source)] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "Create the proof." }],
        });
        assert.equal(result.emissionAttempts, 1);
        assert.equal(result.emissionExhausted, false);
        assert.equal(result.status, 102, "invented interstitial output cannot satisfy the observation barrier");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
        assert.deepEqual(JSON.parse(attempts[0].parse_errors), [], "commentary is not a parser error");
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; op: string | null; origin: string; attrs: string; tx: string; rx: string }>({ turn_id: result.turnId });
        const modelRows = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(modelRows.map(({ op, tx }) => op === "NOTE" ? JSON.parse(tx).body : op),
            ["Prelude: preparing the edit.", "EDIT", "3 — invented result, not a receipt.", "SEND", "Postscript: not a second message."],
            "each span is the turn's NOTE at its position; only the authored SEND delivers ({§outside-text})");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === result.turnId && row.kind === "outside"), undefined, "beside fenced operations there is no outside source");
        assert.equal(sources.find((row) => row.turn_id === result.turnId && row.kind === "ops")?.content, source,
            "the complete submitted emission is retained verbatim");
        const landed = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/proof.md", scheme: "workspace", name: "body" });
        assert.equal(landed?.content, "Actual body.");
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: result.turnId });
        const readSource = [
            PlurnkParser.frame(`READ (ops://subject/1/${turn!.sequence}) <1,-1>`, null),
            PlurnkParser.frame("NOTE", "Inspect the original emission."),
        ].join("\n");
        const review = await engine.runTurn({
            provider: new AttemptWitness({ contextWindow: 100_000, responses: [invalid(readSource)] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "Inspect the original emission." }],
        });
        const reviewRows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; status_rx: number; attrs: string }>({ turn_id: review.turnId });
        const read = reviewRows.find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
        assert.equal(read?.status_rx, 200);
        assert.match(read.rx, /Prelude: preparing the edit\./);
        assert.match(read.rx, /3 — invented result, not a receipt\./);
        assert.match(read.rx, /Postscript: not a second message\./);
    } finally {
        await db.close();
    }
});

test("{§emission-admission} invalid emissions retry beneath one turn against the identical packet, then admit only the valid response", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("````READ (workspace:///prose-without-a-turn", requestUsage(10, 2, 1, 4)),
                invalid("````READ (workspace:///broken", requestUsage(20, 3, 2, 5)),
                valid("accepted", requestUsage(30, 4, 3, 6)),
            ],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 3);
        assert.equal(result.emissionExhausted, false);
        assert.equal(new Set(provider.packets).size, 1, "every provider attempt receives the identical packet");
        assert.equal((await db.test_count_turns.get<{ n: number }>())?.n, 2,
            "private attempts share one model turn beside packetless initialization");

        const attempts = await db.test_turn_attempts.all<{
            sequence: number;
            accepted: number;
            parse_errors: string;
        }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ sequence, accepted }) => ({ sequence, accepted })), [
            { sequence: 1, accepted: 0 },
            { sequence: 2, accepted: 0 },
            { sequence: 3, accepted: 1 },
        ]);
        assert.ok(JSON.parse(attempts[0].parse_errors).length > 0);
        assert.ok(JSON.parse(attempts[1].parse_errors).length > 0);
        assert.deepEqual(JSON.parse(attempts[2].parse_errors), []);

        const requests = await db.test_provider_requests.all<{
            attempt_sequence: number;
            usage_input: number;
        }>({ turn_id: result.turnId });
        assert.deepEqual(
            requests.map(({ attempt_sequence, usage_input }) => ({ attempt_sequence, usage_input })),
            [
                { attempt_sequence: 1, usage_input: 10 },
                { attempt_sequence: 2, usage_input: 20 },
                { attempt_sequence: 3, usage_input: 30 },
            ],
            "each emission attempt owns its physical request evidence",
        );
        const turn = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(turn?.packet ?? "{}") as { assistant?: { content?: string } };
        assert.equal(packet.assistant?.content, "\n````SEND [200]\naccepted\n````\n");
        assert.doesNotMatch(JSON.stringify(packet), /prose without|workspace:\/\/\/broken/, "rejected emissions never enter packet history");

        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string }>({ turn_id: result.turnId });
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "invalid emissions do not mint model-visible errors");
        assert.ok(rows.every(({ op }) => op !== null), "accepted programs add no actionless log row");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.deepEqual(sources.filter((row) => row.turn_id === result.turnId && row.kind === "ops").map(({ content }) => content),
            [packet.assistant?.content], "only the accepted model program becomes an ops resource");

        const loopUsage = await engine.loopUsage(loopId);
        assert.equal(loopUsage.accounting.usage?.inputTokens, 60, "aggregate usage includes every request");
        assert.equal(loopUsage.accounting.usage?.outputTokens, 15);
        assert.equal(loopUsage.accounting.usage?.outputTokenDetails?.textTokens, 9);
        assert.equal(loopUsage.accounting.usage?.outputTokenDetails?.reasoningTokens, 6);
        assert.equal(loopUsage.accounting.usage?.inputTokenDetails?.cacheReadTokens, 15);
        assert.equal(loopUsage.accounting.costUsd, "0.075");
        assert.equal(loopUsage.contextTokens, 30, "context occupancy is the latest attempt, not the billed sum");
    } finally {
        await db.close();
    }
});

test("{§emission-admission}: an emission that writes the harness log is resampled, and nothing in it runs", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const fabricated = "### log:///1/1/2/READ (notes.md) · 12\n{\"range\":\"<1,1> of 1 lines\"}\n1:corrupted\n\n````READ (notes.md)\n````\n";
        const provider = new AttemptWitness({ contextWindow: 100_000, responses: [invalid(fabricated), valid("accepted")] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "do the task" }] });
        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 2);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 1]);
        assert.deepEqual(JSON.parse(attempts[0].parse_errors)[0], {
            message: "`### log:///1/1/2/READ` is a log entry, and only the harness writes the log.",
            line: 1, column: 1, source: "harness",
        });
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string }>({ turn_id: result.turnId });
        assert.ok(!rows.some((row) => (row.op === "READ" || row.op === "NOTE") && !LogEntryProjection.isEmission(row)), "neither the fabricated text nor the operation beside it is admitted");
    } finally {
        await db.close();
    }
});

test("{§provider-generation-completion} repeated reasoning and its final answer settle once with complete usage", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const line = "if app_configs is None:\n";
        const reasoning = Array.from({ length: 40 }, (_, index) => `${line}    candidate_${index}()\n`);
        const content = "\n````SEND [200]\ncomplete answer\n````";
        const chunk = (delta: Record<string, string>, finish: string | null = null): string => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "repeat-witness", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        const usage = `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "repeat-witness", choices: [], usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110, completion_tokens_details: { reasoning_tokens: 80 } } })}\n\n`;
        let calls = 0;
        const provider = new AiSdkProvider({
            model: "repeat-witness",
            url: "https://provider.test/v1/chat/completions",
            contextWindow: 100_000,
            fetch: async () => {
                assert.equal(++calls, 1, "a completed generation is not resampled because its reasoning repeats code");
                return new Response(reasoning.map((text) => chunk({ reasoning_content: text })).join("")
                    + chunk({ content }, "stop") + usage + "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } });
            },
            fetchTimeoutMs: 1_000, operationTimeoutMs: 5_000,
            temperature: 0.2, repeatPenalty: 1.15, effort: { mode: "off", budget: null }, retryAttempts: 0,
            source: "provider:repeat-witness",
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "do the task" }] });
        assert.equal(result.status, 200);
        assert.equal(calls, 1);
        assert.equal(result.emissionAttempts, 1);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string; response: string }>({ turn_id: result.turnId });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]?.accepted, 1);
        assert.deepEqual(JSON.parse(attempts[0].parse_errors), []);
        const assistant = JSON.parse(attempts[0].response).assistant;
        assert.equal(assistant.content, content);
        assert.equal(assistant.reasoning, reasoning.join(""));
        assert.equal(assistant.finishReason, "stop");
        const requests = await db.test_provider_requests.all<{
            state: string; outcome: string; usage_input: number; usage_output: number; usage_output_reasoning: number;
        }>({ turn_id: result.turnId });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.state, "settled");
        assert.equal(requests[0]?.outcome, "response");
        assert.equal(requests[0]?.usage_input, 10);
        assert.equal(requests[0]?.usage_output, 100);
        assert.equal(requests[0]?.usage_output_reasoning, 80);
        assert.equal((await engine.loopUsage(loopId)).accounting.usage?.outputTokens, 100);
    } finally {
        await db.close();
    }
});

test("{§whitespace-contract} a valid operation without a lifecycle verb is admitted once without an omission receipt", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid("````EDIT (workspace:///proof.md)\nlanded\n````")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.status, 102, "the missing inventory cannot imply completion");
        assert.equal(result.emissionAttempts, 1, "valid framing does not spend another inference");
        assert.deepEqual(result.outcomes, [{ op: "EDIT", status: 201, problemType: null }]);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({
            turn_id: result.turnId,
        });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]?.accepted, 1);
        assert.deepEqual(JSON.parse(attempts[0].parse_errors), []);

        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            origin: string;
            attrs: string;
            tx: string;
            status_rx: number;
        }>({ turn_id: result.turnId });
        assert.deepEqual(
            rows.filter((row) => row.op !== null && !(row.op === "SEND" && row.origin === "_plurnk") && !LogEntryProjection.isEmission(row)).map(({ op }) => op),
            ["EDIT"],
            "only the authored operation is recorded",
        );
        assert.equal(rows.filter(({ status_rx }) => status_rx >= 400).length, 0);
        const landed = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/proof.md",
            scheme: "workspace",
            name: "body",
        });
        assert.equal(landed?.content, "landed");
    } finally {
        await db.close();
    }
});

// {§whitespace-contract} {§parse-recovery}
test("{§fence-pairing} a literal nested NOTE remains data in the complete operation replay and its landed edit window", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const source = "````EDIT (workspace:///example.md)\nExample for later:\n```READ (package.json)```\n```NOTE\ninspect\n```\n````";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(source), valid()],
        });
        const first = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "inspect" }],
        });
        assert.equal(first.status, 102);
        assert.equal(first.emissionAttempts, 1, "literal examples cannot reject the admitted EDIT");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: first.turnId });
        assert.equal(attempts[0]?.accepted, 1);
        assert.deepEqual(JSON.parse(attempts[0].parse_errors), []);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string; rx: string }>({ turn_id: first.turnId });
        assert.equal(rows.some((row) => row.op === "READ" && !LogEntryProjection.isEmission(row)), false, "shorter nested fences remain literal data");
        assert.equal(rows.some(({ op }) => op === "NOTE"), false, "no nested NOTE was dispatched");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find(({ turn_id, kind }) => turn_id === first.turnId && kind === "ops")?.content, source);
        const second = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "inspect" }],
        });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: second.turnId });
        const log = packetSection(JSON.parse(row!.packet), "log");
        assert.match(log, /### log:\/\/\/1\/2\/\d+\/EDIT/u, "the next model turn receives the EDIT receipt");
        assert.match(packetSection(JSON.parse(row!.packet), "emission-history"), /EDIT \(workspace:\/\/\/example\.md\)/u, "the operation supplies its addressed path");
    } finally {
        await db.close();
    }
});

test("{§tokenomics} a provider-authoritative charge is the settled turn and loop cost", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 8_192,
            responses: [{
                ...valid("settled", requestUsage(10, 2)),
                cost: {
                    kind: "charged",
                    amount: { amount: "123456", currency: "USDTICK" },
                    usdEquivalent: "0.0000123456",
                    source: "provider response billing fixture",
                },
            }],
        });
        const result = await engine.runTurn({
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "settle the call" }],
            provider,
        });
        const requests = await db.test_provider_requests.all<{
            cost_kind: string;
            cost_amount: string;
            cost_currency: string;
            cost_usd_equivalent: string;
            cost_source: string;
        }>({ turn_id: result.turnId });
        assert.deepEqual(requests.map(({ cost_kind, cost_amount, cost_currency, cost_usd_equivalent, cost_source }) => ({
            kind: cost_kind,
            amount: { amount: cost_amount, currency: cost_currency },
            usdEquivalent: cost_usd_equivalent,
            source: cost_source,
        })), [{
            kind: "charged",
            amount: { amount: "123456", currency: "USDTICK" },
            usdEquivalent: "0.0000123456",
            source: "provider response billing fixture",
        }]);
        const loopUsage = await engine.loopUsage(loopId);
        assert.equal(loopUsage.accounting.costUsd, "0.0000123456");
    } finally {
        await db.close();
    }
});

test("{§emission-admission} finish=length is forensic evidence: a frame that lost its boundary after a statement is admitted with the loss as its diagnostic", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const lostPrefix = [
            "",
            "````READ (workspace:///missing)````",
            "````EDIT (workspace:///notes.md",
        ].join("\n");
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [{ assistant: { content: lostPrefix, reasoning: null, finishReason: "length" } }],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.emissionAttempts, 1, "the frame is admitted on its first attempt");
        const attempts = await db.test_turn_attempts.all<{
            accepted: number;
            finish_reason: string | null;
            parse_errors: string;
        }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, finish_reason }) => ({ accepted, finish_reason })), [
            { accepted: 1, finish_reason: "length" },
        ]);
        assert.deepEqual(JSON.parse(attempts[0].parse_errors).map(({ line, column, source }: { line: number; column: number; source: string }) => ({ line, column, source })), [{
            line: 3,
            column: 0,
            source: "grammar",
        }], "the admitted attempt preserves one tail fact and no recovered-tail diagnostics");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: result.turnId });
        assert.equal(rows.filter(({ op, origin }) => origin === "model" && op === "READ").length, 1, "the statement that closed before the loss dispatched");
        assert.equal(rows.filter(({ op, origin }) => origin === "model" && op === "error").length, 1, "the loss is a row");
        const turn = await db.test_get_turn.get<{ packet: string; finish_reason: string | null }>({ id: result.turnId });
        assert.equal(turn?.finish_reason, "length", "the provider's finish reason is evidence, not a rejection rule");
        assert.equal(
            (JSON.parse(turn?.packet ?? "{}") as { assistant?: { content?: string } }).assistant?.content,
            lostPrefix,
        );
    } finally {
        await db.close();
    }
});

test("{§slot-order}: a malformed continuation heading preserves siblings without authorizing completion", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const rejected = "````EDIT (workspace:///proof.md)\nthe valid sibling is written\n````\n````NOTE [{\"content\":\"keep\nthis\",\"status\":\"pending\"}]\n````";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(rejected)],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.status, 102, "the visible heading failure prevents same-turn completion");
        assert.equal(result.emissionAttempts, 1);
        const attempts = await db.test_turn_attempts.all<{
            accepted: number;
            parse_errors: string;
        }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
        const parseErrors = JSON.parse(attempts[0].parse_errors) as Array<{ message: string; line: number; source: string }>;
        assert.equal(parseErrors.length, 1, "one bounded diagnostic for the malformed continuation heading");
        assert.equal(parseErrors[0]?.message, "unexpected `[` (`[metadata]` modifier opener); expected operation fence header, operation-heading line ending, closing fence, or body content");
        assert.deepEqual({ line: parseErrors[0]?.line, source: parseErrors[0]?.source }, { line: 4, source: "parser" });

        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string }>({
            turn_id: result.turnId,
        });
        assert.equal(rows.some(({ origin, op }) => origin === "model" && op === "EDIT"), true);
        const landed = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/proof.md",
            scheme: "workspace",
            name: "body",
        });
        assert.equal(landed?.content, "the valid sibling is written");
    } finally {
        await db.close();
    }
});

test("{§operation-results} {§matcher-prefix-claims} a syntactically legal $fC matcher failure is the operation's own refusal, admitted once, and made model-visible (#12/#16)", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const malformed = "\n````FIND (workspace:///x) $fC````\n\n````NOTE\ninspect the results next\n````";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid(malformed),
                invalid("\n````SEND\nthe matcher was malformed\n````"),
            ],
        });

        const failed = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "inspect the code" }],
        });

        assert.equal(failed.status, 102);
        assert.equal(failed.emissionAttempts, 1, "a trustworthy frame is not blindly resampled");
        assert.equal(failed.emissionExhausted, false);
        assert.ok(
            failed.outcomes.some(({ op, status }) => op === "FIND" && status === 400),
            "the malformed matcher is the FIND's own refusal, not a parse error",
        );
        const attempts = await db.test_turn_attempts.all<{
            accepted: number;
            parse_errors: string;
        }>({ turn_id: failed.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
        assert.equal(JSON.parse(attempts[0].parse_errors).length, 0, "a refused matcher is no parse error");

        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            status_rx: number;
            op: string;
            origin: string;
            rx: string;
        }>({ turn_id: failed.turnId });
        const authored = rows.filter(({ origin, op }) =>
            origin === "model" && (op === "NOTE" || op === "FIND" || op === "error"));
        assert.deepEqual(
            authored.map(({ op, status_rx }) => ({ op, status_rx })),
            [
                { op: "FIND", status_rx: 400 },
                { op: "NOTE", status_rx: 200 },
            ],
            "the refused FIND and the note retain their authored order; no error row is minted",
        );
        const refusal = JSON.parse(authored.find(({ op }) => op === "FIND")!.rx) as {
            problem?: { type?: string; detail?: string; stage?: string; recovery?: string };
        };
        assert.equal(refusal.problem?.type, "https://problems.plurnk.xyz/grammar/matcher/unreadable-pattern");
        assert.match(refusal.problem?.detail ?? "", /not a valid jsonpath/i);
        assert.equal(refusal.problem?.stage, "matcher");
        // {§parse-recovery}: the parser's working form rides as the Problem's recovery.
        assert.equal(refusal.problem?.recovery,
            "Write an RFC 9535 JSONPath after `$`, such as `$.items[?(@.price>500)]`.");

        const recovery = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "inspect the code" }],
        });
        const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: recovery.turnId });
        const packet = JSON.parse(packetRow?.packet ?? "{}");
        assert.match(packetSection(packet, "errors"), /"status":400,"path":"log:\/\/\/[^"]*\/FIND"/);
        assert.match(
            packetSection(packet, "log"),
            /not a valid jsonpath/i,
            "the next turn receives the parser's actionable diagnostic",
        );
    } finally {
        await db.close();
    }
});

test("{§op-shapes}: a READ carrying pasted lines keeps them as a NOTE without treating them as selection", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const renderedRead = [
            "2286<@et6xE>\t// Set debug flag from environment if not already set",
            "2287<@alreh>\tif !requireDebug {",
            "2288<@84fBk>\t\trequireDebug = true;",
        ].join("\n");
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid([
                    `\`\`\`\`READ (evaluator/functions.go) <2286,2292>
${renderedRead}
\`\`\`\``,
                    "````NOTE\ninspect the result\n````",
                ].join("\n\n")),
                invalid("\n````SEND\ndone\n````"),
            ],
        });

        const failed = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "inspect the code" }],
        });

        assert.equal(failed.status, 102);
        assert.equal(failed.emissionAttempts, 1);
        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            origin: string;
            rx: string;
            attrs: string;
        }>({ turn_id: failed.turnId });
        assert.equal(
            rows.some(({ origin, op }) => origin === "model" && op === "READ"),
            true,
            "the retrieval dispatches bodyless after its annotation",
        );
        assert.equal(rows.some(({ origin, op }) => origin === "model" && op === "error"), false);
        assert.equal(rows.filter(({ origin, op }) => origin === "model" && op === "NOTE").length, 2, "the annotation and explicit NOTE are separate memories");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const turnOps = sources.find((row) => row.turn_id === failed.turnId && row.kind === "ops");
        assert.ok(turnOps, "the admitted source remains durable independently of result rows");
        assert.match(
            turnOps.content,
            /@et6xE/,
            "the durable turnOps row preserves the submitted program exactly",
        );

        const recovery = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "inspect the code" }],
        });
        const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: recovery.turnId });
        const packet = JSON.parse(packetRow?.packet ?? "{}");
        const log = packetSection(packet, "log");
        assert.match(packetSection(packet, "emission-history"), /```NOTE\n2286<@et6xE>/u, "pasted text is literal memory");
        assert.doesNotMatch(packetSection(packet, "notices"), /takes no body|not used/u, "normalization adds no repair lecture");
        assert.doesNotMatch(
            log,
            /@et6xE/,
            "the annotation body is not duplicated in its paired receipt",
        );
    } finally {
        await db.close();
    }
});

test("{§matcher-prefix-claims} a bounded malformed operation defers same-turn completion until the model observes it", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("\n````FIND (**) /unterminated[````\n\n````SEND\ndone\n````"),
            ],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "search" }],
        });

        assert.equal(result.emissionAttempts, 1);
        assert.equal(result.status, 102, "the malformed operation's result keeps the turn non-terminal");
        assert.ok(
            result.outcomes.some(({ op, status }) => op === "FIND" && status === 400),
            "the fumbled matcher is the FIND's own refusal, an unseen failure that defers completion",
        );
        assert.ok(
            result.outcomes.some(({ op, status }) => op === "SEND" && status === 200),
            "delivery is independent of the unseen failure ({§loop-completion})",
        );
        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            status_rx: number;
            op: string;
            origin: string;
        }>({ turn_id: result.turnId });
        const authored = rows.filter(({ origin }) =>
            origin === "model");
        assert.deepEqual(
            authored.map(({ op, status_rx }) => ({ op, status_rx })),
            [
                { op: "FIND", status_rx: 400 },
                { op: "SEND", status_rx: 200 },
            ],
        );
    } finally {
        await db.close();
    }
});

test("{§matcher-prefix-claims}: a third COPY operand preserves siblings, source evidence, and the actual parser diagnostic", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, {
            workspaceId, scheme: "workspace", pathname: "/src.md",
            content: "one\ntwo\nthree", mimetype: "text/markdown",
        });
        const source = [
            "Unexecuted interstitial text.",
            PlurnkParser.frame("READ (workspace:///src.md) <1>", null),
            PlurnkParser.frame("COPY (workspace:///src.md) <2,3> (to) (workspace:///slice.md)", null),
            PlurnkParser.frame("READ (workspace:///src.md) <3>", null),
        ].join("\n\n");
        const provider = new AttemptWitness({ contextWindow: 100_000, responses: [invalid(source), valid()] });
        const context = { workspaceId, sessionId, loopId };
        const first = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(first.status, 102);
        assert.deepEqual(first.outcomes.map(({ op, status }) => [op, status]), [["NOTE", 200], ["READ", 200], ["READ", 200], [null, 400]], "the interstitial text is the turn's NOTE beside the operations ({§outside-text})");
        const { sequence } = (await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId }))!;
        const [readSource] = PlurnkParser.parseStatements(PlurnkParser.frame(`READ (ops://subject/1/${sequence}) <1,-1>`, null)).items;
        assert.ok(readSource.kind === "statement");
        // Source identity never depends on the reader ({§turn-source-resources}); the subject's next packet is under test.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const retained = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: readSource.statement });
        assert.equal(retained.status, 200);
        assert.ok("content" in retained);
        assert.equal(retained.content, source, "recovery never rewrites the original submitted program");
        const entries = await db.test_list_entries_by_workspace_workspace_pathname.all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.equal(entries.some(({ pathname }) => pathname === "/slice.md" || pathname === "/to"), false);

        const next = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const failures = logEntries(packet).filter(({ status }) => status === 400);
        assert.equal(failures.length, 1, "only the malformed COPY has a failure receipt");
        const problem = failures[0].problem as Record<string, unknown>;
        assert.equal(problem.type, "https://problems.plurnk.xyz/grammar/parser/invalid-operation-syntax");
        assert.equal(problem.detail,
            "unexpected `(` (`(path)` slot opener); expected operation fence header, operation-heading line ending, or closing fence");
        assert.equal(problem.siblingsRetained, true);
        assert.equal(problem.line, 6);
        assert.equal(problem.column, 41);
        // {§parse-recovery} The row records the statement the parser refused, as written; the packet shows the model nothing new.
        const [refused] = await db.test_log_entries_by_session_op_full.all<{ attrs: string }>({ session_id: sessionId, op: "error" });
        const attempt = (JSON.parse(refused.attrs) as { attempt?: { verb: string; text: string } }).attempt;
        assert.equal(attempt?.verb, "COPY");
        assert.ok(attempt?.text.startsWith(PlurnkParser.frame("COPY (workspace:///src.md) <2,3> (to) (workspace:///slice.md)", null).split("\n")[0]), attempt?.text);
        assert.equal(Object.hasOwn(problem, "attempt"), false);
        assert.equal(JSON.stringify(failures[0]).includes("attempt"), false, "the attempt never reaches the model's packet");
    } finally { await db.close(); }
});

for (const heading of ["KILL <1> (workspace:///trim.md)", "KILL → workspace:///trim.md <1>"]) {
    test(`{§fence-pairing}: ${heading} missing its closer preserves the following READ and its result`, async () => {
        const { db, workspaceId, sessionId, loopId, engine } = await setup();
        try {
            await seedEntryWithChannel(db, {
                workspaceId, scheme: "workspace", pathname: "/trim.md",
                content: "one\ntwo\nthree", mimetype: "text/markdown",
            });
            const source = [`\`\`\`${heading}`, "```READ (workspace:///trim.md) <1,-1>", "```"].join("\n");
            const provider = new AttemptWitness({ contextWindow: 100_000, responses: [invalid(source), valid()] });
            const context = { workspaceId, sessionId, loopId };
            const first = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(first.status, 102, "the addressed KILL is a mutation, not completion");
            assert.deepEqual(first.outcomes.map(({ op, status }) => [op, status]), [["KILL", 200], ["READ", 200]]);

            const { sequence } = (await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId }))!;
            const [readSource] = PlurnkParser.parseStatements(PlurnkParser.frame(`READ (ops://subject/1/${sequence}) <1,-1>`, null)).items;
            assert.ok(readSource.kind === "statement");
            // Source identity never depends on the reader ({§turn-source-resources}); the subject's next packet is under test.
            const observer = await insertSession(db, workspaceId, null, "observer");
            const retained = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: readSource.statement });
            assert.equal(retained.status, 200);
            assert.ok("content" in retained);
            assert.equal(retained.content, source, "recovery preserves the original emission");

            const next = await engine.runTurn({ ...context, provider, messages: [] });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
            const observations = logEntries(packet).filter(({ logPath }) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(logPath));
            assert.equal(observations.length, 1, "the following turn receives the recovered READ's result");
            assert.match(String(observations[0].body), /^1<@[0-9A-Za-z]{5}>two\n2<@[0-9A-Za-z]{5}>three\n$/);
        } finally { await db.close(); }
    });
}

test("{§op-shapes} a malformed COPY destination cannot dispatch or materialize", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/src.md",
            content: "one\ntwo\nthree",
            mimetype: "text/markdown",
        });
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid("````COPY (workspace:///src.md) <2,3> (workspace:///slice.md) <0>:````\n````NOTE\ninspect the copy result\n````")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "copy lines two and three" }],
        });

        assert.equal(result.emissionAttempts, 1, "the bounded interior error retains the surrounding turn");
        assert.equal(result.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({
            turn_id: result.turnId,
        });
        assert.equal(
            rows.some(({ op, origin }) => op === "COPY" && origin === "model"),
            false,
            "the malformed selection never becomes a dispatchable COPY AST",
        );
        assert.ok(
            rows.some(({ op, origin, status_rx }) => op === "error" && origin === "model" && status_rx === 400),
            "the destination admission error remains observable",
        );
        const entries = await db.test_list_entries_by_workspace_workspace_pathname.all<{ scheme: string; pathname: string }>({
            workspace_id: workspaceId,
        });
        assert.equal(entries.some(({ pathname }) => pathname === "/slice.md"), false);
        assert.equal(entries.some(({ pathname }) => pathname === "/slice.md%3C0%3E:"), false);
        const source = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/src.md",
            scheme: "workspace",
            name: "body",
        });
        assert.equal(source?.content, "one\ntwo\nthree", "admission fails before any source or destination mutation");
    } finally {
        await db.close();
    }
});

test("{§op-shapes} two WAITs keep the single-turn boundary: the program is admitted whole", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("````WAIT\nWait.\n````\n````WAIT\nContinue the task.\n````\n\n````EDIT (workspace:///two-waits.md)\nvalue\n````"),
            ],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.emissionAttempts, 1, "the first emission is admitted");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors)]), [[1, []]]);
        const rows = await db.test_log_entries_by_turn.all<{
            op: string;
            origin: string;
        }>({ turn_id: result.turnId });
        assert.equal(rows.filter(({ op, origin }) => op === "EDIT" && origin === "model").length, 1, "the operation beside the two WAITs ran");
        assert.equal(rows.filter(({ op }) => op === "WAIT").length, 2, "each WAIT is a row of the one admitted turn");
    } finally {
        await db.close();
    }
});

test("{§parse-recovery} {§parse-recovery}: a boundary lost after a statement is a row, not a resample: the prefix runs and the next packet carries the lexer's reason", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const body = "The example:\n```ts\nconst value = 42;\n```\nVerified.";
        // An unfinished target slot at the end of the input is the one boundary loss left; a missing
        // or mismatched closer never is ({§operation-fences}).
        const lost = [
            PlurnkParser.frame("EDIT (workspace:///before-loss.md)", "kept"),
            "````SEND (session://reviewer",
        ].join("\n");
        const corrected = PlurnkParser.frame("SEND [200]", body);
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(lost), invalid(corrected)],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "Report the result with its code example." }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.turnIds.length, 3, "initialization, the admitted turn with its loss, and the reply");
        const [, lossTurn, replyTurn] = result.turnIds;
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: lossTurn });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors).map(({ line, column, source }: { line: number; column: number; source: string }) => ({ line, column, source }))]), [[1, [{
            line: 4, column: 0, source: "grammar",
        }]]], "one admitted attempt, the tail preserved as its diagnostic");
        const [{ message }] = JSON.parse(attempts[0].parse_errors) as [{ message: string }];
        assert.equal(provider.packets.length, 2, "no private resample: the loss is the model's to see");
        assert.ok(provider.packets[1]?.includes(message), "the next packet carries the parser-owned boundary diagnosis");
        const replyAttempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: replyTurn });
        assert.deepEqual(replyAttempts.map(({ accepted }) => accepted), [1]);
        const rows = await db.engine_render_log.all<{ op: string; origin: string; tx: string; rx: string }>({ session_id: sessionId });
        assert.equal(rows.filter(({ op, origin }) => op === "EDIT" && origin === "model").length, 1, "the statement that closed before the loss ran");
        assert.equal(rows.filter(({ op, origin }) => op === "SEND" && origin === "model").length, 1);
        const loss = rows.find(({ op, origin }) => op === "error" && origin === "model");
        assert.ok(loss, "the loss is a failed row");
        assert.equal(JSON.parse(loss.rx).problem?.detail, message);
        const entries = await db.test_list_entries_by_workspace_workspace_pathname.all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.equal(entries.some(({ pathname }) => pathname === "/before-loss.md"), true);
        const send = rows.find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.equal(JSON.parse(send!.tx).body?.raw, body, "the durable message retains the complete literal body");
    } finally { await db.close(); }
});

test("{§emission-admission} exhausted private attempts expose the latest response and the parser's diagnostic on one recovery turn", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    const latestRejected = "\n````READ (file:///main.go";
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("````READ (workspace:///first-private-invalid"),
                invalid("````READ (workspace:///second-private-invalid"),
                invalid(latestRejected),
                continuing("recovered"),
                valid("finished"),
            ],
        });
        const generate = provider.generate.bind(provider);
        let providerCalls = 0;
        provider.generate = async (args) => {
            providerCalls++;
            if (providerCalls === 4) {
                const rows = await db.engine_render_log.all<{ initial_folded: string; folded: string; attrs: string }>({ session_id: sessionId });
                const rejectedMirror = rows.find((row) => JSON.parse(row.attrs).kind === "emissionAttempt");
                assert.equal(rejectedMirror?.initial_folded, "[[1,-1]]", "the recovery packet does not require durably visible malformed content");
                assert.equal(rejectedMirror?.folded, "[]", "initial suppression does not trim the rejected program");
            }
            return await generate(args);
        };

        const result = await engine.runLoop({
            provider,
            workspaceId,
            sessionId,
            loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.result.status, 200);
        assert.equal(result.reason, "external", "the completed message concludes through the ordinary loop lifecycle");
        assert.equal(result.turnIds.length, 4, "initialization, rejected, informed recovery, and final turns are durable");
        assert.equal(provider.packets.length, 5);
        assert.equal(new Set(provider.packets.slice(0, 3)).size, 1, "private attempts retain one exact packet");
        assert.notEqual(provider.packets[3], provider.packets[2], "the informed recovery has its own packet");
        assert.match(provider.packets[3], /Response rejected before dispatch; no operations were performed\./);
        assert.match(provider.packets[3], /2:````READ \(file:\/\/\/main\.go/);
        assert.doesNotMatch(provider.packets[3], /first private invalid|second private invalid/);
        // {§emission-admission} — the informed turn carries the parser's diagnostic and position.
        assert.match(provider.packets[3], /Parser: .+ @ \d+:\d+/, "the parser's diagnosis reaches the informed turn");
        assert.doesNotMatch(provider.packets[4], /2:````READ \(file:\/\/\/main\.go/, "the rejected emission is projected only into its recovery packet");

        const [, failedTurnId, recoveryTurnId, finalTurnId] = result.turnIds;
        const failedTurn = await db.test_get_turn.get<{ status: number; packet: string }>({ id: failedTurnId });
        assert.equal(failedTurn?.status, 102);
        assert.equal((JSON.parse(failedTurn?.packet ?? "{}") as { assistant?: unknown }).assistant, undefined);
        const recoveryTurn = await db.test_get_turn.get<{ status: number }>({ id: recoveryTurnId });
        assert.equal(recoveryTurn?.status, 102);
        const finalTurn = await db.test_get_turn.get<{ status: number }>({ id: finalTurnId });
        assert.equal(finalTurn?.status, 200);

        const firstAttempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: failedTurnId });
        const recoveryAttempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: recoveryTurnId });
        assert.deepEqual(firstAttempts.map(({ accepted }) => accepted), [0, 0, 0]);
        assert.deepEqual(recoveryAttempts.map(({ accepted }) => accepted), [1]);

        const rows = await db.engine_render_log.all<{
            turn_seq: number;
            origin: string;
            op: string | null;
            rx: string;
            initial_folded: string;
            folded: string;
            attrs: string;
        }>({ session_id: sessionId });
        const rejectedMirror = rows.find((row) => JSON.parse(row.attrs).kind === "emissionAttempt");
        assert.ok(rejectedMirror !== undefined);
        assert.equal(rejectedMirror.turn_seq, 2, "the rejected emission belongs to the first packet-bearing turn");
        assert.equal(rejectedMirror.initial_folded, "[[1,-1]]", "the rejected model item remains durably body-suppressed");
        assert.equal(rejectedMirror.folded, "[]", "the rejected program remains readable");
        assert.match(rejectedMirror.rx, /````READ \(file:\/\/\/main\.go/);
        assert.equal(rows.filter((row) => row.origin === "model" && row.op === "READ").length, 0, "no rejected operation dispatches");
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "the lifeline does not fabricate an operation failure");
    } finally {
        await db.close();
    }
});

class GarbageProvider extends AttemptWitness {
    garbage: number;
    readonly #kind: "invalid_response" | "generation_failed";
    constructor(garbage: number, responses: ConstructorParameters<typeof AttemptWitness>[0]["responses"], kind: "invalid_response" | "generation_failed" = "invalid_response") {
        super({ contextWindow: 100_000, responses });
        this.garbage = garbage;
        this.#kind = kind;
    }
    override async generate(...args: Parameters<AttemptWitness["generate"]>): ReturnType<AttemptWitness["generate"]> {
        if (this.garbage > 0) {
            this.garbage -= 1;
            const accounting = { provider: "provider:mock", model: this.model, outcome: "error" as const, cost: { kind: "unknown" as const, reason: "torn frame" } };
            const settle = await args[0].observeRequest?.({ provider: "provider:mock", model: this.model });
            await settle?.(accounting);
            throw this.#kind === "invalid_response"
                ? new ProviderError("mock", "invalid_response", "Failed to process successful response", { accounting: [accounting] })
                : new ProviderError("mock", "generation_failed", "The provider ended generation with an error (MALFORMED_FUNCTION_CALL).", {
                    accounting: [accounting], extensions: { stage: "provider-response", finishReason: "error", rawFinishReason: "MALFORMED_FUNCTION_CALL" },
                });
        }
        return super.generate(...args);
    }
}

test("{§provider-generation-failed} {§engine-rails} a provider-declared generation error strikes like an invalid response and is never re-issued; the loop continues", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    // A recovery wait here would last a minute, past the runner's bound: a loop that ends in seconds took none.
    const priorBackoff = process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF;
    process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF = "60000";
    try {
        const provider = new GarbageProvider(1, [
            { assistant: { content: "\n````SEND [200]\ndone\n````", reasoning: null } },
        ], "generation_failed");
        const started = Date.now();
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.result.status, 200, "one generation error is one strike, never a loop death");
        assert.equal(result.reason, "external");
        assert.ok(Date.now() - started < 20_000, "no provider recovery wait: the next turn asks again at once");
        const problems = await db.test_log_entries_by_session_op_full.all<{ rx: string }>({ session_id: sessionId, op: "error" });
        assert.ok(problems.some(({ rx }) => rx.includes("generation-failed") && rx.includes("MALFORMED_FUNCTION_CALL")), "the failed attempt is durable with its raw finish reason");
    } finally {
        if (priorBackoff === undefined) delete process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF;
        else process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF = priorBackoff;
        await db.close();
    }
});

test("{§provider-generation-failed} {§engine-rails} three consecutive generation errors strike out through the rail", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new GarbageProvider(3, [
            { assistant: { content: "\n````SEND [200]\nnever reached\n````", reasoning: null } },
        ], "generation_failed");
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.result.status, 500);
        assert.equal(provider.garbage, 0);
    } finally { await db.close(); }
});

test("{§engine-rails} Contract Strikes: one invalid provider response strikes; the loop continues", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new GarbageProvider(1, [
            { assistant: { content: "\n````SEND [200]\ndone\n````", reasoning: null } },
        ]);
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.result.status, 200, "one torn frame is one strike, never a loop death");
        assert.equal(result.reason, "external", "the loop concluded through its ordinary lifecycle");
    } finally { await db.close(); }
});

test("{§engine-rails} Contract Strikes: three consecutive invalid provider responses strike out", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new GarbageProvider(3, [
            { assistant: { content: "\n````SEND [200]\nnever reached\n````", reasoning: null } },
        ]);
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.reason, "strike_threshold", "sustained provider garbage ends through the rail");
        assert.equal(result.result.status, 500);
        assert.equal(provider.garbage, 0, "all three violations were spent crossing the threshold");
    } finally { await db.close(); }
});

test("{§engine-rails} Contract Strikes: consecutive emission exhaustions strike out at three; a clean turn clears", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        // {§parse-recovery} — an unfinished target at the end of the input is the exhaustion shape.
        const cut = { assistant: { content: "````READ (workspace:///no-ops-here", reasoning: null } };
        const good = (body: string) => ({ assistant: { content: `
\`\`\`\`FIND (log:///**) <1,1>\`\`\`\`
\`\`\`\`NOTE
${body}
\`\`\`\``, reasoning: null } });
        const done = { assistant: { content: "\n````SEND [200]\nfinished\n````", reasoning: null } };
        // Two exhaustions (3 attempts each), a clean turn clearing the streak,
        // then three consecutive exhaustions striking out on the third.
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                cut, cut, cut, // exhaustion 1 -> strike 1
                cut, cut, cut, // exhaustion 2 -> strike 2
                good("recovered"), // clean turn -> streak clears
                cut, cut, cut, // strike 1
                cut, cut, cut, // strike 2
                cut, cut, cut, // strike 3 -> out
                done, // never reached
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.reason, "strike_threshold", "the rail, not a bespoke terminal, ends the loop");
        assert.equal(result.result.status, 500);
        assert.equal(provider.packets.length, 16, "the third consecutive exhaustion crossed; the queued conclusion was never requested");
    } finally { await db.close(); }
});
test("{§emission-admission} a frame exhaustion shares prior contract strikes and retains evidence without another request", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        // {§parse-recovery} — only an unfinished heading slot at the end of the input rejects.
        const rejected = "````READ (workspace:///unfinished";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                // Two admitted turns each struck by a bounded heading failure, a third COPY operand
                // ({§matcher-prefix-claims}); a fumbled matcher would not strike ({§matcher-prefix-claims}).
                invalid("````READ (workspace:///absent)````\n````COPY (workspace:///a) (workspace:///b) (workspace:///c)````"),
                invalid("````READ (workspace:///absent)````\n````COPY (workspace:///a) (workspace:///b) (workspace:///c)````"),
                invalid(rejected), invalid(rejected), invalid(rejected),
                valid("Not requested."),
            ],
        });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxStrikes: 3, messages: [] });
        assert.equal(result.result.status, 500);
        assert.equal(result.reason, "strike_threshold");
        assert.equal(provider.packets.length, 5, "two admitted struck turns plus three private attempts; no fourth engine turn");
        assert.equal(new Set(provider.packets.slice(2)).size, 1, "private resampling remains cache-stable");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnIds.at(-1) });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 0]);
        for (const attempt of attempts) assert.deepEqual(JSON.parse(attempt.parse_errors).map(({ line, column, source }: { line: number; column: number; source: string }) => ({ line, column, source })), [{
            line: 1, column: 0, source: "grammar",
        }], "the undelivered diagnostic remains in forensic evidence");
        const [{ message }] = JSON.parse(attempts[0].parse_errors) as [{ message: string }];
        assert.ok(provider.packets.every((packet) => !packet.includes(message)), "the terminating exhaustion cannot deliver a future recovery packet");
    } finally { await db.close(); }
});

test("{§turn-source-resources} digest preserves rejected emissions as forensic artifacts without putting them in the accepted packet", async () => {
    // The surveys are the initialization program; with the preview off there is none and no digest stem for it.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-emission-digest-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const { db, workspaceId, sessionId, loopId, engine } = await setup(dbPath);
        // A workspace entry, so the workspace survey selects something and the initialization program exists.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
        const rejected = "````READ (workspace:///😀rejected bytes";
        try {
            const provider = new AttemptWitness({
                contextWindow: 100_000,
                responses: [
                    invalid(rejected, requestUsage(10, 2), "rejected reasoning"),
                    valid("accepted bytes", requestUsage(10, 3)),
                ],
            });
            await engine.runTurn({
                provider,
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "do the task" }],
            });
        } finally {
            await db.close();
        }

        try {
            Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
            const stems = await digestStems(digestDir);
            assert.equal(
                await readFile(join(digestDir, `${stems[1]}.attempt001.rejected.assistant.md`), "utf8"),
                rejected,
            );
            const rejectedResponse = JSON.parse(
                await readFile(join(digestDir, `${stems[1]}.attempt001.rejected.response.json`), "utf8"),
            ) as { assistant?: { content?: string } };
            assert.equal(rejectedResponse.assistant?.content, rejected);
            const parseErrors = JSON.parse(
                await readFile(join(digestDir, `${stems[1]}.attempt001.rejected.parse-errors.json`), "utf8"),
            ) as Array<{ line?: number; column?: number; source?: string }>;
            assert.deepEqual(
                { line: parseErrors[0]?.line, column: parseErrors[0]?.column, source: parseErrors[0]?.source },
                { line: 1, column: 0, source: "grammar" },
                "the persisted digest evidence retains the boundary's coordinates",
            );
            assert.equal(
                await readFile(join(digestDir, `${stems[1]}.assistant.md`), "utf8"),
                "\n````SEND [200]\naccepted bytes\n````\n",
            );
            const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
            assert.match(markdown, /rejected-emissions=1\/2/);
            assert.doesNotMatch(markdown, /rejected bytes/, "rejected content stays out of the accepted-turn waterfall");
            const reasoning = await readFile(join(digestDir, "reasoning.md"), "utf8");
            assert.match(reasoning, /Attempt 1 - rejected/);
            assert.match(reasoning, /rejected reasoning/);
            assert.match(reasoning, /never closed - add `\)`/, "the rejected attempt's own diagnostic is in the reasoning chronology");
            assert.match(reasoning, /Attempt 2 - admitted/);
            const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
                turn_attempts: Array<{ accepted: boolean }>;
            };
            assert.deepEqual(json.turn_attempts.map(({ accepted }) => accepted), [false, true]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});

test("{§engine-rails} a provider outage after a rejected emission is absorbed inside the turn and every issued call stays durable", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("````READ (workspace:///rejected-before-outage", requestUsage(10, 2)),
                valid("done", requestUsage(10, 2)),
            ],
        });
        const realGenerate = provider.generate.bind(provider);
        let calls = 0;
        provider.generate = async (args) => {
            calls++;
            if (calls === 2) {
                provider.packets.push(JSON.stringify(args.messages));
                const accounting: ProviderRequestAccounting = {
                    provider: "provider:mock",
                    model: provider.model,
                    outcome: "error",
                    cost: { kind: "unknown", reason: "provider went offline before reporting monetary evidence" },
                };
                const settle = await args.observeRequest?.({ provider: accounting.provider, model: accounting.model });
                await settle?.(accounting);
                throw new ProviderError("mock", "network_failure", "provider went offline", { accounting: [accounting] });
            }
            return await realGenerate(args);
        };

        const turn0 = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(turn0.status, 200, "the outage is absorbed: the turn completes on the re-issued call");
        assert.equal(turn0.providerParked, false);

        assert.equal(provider.packets.length, 3, "the rejected attempt, the outage, and the recovered call");
        assert.equal(
            new Set(provider.packets).size,
            1,
            "invalid-emission and outage recovery both preserve the exact same-packet request",
        );
        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        const requests = await db.test_provider_requests.all<{
            outcome: string;
            usage_input: number | null;
            cost_kind: string;
            cost_amount: string | null;
            cost_reason: string | null;
        }>({ turn_id: turn!.id });
        assert.deepEqual(requests.map(({ outcome, usage_input, cost_kind, cost_amount, cost_reason }) => ({
            outcome,
            input: usage_input,
            cost: cost_kind === "unknown" ? cost_reason : cost_amount,
        })), [
            { outcome: "response", input: 10, cost: "0.012" },
            { outcome: "error", input: null, cost: "provider went offline before reporting monetary evidence" },
            { outcome: "response", input: 10, cost: "0.012" },
        ]);
        const accounting = (await engine.loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, null, "the response-less failure leaves the total unknown");
        assert.equal(accounting.knownCostUsd, "0.024", "the expressible subtotal survives");
        assert.equal(accounting.usage, null);
        assert.equal(accounting.knownUsage?.inputTokens, 20);
        const attempts = await db.test_turn_attempts.all<{
            state: "response" | "error";
            accepted: number | null;
            failure: string | null;
        }>({ turn_id: turn!.id });
        assert.deepEqual(attempts.map(({ state, accepted }) => ({ state, accepted })), [
            { state: "response", accepted: 0 },
            { state: "error", accepted: null },
            { state: "response", accepted: 1 },
        ]);
        assert.equal(JSON.parse(attempts[1].failure!).status, 503);
    } finally {
        await db.close();
    }
});

test("{§emission-admission} a classified provider error retains billed usage and authoritative charge without a fabricated response", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({ contextWindow: 100_000, responses: [] });
        provider.generate = async (args) => {
            const accounting: ProviderRequestAccounting = {
                provider: "provider:plurnk",
                model: provider.model,
                outcome: "error",
                status: 422,
                usage: requestUsage(8, 3, 0, 2),
                cost: {
                    kind: "charged",
                    amount: { amount: "0.00000042", currency: "XMR" },
                    usdEquivalent: "0.000071",
                    source: "plurnk endpoint settlement",
                },
            };
            const settle = await args.observeRequest?.({ provider: accounting.provider, model: accounting.model });
            await settle?.(accounting);
            throw new ProviderError(
                "plurnk",
                "grammar_invalid",
                "The endpoint rejected the billed emission.",
                {
                    status: 422,
                    accounting: [accounting],
                },
            );
        };

        await assert.rejects(
            () => engine.runTurn({
                provider,
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "do the task" }],
            }),
            (error: unknown) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.status, 422);
                return true;
            },
        );

        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        const request = (await db.test_provider_requests.all<{
            outcome: string;
            status: number;
            usage_input: number;
            usage_output_text: number;
            usage_input_cache_read: number;
            cost_kind: string;
            cost_amount: string;
            cost_currency: string;
            cost_usd_equivalent: string;
        }>({ turn_id: turn!.id }))[0];
        assert.equal(request.outcome, "error");
        assert.equal(request.status, 422);
        assert.equal(request.usage_input, 8);
        assert.equal(request.usage_output_text, 3);
        assert.equal(request.usage_input_cache_read, 2);
        assert.equal(request.cost_kind, "charged");
        assert.equal(request.cost_amount, "0.00000042");
        assert.equal(request.cost_currency, "XMR");
        assert.equal(request.cost_usd_equivalent, "0.000071");
        assert.equal((await engine.loopUsage(loopId)).accounting.costUsd, "0.000071");

        const attempts = await db.test_turn_attempts.all<{
            state: string;
            response: string | null;
            failure: string;
        }>({ turn_id: turn!.id });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].state, "error");
        assert.equal(attempts[0].response, null);
        assert.equal(JSON.parse(attempts[0].failure).status, 422);
    } finally {
        await db.close();
    }
});

test("{§provider-surface} Core rejects a ProviderError whose accounting differs from its observed physical requests", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({ contextWindow: 100_000, responses: [] });
        const requestAccounting: ProviderRequestAccounting = {
            provider: "provider:mock",
            model: provider.model,
            outcome: "error",
            status: 503,
            cost: { kind: "unknown", reason: "provider supplied no monetary evidence" },
        };
        provider.generate = async (args) => {
            const settle = await args.observeRequest?.({
                provider: requestAccounting.provider,
                model: requestAccounting.model,
            });
            await settle?.(requestAccounting);
            throw new ProviderError(
                "mock",
                "network_failure",
                "provider omitted its accounting return",
            );
        };
        await assert.rejects(
            () => engine.runTurn({
                provider,
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "do the task" }],
            }),
            (error: unknown) => {
                assert.ok(error instanceof ProviderAccountingIntegrityError);
                assert.match(error.message, /does not match the cardinal requests observed by Core/);
                return true;
            },
        );

        assert.deepEqual((await engine.loopUsage(loopId)).accounting.requests, [requestAccounting]);
    } finally {
        await db.close();
    }
});

test("{§engine-rails} a complete-looking resource-interrupted attempt is persisted, never admitted or replayed, and the call is re-issued", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const content = "\n````SEND\nmust never dispatch\n````";
        const requestAccounting: ProviderRequestAccounting = {
            provider: "provider:mock",
            model: "interrupted-model",
            outcome: "response",
            usage: requestUsage(11, 7, 2, 3),
            cost: {
                kind: "estimated",
                amount: { amount: "0.02", currency: "USD" },
                source: "interrupted response fixture",
            },
        };
        const attempt: ProviderAttempt = {
            assistant: {
                content,
                reasoning: "partial reasoning",
                finishReason: "resource_interrupted",
                model: "interrupted-model",
            },
            assistantRaw: {
                content,
                reasoning: "partial reasoning",
                rawFinishReason: "insufficient_system_resource",
            },
            rawBody: {
                choices: [{ finish_reason: "insufficient_system_resource" }],
            },
            accounting: [requestAccounting],
            capacity: testProviderCapacity([], 100_000),
            meta: { requestId: "interrupted-1" },
        };
        const provider = new AttemptWitness({ contextWindow: 100_000, responses: [valid("done", requestUsage(10, 2))] });
        const realGenerate = provider.generate.bind(provider);
        let calls = 0;
        provider.generate = async (args) => {
            calls++;
            if (calls > 1) return await realGenerate(args);
            provider.packets.push(JSON.stringify(args.messages));
            const settle = await args.observeRequest?.({
                provider: requestAccounting.provider,
                model: requestAccounting.model,
            });
            await settle?.(requestAccounting);
            throw new ProviderError(
                "mock",
                "resource_interrupted",
                "The provider interrupted generation because inference resources were unavailable.",
                {
                    attempt,
                    accounting: [requestAccounting],
                    extensions: {
                        stage: "provider-response",
                        finishReason: "resource_interrupted",
                        rawFinishReason: "insufficient_system_resource",
                    },
                },
            );
        };

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.status, 200, "the interruption is absorbed: the re-issued call completes the turn");
        const durableRows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: loopId });
        const interruption = durableRows.find(({ op }) => op === "error");
        assert.equal((JSON.parse(interruption?.rx ?? "{}") as { problem?: { type?: string } }).problem?.type, "https://problems.plurnk.xyz/provider/mock/resource-interrupted", "the interruption is a durable _plurnk row");

        assert.equal(calls, 2, "one interrupted call and one re-issued call — never an emission reroll of the interrupted bytes");
        const turn = await db.test_latest_model_turn_in_loop.get<{
            id: number;
            status: number;
            packet: string;
            finish_reason: string | null;
            model: string;
            meta: string;
        }>({ loop_id: loopId });
        assert.equal(turn?.status, 200);
        const accounting = (await engine.loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, "0.032", "the interrupted request keeps its estimated cost beside the completed one");

        const attempts = await db.test_turn_attempts.all<{
            accepted: number;
            response: string;
            parse_errors: string;
            finish_reason: string | null;
            model: string;
        }>({ turn_id: turn.id });
        assert.equal(attempts.length, 2, "the interrupted attempt and the re-issued call");
        assert.equal(attempts[1].accepted, 1);
        assert.equal(attempts[0].accepted, 0);
        assert.deepEqual(JSON.parse(attempts[0].parse_errors), [], "the frame was complete but inadmissible");
        assert.equal(attempts[0].finish_reason, "resource_interrupted");
        assert.equal(attempts[0].model, "interrupted-model");
        const recordedAttempt = JSON.parse(attempts[0].response) as Omit<ProviderAttempt, "accounting">;
        assert.equal("accounting" in recordedAttempt, false, "the normalized ledger is the sole durable accounting representation");
        assert.equal(recordedAttempt.assistant.content, content);
        assert.equal(recordedAttempt.assistant.reasoning, "partial reasoning");
        assert.equal(
            (recordedAttempt.assistantRaw as { rawFinishReason?: string }).rawFinishReason,
            "insufficient_system_resource",
        );
        assert.deepEqual(recordedAttempt.rawBody, {
            choices: [{ finish_reason: "insufficient_system_resource" }],
        });

        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string | null }>({ turn_id: turn.id });
        assert.equal(
            rows.some(({ origin, tx }) => origin === "model" && (tx ?? "").includes("must never dispatch")),
            false,
            "no operation from the interrupted response dispatches",
        );
        assert.equal(rows.filter(({ origin, op }) => origin === "model" && op === "SEND").length, 1, "the re-issued call's emission is the one that dispatches");
        assert.equal(rows.filter(({ op }) => op === "error").length, 1, "the ProviderError remains one durable failure");
    } finally {
        await db.close();
    }
});

test("{§turn-record} an internal attempt-processing failure is not mislabeled as a provider failure", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const root = new Error("attempt classification failed");
        const classify = db.engine_classify_turn_attempt_response;
        const originalRun = classify.run.bind(classify);
        classify.run = async () => {
            throw root;
        };
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [valid("accepted")],
        });

        await assert.rejects(
            () => engine.runTurn({
                provider,
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "do the task" }],
            }),
            (error: unknown) => error === root,
        );
        const rows = await db.test_log_entries_by_loop.all<{ op: string }>({ loop_id: loopId });
        assert.equal(rows.filter(({ op }) => op === "error").length, 0, "core failures do not mint provider Problem rows");
        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        const attempts = await db.test_turn_attempts.all<{
            state: string;
            accepted: number | null;
            response: string | null;
        }>({ turn_id: turn!.id });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].state, "response");
        assert.equal(attempts[0].accepted, null, "classification failure never erases the observed response");
        assert.notEqual(attempts[0].response, null);
        assert.equal((await db.test_provider_requests.all({ turn_id: turn!.id })).length, 1);
        classify.run = originalRun;
    } finally {
        await db.close();
    }
});

test("{§emission-admission} a valid turn with a failed operation remains recoverable and model-visible", async () => {
    const { db, workspaceId, sessionId, loopId } = await setup();
    try {
        class Sealed {
            static manifest = {
                name: "sealed",
                channels: {},
                defaultChannel: "",
                category: "data",
                writableBy: ["_plurnk"],
                volatile: false,
                modelVisible: true,
            };
        }
        const schemes = new SchemeRegistry();
        schemes.register("sealed", new Sealed());
        const engine = new Engine({ db, schemes });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                {
                    assistant: {
                        content: "\n````EDIT (sealed:///x)\nvalue\n````\n\n````SEND\ndone\n````",
                        reasoning: null,
                    },
                },
                {
                    assistant: {
                        content: "\n````SEND [200]\ncannot write that resource\n````",
                        reasoning: null,
                    },
                },
            ],
        });

        const failed = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(failed.emissionAttempts, 1);
        assert.equal(failed.emissionExhausted, false);
        assert.ok(
            failed.outcomes.some(({ op, status }) => op === "EDIT" && status === 403),
            "the valid turn dispatches its failing operation",
        );

        const recovery = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: recovery.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.match(packetSection(packet, "errors"), /"status":403,"path":"log:\/\//, "the operation failure reaches the recovery turn");
        assert.match(packetSection(packet, "emission-history"), /EDIT \(sealed:\/\/\/x\)/u, "the failed operation remains in model-visible history");
        assert.match(packetSection(packet, "log"), /### log:\/\/\/1\/2\/\d+\/EDIT[^\n]*\n[^\n]*"status":403/u, "the failure stays beside it");
    } finally {
        await db.close();
    }
});

test("{§operation-results} a length finish surfaces the output allowance on the next packet, never grammar blame", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                { assistant: { content: "````SEND\nbig write, cut mid-wo\n````", reasoning: null, finishReason: "length" } },
                { assistant: { content: "\n````SEND [200]\ndone\n````", reasoning: null, finishReason: "stop" } },
            ],
        });
        const t1 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "go" }] });
        const t2 = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.ok(t1.turnId < t2.turnId);
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        const notices = packetSection(packet, "notices");
        assert.match(
            notices,
            /^> YOU SHOULD emit fewer or shorter operations per turn\. Emission truncated at the output allowance \(\d+ tokens\)\. \[output_truncated\]$/m,
            "the ceiling cut names its cause and the number",
        );
    } finally { await db.close(); }
});

test("{§outside-text} (#478) a cut too deep to parse names the truncation, never the parser", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const cut = { assistant: { content: "I will now write the module cache implementa", reasoning: null, finishReason: "length" as const } };
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [cut, continuing("split the write"), valid("finished")],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.result.status, 200);
        // {§outside-text} — the cut response is an admitted empty turn, never a private resample;
        // packets[1] is the next request and carries the engine's own reading of the cut.
        assert.equal(provider.packets.length, 3);
        assert.match(
            provider.packets[1],
            /> YOU SHOULD emit fewer or shorter operations per turn\. Emission truncated at the output allowance \(\d+ tokens\); no authored operations were performed\. \[output_truncated\]/,
            "the next packet names the engine's cut and the recovery fact",
        );
        assert.doesNotMatch(provider.packets[1], /Parser: /, "the parser's symptom never blames the model for the ceiling's cut");
    } finally { await db.close(); }
});
});

describe("Engine.bare", () => {
const mainResponse = (operations: string): ConstructorParameters<typeof Mock>[0]["responses"][number] => ({
    assistant: {
        content: `${operations}
`,
        reasoning: null,
    },
});

type GenerateArgs = Parameters<Provider["generate"]>[0];

class BareWitness implements Provider {
    readonly contextWindow = 16_384;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1;
    readonly reasoningBudget = null;
    readonly supportedEfforts = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly outputFloor = null;
    readonly inputWall = null;
    readonly model = "bare-witness";
    readonly inputModalities: ReadonlySet<InputModality> = new Set();
    readonly calls: GenerateArgs[] = [];
    readonly completions: string[] = [];
    maxActive = 0;
    #active = 0;
    #started = 0;
    #release!: () => void;
    readonly #allStarted: Promise<void>;
    readonly #expectedCalls: number;
    readonly #failedPrompt: string | null;
    #failures: number;

    constructor(expectedCalls: number, failedPrompt: string | null = null, failures = Number.POSITIVE_INFINITY) {
        this.#expectedCalls = expectedCalls;
        this.#failedPrompt = failedPrompt;
        this.#failures = failures;
        this.#allStarted = new Promise((resolve) => { this.#release = resolve; });
    }

    async countPromptTokens(messages: readonly ChatMessage[]) {
        return {
            kind: "exact" as const,
            tokens: messages.reduce((total, message) => total + chatMessageText(message).length, 0),
            source: "bare-witness",
        };
    }

    async assessRequestCapacity(messages: Parameters<Provider["assessRequestCapacity"]>[0]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    attributions() {
        return ["provider:bare-witness"];
    }

    async generate(args: GenerateArgs): Promise<ProviderResponse> {
        this.calls.push(args);
        const prompt = chatMessageText(args.messages[0] ?? { content: "" });
        const capacity = await this.assessRequestCapacity(args.messages);
        const settle = await args.observeRequest?.({ provider: "provider:bare-witness", model: this.model });
        this.#active++;
        this.maxActive = Math.max(this.maxActive, this.#active);
        this.#started++;
        if (this.#started === this.#expectedCalls) this.#release();
        await this.#allStarted;
        if (prompt === "slow") await delay(20, undefined, { signal: args.signal });

        const failed = prompt === this.#failedPrompt && this.#failures > 0;
        if (failed) this.#failures -= 1;
        const accounting: ProviderRequestAccounting = validateProviderRequestAccounting({
            provider: "provider:bare-witness",
            model: this.model,
            outcome: failed ? "error" : "response",
            usage: failed ? undefined : { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost: failed
                ? { kind: "unknown", reason: "deliberate BARE provider failure" }
                : { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "BARE fixture" },
        });
        await settle?.(accounting);
        this.#active--;
        this.completions.push(prompt);
        if (failed) {
            throw new ProviderError("bare-witness", "network_failure", `could not answer ${prompt}`, {
                status: 503,
                accounting: [accounting],
                capacity,
            });
        }
        return {
            assistant: {
                content: `answer:${prompt}`,
                reasoning: "private child reasoning",
                finishReason: "stop",
                model: this.model,
            },
            assistantRaw: null,
            accounting: [accounting],
            capacity,
        };
    }
}

class CancellingBareWitness implements Provider {
    readonly contextWindow = 16_384;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1;
    readonly reasoningBudget = null;
    readonly supportedEfforts = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly outputFloor = null;
    readonly inputWall = null;
    readonly model = "cancelling-bare-witness";
    readonly inputModalities: ReadonlySet<InputModality> = new Set();
    readonly aborted: string[] = [];
    readonly started: Promise<void>;
    readonly expectedCalls: number;
    #startedCount = 0;
    #allStarted!: () => void;

    constructor(expectedCalls: number) {
        this.expectedCalls = expectedCalls;
        this.started = new Promise((resolve) => { this.#allStarted = resolve; });
    }

    async countPromptTokens() {
        return { kind: "exact" as const, tokens: 1, source: "cancelling-bare-witness" };
    }

    async assessRequestCapacity(messages: Parameters<Provider["assessRequestCapacity"]>[0]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    async generate(args: GenerateArgs): Promise<ProviderResponse> {
        const prompt = chatMessageText(args.messages[0] ?? { content: "" });
        const capacity = await this.assessRequestCapacity(args.messages);
        const settle = await args.observeRequest?.({ provider: "provider:cancelling-bare-witness", model: this.model });
        this.#startedCount++;
        if (this.#startedCount === this.expectedCalls) this.#allStarted();
        try {
            await new Promise<void>((_resolve, reject) => {
                if (args.signal?.aborted === true) reject(args.signal.reason);
                else args.signal?.addEventListener("abort", () => reject(args.signal?.reason), { once: true });
            });
        } catch (cause) {
            this.aborted.push(prompt);
            const accounting = validateProviderRequestAccounting({
                provider: "provider:cancelling-bare-witness",
                model: this.model,
                outcome: "error",
                status: 499,
                cost: { kind: "unknown", reason: "cancelled fixture request" },
            });
            await settle?.(accounting);
            throw new ProviderError("cancelling-bare-witness", "resource_interrupted", "cancelled", {
                status: 499,
                accounting: [accounting],
                capacity,
                cause,
            });
        }
        throw new Error("unreachable");
    }
}

const withEnv = async <T>(overrides: Record<string, string>, run: () => Promise<T>): Promise<T> => {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try { return await run(); } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const setup = async (schemes = new SchemeRegistry()) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `bare-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "ask isolated questions");
    const engine = new Engine({ db, schemes });
    return { db, workspaceId, sessionId, loopId, engine };
};

test("{§op-methods-op-dispatch}: resource prompts bypass line and size preview caps after preceding edits, with an optional inline tail", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const prompt = [...Array.from({ length: 24 }, (_, i) => `Finding ${i + 1}`), `Long finding: ${"α".repeat(8_000)} end`].join("\n");
        const child = new BareWitness(2);
        const result = await engine.runTurn({
            workspaceId, sessionId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "````EDIT (workspace:///prompt.md)",
                prompt,
                "````",
                "````BARE (workspace:///prompt.md)````",
                "````BARE (workspace:///prompt.md)",
                "Compare these findings.",
                "````",
                "````NOTE\nContinue the task.\n````",
            ].join("\n"))] }),
        });
        assert.equal(result.status, 102);
        assert.deepEqual(child.calls.map(({ messages }) => messages), [
            [{ role: "user", content: prompt }],
            [{ role: "user", content: `${prompt}\n\nCompare these findings.` }],
        ]);
        assert.equal(child.maxActive, 2);
        assert.deepEqual(result.outcomes.map(({ op }) => op), ["EDIT", "BARE", "BARE", "NOTE"], "source reads do not mint extra log receipts");
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch}: missing resources preserve the source error without calling the provider or discarding a successful sibling", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const child = new BareWitness(1);
        const result = await engine.runTurn({
            workspaceId, sessionId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "````BARE (workspace:///missing.md)",
                "Do not infer from this tail alone.",
                "````",
                "````BARE",
                "survivor",
                "````",
                "````NOTE\nContinue the task.\n````",
            ].join("\n"))] }),
        });
        assert.deepEqual(child.completions, ["survivor"]);
        const rows = (await db.test_log_entries_by_turn.all<{ op: string; rx: string; model_call_id: number | null }>({ turn_id: result.turnId })).filter(({ op }) => op === "BARE");
        assert.equal(rows.length, 2);
        const failure = JSON.parse(rows[0].rx);
        assert.equal(failure.status, 404);
        assert.match(failure.problem.type, /\/entry-not-found$/);
        assert.equal(rows[0].model_call_id, null);
        assert.notEqual(rows[1].model_call_id, null);
        const calls = await db.test_model_calls.all<{ kind: string }>({ turn_id: result.turnId });
        assert.equal(calls.filter(({ kind }) => kind === "bare").length, 1);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch}: cancellation during source preparation leaves no unstarted inference calls open", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel prompt acquisition");
    const schemes = new SchemeRegistry();
    schemes.register("interrupted-prompt", {
        manifest: {
            name: "interrupted-prompt", channels: { body: "text/plain" }, defaultChannel: "body",
            category: "data", writableBy: ["model"],
            volatile: false, modelVisible: true,
        },
        async prepareRepresentation() {
            controller.abort(cancellation);
            throw cancellation;
        },
    } satisfies SchemeHandler);
    const { db, workspaceId, sessionId, loopId, engine } = await setup(schemes);
    try {
        const child = new BareWitness(2);
        await assert.rejects(engine.runTurn({
            workspaceId, sessionId, loopId, messages: [], childProvider: child, signal: controller.signal,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "````BARE",
                "first prompt",
                "````",
                "````BARE (interrupted-prompt:///question.md)````",
                "````BARE",
                "last prompt",
                "````",
                "````NOTE\nContinue the task.\n````",
            ].join("\n"))] }),
        }), (error: unknown) => error === cancellation);
        assert.equal(child.calls.length, 0);
        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        assert.ok(turn);
        const calls = await db.test_model_calls.all<{ kind: string; state: string }>({ turn_id: turn.id });
        assert.deepEqual(calls.filter(({ kind }) => kind === "bare"), [], "unstarted inference must not remain active after cancellation");
    } finally {
        await schemes.close();
        await db.close();
    }
});

for (const [denied, target] of [
    [{ operation: "BARE" }, ""],
    [{ operation: "BARE" }, " (workspace:///prompt.md)"],
    [{ scheme: "workspace", access: "observe" }, " (workspace:///prompt.md)"],
] as const) {
    test(`{§capability-admission}: BARE${target} respects ${JSON.stringify(denied)} before inference`, async () => {
        const { db, workspaceId, sessionId, loopId, engine } = await setup();
        try {
            await db.workspace_capability_policy_update.run({ workspace_id: workspaceId, policy: JSON.stringify({ deny: [denied] }) });
            const child = new BareWitness(1);
            const result = await engine.runTurn({
                workspaceId, sessionId, loopId, messages: [], childProvider: child,
                provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                    "````EDIT (workspace:///prompt.md)",
                    "secret prompt",
                    "````",
                    "````BARE" + target,
                    "inline prompt",
                    "````",
                    "````NOTE\nContinue the task.\n````",
                ].join("\n"))] }),
            });
            assert.equal(child.calls.length, 0);
            assert.deepEqual(result.outcomes.filter(({ op }) => op === "BARE"), [{ op: "BARE", status: 403, problemType: "https://problems.plurnk.xyz/engine/dispatcher/capability-denied" }]);
            const calls = await db.test_model_calls.all<{ kind: string }>({ turn_id: result.turnId });
            assert.equal(calls.filter(({ kind }) => kind === "bare").length, 0);
        } finally { await db.close(); }
    });
}

test("{§op-methods-op-dispatch}: a log prompt uses only retained source lines", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const first = await engine.runTurn({
            workspaceId, sessionId, loopId, messages: [],
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "````EDIT (workspace:///source.md)",
                "first",
                "superseded",
                "last",
                "````",
                "````READ (workspace:///source.md) <1,-1>````",
                "````NOTE\nContinue the task.\n````",
            ].join("\n"))] }),
        });
        const rows = await db.test_log_entries_by_turn.all<{ op: string; sequence: number; attrs: string }>({ turn_id: first.turnId });
        const source = rows.find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
        assert.ok(source);
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId });
        assert.ok(turn);
        const address = `log:///1/${turn.sequence}/${source.sequence}/READ`;
        const child = new BareWitness(1);
        const second = await engine.runTurn({
            workspaceId, sessionId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "````KILL (" + (address) + ") <2>````",
                "````BARE (" + (address) + ")````",
                "````NOTE\nContinue the task.\n````",
            ].join("\n"))] }),
        });
        assert.deepEqual(second.outcomes.filter(({ op }) => op === "BARE"), [{ op: "BARE", status: 200, problemType: null }]);
        assert.deepEqual(child.calls.map(({ messages }) => messages), [[{ role: "user", content: "first\nlast" }]]);
    } finally { await db.close(); }
});

for (const [target, status, problem] of [
    ["workspace:///prompt.md#missing", 404, "channel-not-found"],
    ["unregistered://prompt", 501, "scheme-not-found"],
    [null, 422, "bare-prompt-empty"],
] as const) {
    test(`{§op-methods-op-dispatch}: ${target ?? "empty input"} produces ${problem} without inference`, async () => {
        const { db, workspaceId, sessionId, loopId, engine } = await setup();
        try {
            const child = new BareWitness(1);
            const result = await engine.runTurn({
                workspaceId, sessionId, loopId, messages: [], childProvider: child,
                provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                    "````EDIT (workspace:///prompt.md)",
                    "source prompt",
                    "````",
                    "````BARE" + (target === null ? "" : ` (${target})`),
                    "````",
                    "````NOTE\nContinue the task.\n````",
                ].join("\n"))] }),
            });
            const bare = result.outcomes.find(({ op }) => op === "BARE");
            assert.equal(bare?.status, status);
            assert.ok(bare?.problemType?.endsWith(`/${problem}`));
            assert.equal(child.calls.length, 0);
            if (target === null) {
                // {§diagnostic-observation} — the refusal states where a prompt is read from, and nothing else.
                const row = (await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: result.turnId })).find(({ op }) => op === "BARE");
                assert.equal(JSON.parse(row!.rx).problem.detail, "BARE has no prompt text: the prompt is the fence body, a resource path, or both.");
            }
        } finally { await db.close(); }
    });
}

test("{§op-methods-op-dispatch}: an intervening operation separates concurrent BARE groups", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const child = new BareWitness(1);
        const generate = child.generate.bind(child);
        const observed: Array<string | undefined> = [];
        child.generate = async (args) => {
            const row = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/between", name: "body" });
            observed.push(row?.content);
            return generate(args);
        };
        const result = await engine.runTurn({
            workspaceId, sessionId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse("````BARE\nbefore\n````\n````EDIT (workspace:///between)\nwritten\n````\n````BARE\nafter\n````\n````NOTE\nContinue the task.\n````")] }),
        });
        assert.equal(result.status, 102);
        assert.deepEqual(observed, [undefined, "written"]);
        assert.deepEqual(child.completions, ["before", "after"]);
        assert.deepEqual(result.outcomes.map(({ op }) => op), ["BARE", "EDIT", "BARE", "NOTE"]);
    } finally { await db.close(); }
});

// {§op-methods-op-dispatch}
test("{§provider-cache-identity} BARE calls receive only their body prompts, run in parallel, and commit in authored order", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("````BARE\nslow\n````\n\n````BARE\nfast\n````\n\n````NOTE\nObserve both responses next turn.\n````")],
        });
        const child = new BareWitness(2);

        const result = await engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
        });

        assert.equal(result.status, 102);
        assert.equal(child.maxActive, 2, "the child calls overlap");
        assert.deepEqual(child.completions, ["fast", "slow"], "the fixture proves completion order differs");
        assert.deepEqual(child.calls.map(({ messages }) => messages), [
            [{ role: "user", content: "slow" }],
            [{ role: "user", content: "fast" }],
        ]);
        assert.ok(child.calls.every(({ grammar }) => grammar === undefined), "BARE has no output rail");
        assert.ok(child.calls.every(({ observeReasoning }) => observeReasoning === undefined), "BARE reasoning remains private to its operation result");
        assert.ok(child.calls.every(({ callKind }) => callKind === "bare"), "BARE declares its provider output contract");
        const parentIdentity = await db.test_sessions_get_provider_identity.get<{ provider_identity: string }>({ id: sessionId });
        const bareIdentities = child.calls.map(({ sessionId: callSession }) => callSession);
        assert.ok(bareIdentities.every((identity) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity)), "each BARE call receives an opaque UUID identity");
        assert.equal(new Set(bareIdentities).size, 2, "parallel BARE calls cannot acquire affinity with one another");
        assert.ok(bareIdentities.every((identity) => identity !== parentIdentity?.provider_identity), "BARE does not reuse the parent session's affinity identity");
        const bareCalls = await db.test_model_calls.all<{ kind: string; attributions: string }>({ turn_id: result.turnId });
        assert.ok(bareCalls.filter(({ kind }) => kind === "bare").every(({ attributions }) =>
            JSON.stringify(JSON.parse(attributions)) === JSON.stringify(["provider:bare-witness"])),
        "each BARE model call records the composed attribution set");

        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            op: string | null;
            signal: string | null;
            rx: string;
            model_call_id: number | null;
        }>({ turn_id: result.turnId });
        const bareRows = rows.filter(({ op }) => op === "BARE");
        assert.deepEqual(bareRows.map(({ sequence, rx }) => ({
            sequence,
            content: (JSON.parse(rx) as { content: string }).content,
        })), [
            { sequence: bareRows[0]?.sequence, content: "answer:slow" },
            { sequence: bareRows[1]?.sequence, content: "answer:fast" },
        ]);
        assert.ok(bareRows.every(({ model_call_id }) => model_call_id !== null));

        const calls = await db.test_model_calls.all<{
            sequence: number;
            kind: string;
            state: string;
            attributions: string;
            log_entry_id: number | null;
        }>({ turn_id: result.turnId });
        assert.deepEqual(calls.map(({ sequence, kind, state }) => ({ sequence, kind, state })), [
            { sequence: 1, kind: "emission", state: "response" },
            { sequence: 2, kind: "bare", state: "response" },
            { sequence: 3, kind: "bare", state: "response" },
        ]);
        assert.ok(calls.slice(1).every(({ log_entry_id }) => log_entry_id !== null));
        assert.ok(calls.slice(1).every(({ attributions }) =>
            JSON.stringify(JSON.parse(attributions)) === JSON.stringify(["provider:bare-witness"])));

        const usage = await engine.loopUsage(loopId);
        assert.equal(usage.accounting.requests.length, 3, "parent and both BARE calls remain cardinal accounting");
        assert.equal(usage.contextTokens, 0, "the context gauge remains the parent emission packet, not a tiny BARE prompt");
    } finally {
        await db.close();
    }
});

// {§op-methods-op-dispatch} {§provider-surface}
test("{§op-methods-op-dispatch} loop cancellation reaches every concurrent BARE call before the batch escapes", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("````BARE\nfirst\n````\n\n````BARE\nsecond\n````\n\n````NOTE\ncontinue\n````")],
        });
        const child = new CancellingBareWitness(2);
        const controller = new AbortController();
        const running = engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
            signal: controller.signal,
        });
        await child.started;
        const cancellation = new Error("cancel BARE batch");
        controller.abort(cancellation);
        await assert.rejects(running, (error: unknown) => error === cancellation);
        assert.deepEqual(child.aborted.toSorted(), ["first", "second"]);
        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        const calls = await db.test_model_calls.all<{ kind: string; state: string }>({ turn_id: turn!.id });
        assert.deepEqual(calls.filter(({ kind }) => kind === "bare").map(({ state }) => state), ["error", "error"]);
    } finally {
        await db.close();
    }
});

// {§op-methods-op-dispatch}
test("{§op-methods-op-dispatch} one BARE provider failure is an ordered operation result and does not cancel its siblings", async () => await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "0" }, async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("````BARE\nfail\n````\n\n````BARE\nok\n````\n\n````NOTE\nInspect the isolated failure and success.\n````")],
        });
        const child = new BareWitness(2, "fail");

        const result = await engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
        });

        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.filter(({ op }) => op === "BARE"), [
            { op: "BARE", status: 503, problemType: "https://problems.plurnk.xyz/provider/bare-witness/network-failure" },
            { op: "BARE", status: 200, problemType: null },
        ]);
        const calls = await db.test_model_calls.all<{ kind: string; state: string }>({ turn_id: result.turnId });
        assert.deepEqual(calls.filter(({ kind }) => kind === "bare").map(({ state }) => state), ["error", "response"]);
    } finally {
        await db.close();
    }
}));

test("{§engine-rails}: an isolated call that drops once is re-issued; the receipt is the answer and the dropped call is on the ledger", async () => await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "20000", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "10" }, async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("````BARE\nflaky\n````\n\n````BARE\nok\n````\n\n````NOTE\nInspect both answers.\n````")],
        });
        const child = new BareWitness(2, "flaky", 1);
        const result = await engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
        });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.filter(({ op }) => op === "BARE"), [
            { op: "BARE", status: 200, problemType: null },
            { op: "BARE", status: 200, problemType: null },
        ], "the dropped call was re-issued inside the operation; nothing about the failure reaches the result");
        assert.deepEqual(child.completions.toSorted(), ["flaky", "flaky", "ok"], "the flaky prompt was asked twice, its sibling once");
        const calls = await db.test_model_calls.all<{ kind: string; state: string }>({ turn_id: result.turnId });
        assert.deepEqual(calls.filter(({ kind }) => kind === "bare").map(({ state }) => state).toSorted(), ["error", "response", "response"], "the dropped call is its own model call on the ledger");
        const answers = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(answers.filter(({ op }) => op === "BARE").map(({ status_rx }) => status_rx), [200, 200]);
    } finally {
        await db.close();
    }
}));

// {§op-methods-op-dispatch} {§loop-completion}
test("{§op-methods-op-dispatch} a same-turn BARE response is unseen retrieval work and defers completion", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("````BARE\nquestion\n````\n\n````SEND\ndone\n````")],
        });
        const child = new BareWitness(1);
        const result = await engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
        });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes, [
            { op: "BARE", status: 200, problemType: null },
            { op: "SEND", status: 200, problemType: null },
        ], "delivery succeeds while the unseen BARE result keeps the loop continuing");
    } finally {
        await db.close();
    }
});

for (const state of ["WAIT", "SEND"] as const) {
    test(`{§op-methods-op-dispatch} {§op-shapes}: BARE after ${state} preserves the operation's scheduling contract`, async () => {
        const { db, workspaceId, sessionId, loopId, engine } = await setup();
        try {
            const child = new BareWitness(1);
            const result = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 32_768,
                    responses: [mainResponse(`\`\`\`\`${state}
\`\`\`\`
\`\`\`\`BARE
question
\`\`\`\``)],
                }),
                childProvider: child,
                workspaceId,
                sessionId,
                loopId,
                messages: [],
            });
            assert.equal(result.status, 102);
            assert.deepEqual(child.completions, ["question"], "the isolated call was made");
            assert.deepEqual(result.outcomes.map(({ op }) => op), state === "WAIT" ? ["BARE", "WAIT"] : ["SEND", "BARE"],
                "only WAIT is deferred; SEND retains its authored order");
            assert.deepEqual(result.outcomes.filter(({ op }) => op === state), [{ op: state, status: state === "WAIT" ? 102 : 200, problemType: null }]);
        } finally {
            await db.close();
        }
    });
}
});

describe("Mock.provider", () => {
const editStmt = (target: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: { kind: "url", raw: `workspace:///${target}`, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: `/${target}`, query: null, fragment: null },
    lineMarker: null, body, matcher: null, position: { line: 1, column: 1 },
});

const response = (content: string, ops: MockResponse["assistant"]["ops"]): MockResponse => ({
    assistant: { content, ops, reasoning: null },
});

test("{§provider-interface} Mock.provider: contextWindow exposed", () => {
    const mock = new Mock({ contextWindow: 200000, responses: [] });
    assert.equal(mock.contextWindow, 200000);
});

test("{§provider-prompt-measurement} Mock.provider: prompt measurement carries exact provenance", async () => {
    const mock = new Mock({ contextWindow: 200000, responses: [] });
    assert.deepEqual(
        await mock.countPromptTokens([{ role: "user", content: "alpha beta gamma" }]),
        { kind: "exact", tokens: 8, source: "mock:chars2" },
    );
});

test("{§provider-instantiation} Mock.provider: returns queued responses in order", async () => {
    const r1 = response("first", [editStmt("a", "1")]);
    const r2 = response("second", [editStmt("b", "2")]);
    const mock = new Mock({ contextWindow: 10_000, responses: [r1, r2] });
    const a = await mock.generate({ messages: [{ role: "user", content: "anything" }] });
    const b = await mock.generate({ messages: [{ role: "user", content: "anything" }] });
    assert.equal(a.assistant.content, "first");
    assert.equal(b.assistant.content, "second");
});

test("{§provider-instantiation} Mock.provider: exhausted queue throws", async () => {
    const mock = new Mock({ contextWindow: 10_000, responses: [response("only", [])] });
    await mock.generate({ messages: [{ role: "user", content: "x" }] });
    await assert.rejects(() => mock.generate({ messages: [{ role: "user", content: "y" }] }), /Mock provider exhausted/);
});

test("{§provider-generation-completion} Mock.provider: assistant and request accounting remain separate", async () => {
    const r: MockResponse = {
        assistant: {
            content: "````SEND [200]\ndone\n````",
            ops: [completeStmt("done")],
            reasoning: "thought about it",
            finishReason: "stop",
            model: "mock-bench-v1",
        },
        usage: { inputTokens: 100, outputTokens: 42, totalTokens: 142 },
    };
    const mock = new Mock({ contextWindow: 10_000, responses: [r] });
    const result = await mock.generate({ messages: [{ role: "user", content: "x" }] });
    assert.equal(result.assistant.content, "````SEND [200]\ndone\n````");
    assert.equal(result.accounting[0]?.usage?.outputTokens, 42);
    assert.equal(result.accounting[0]?.usage?.inputTokens, 100);
    assert.equal(result.accounting[0]?.usage?.totalTokens, 142);
    assert.equal(result.assistant.finishReason, "stop");
    assert.equal(result.assistant.model, "mock-bench-v1");
    assert.equal(result.assistant.reasoning, "thought about it");
    assert.equal(result.assistant.ops?.length, 1);
    assert.equal((result.assistant.ops as PlurnkStatement[] | undefined)?.[0]?.op, "SEND");
});

test("{§provider-instantiation} Mock.provider: request accounting defaults fill when the fixture omits usage", async () => {
    const r: MockResponse = { assistant: { content: "", ops: [], reasoning: null } };
    const mock = new Mock({ contextWindow: 10_000, responses: [r] });
    const result = await mock.generate({ messages: [] });
    assert.deepEqual(result.accounting[0]?.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.equal(result.assistant.finishReason, "stop");
    assert.equal(result.assistant.model, "mock");
});

test("{§provider-instantiation} Mock.provider: prompt is ignored — same input doesn't influence output", async () => {
    const mock = new Mock({
        contextWindow: 10_000,
        responses: [response("alpha", []), response("alpha", [])],
    });
    const a = await mock.generate({ messages: [{ role: "user", content: "completely different" }] });
    const b = await mock.generate({ messages: [{ role: "user", content: "completely different" }] });
    assert.equal(a.assistant.content, "alpha");
    assert.equal(b.assistant.content, "alpha");
});

test("{§provider-evidence} Mock.provider: assistantRaw defaults to null; explicit value is passed through", async () => {
    const r1: MockResponse = { assistant: { content: "x", ops: [], reasoning: null } };
    const r2: MockResponse = { assistant: { content: "y", ops: [], reasoning: null }, assistantRaw: { vendor: "anthropic", id: "msg_123" } };
    const mock = new Mock({ contextWindow: 10_000, responses: [r1, r2] });
    const a = await mock.generate({ messages: [] });
    const b = await mock.generate({ messages: [] });
    assert.equal(a.assistantRaw, null);
    assert.deepEqual(b.assistantRaw, { vendor: "anthropic", id: "msg_123" });
});

test("{§provider-instantiation} Mock.provider: preserves an explicitly empty test-fixture ops array", async () => {
    const mock = new Mock({ contextWindow: 10_000, responses: [response("", [])] });
    const result = await mock.generate({ messages: [] });
    assert.deepEqual(result.assistant.ops, []);
});

test("{§provider-instantiation} Mock.provider: multi-op response (the typical loop turn)", async () => {
    const ops = [
        editStmt("a", "1"),
        editStmt("b", "2"),
        noteStmt("continuing"),
    ];
    const content = "````EDIT (workspace:///a)\n1\n````\n\n````EDIT (workspace:///b)\n2\n````\n\n````NOTE\ncontinuing\n````";
    const mock = new Mock({ contextWindow: 10_000, responses: [response(content, ops)] });
    const result = await mock.generate({ messages: [] });
    assert.equal(result.assistant.ops?.length, 3);
    assert.deepEqual((result.assistant.ops as PlurnkStatement[] | undefined)?.map((o) => o.op), ["EDIT", "EDIT", "NOTE"]);
});
});

describe("ProviderRegistry", () => {
test("{§provider-instantiation} parseAliasesFromEnv: extracts PLURNK_MODEL_<alias>=<provider>/<model> entries", () => {
    const aliases = parseAliasesFromEnv({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus-latest",
        PLURNK_MODEL: "gemma",
        PLURNK_SERVICE_DB_PATH: "./x.db",
    });
    assert.deepEqual(aliases.toSorted((a, b) => a.alias.localeCompare(b.alias)), [
        { alias: "gemma", provider: "openai", model: "macher.gguf" },
        { alias: "opus", provider: "openrouter", model: "anthropic/claude-opus-latest" },
    ]);
});

test("{§alias-parse} parseAliasesFromEnv: downcases the alias suffix; preserves provider+model case", () => {
    const aliases = parseAliasesFromEnv({
        PLURNK_MODEL_GEMMA: "openai/Macher.GGUF",
    });
    assert.equal(aliases.length, 1);
    assert.equal(aliases[0].alias, "gemma");
    assert.equal(aliases[0].model, "Macher.GGUF");
});

test("{§alias-parse} parseAliasesFromEnv: empty value, no slash, or no suffix are skipped", () => {
    const aliases = parseAliasesFromEnv({
        PLURNK_MODEL_empty: "",
        PLURNK_MODEL_noslash: "openai-no-slash",
        PLURNK_MODEL_leadingslash: "/leading",
        PLURNK_MODEL: "valid-alias-not-listed",
        PLURNK_MODEL_valid: "openai/model",
    });
    assert.deepEqual(aliases.map((a) => a.alias), ["valid"]);
});

test("{§alias-resolve-active} resolveActiveRoute: returns null when PLURNK_MODEL unset", () => {
    const alias = resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
    });
    assert.equal(alias, null);
});

test("{§provider-resolution} resolveActiveRoute: returns the matching alias when PLURNK_MODEL set", () => {
    const alias = resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus-latest",
        PLURNK_MODEL: "opus",
    });
    assert.deepEqual(alias, { alias: "opus", provider: "openrouter", model: "anthropic/claude-opus-latest" });
});

test("{§alias-resolve-active} resolveActiveRoute: case-insensitive PLURNK_MODEL lookup", () => {
    const alias = resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL: "GEMMA",
    });
    assert.equal(alias?.alias, "gemma");
});

test("{§alias-resolve-active} resolveActiveRoute: rejects an explicit unknown alias", () => {
    assert.throws(() => resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL: "ghost",
    }), /neither a declared alias nor a provider\/model route/);
});

test("{§provider-resolution} resolveActiveRoute: exact routes require no alias declaration", () => {
    assert.deepEqual(resolveActiveRoute({ PLURNK_MODEL: "google/gemini-3-flash" }), {
        provider: "google",
        model: "gemini-3-flash",
    });
});
});

describe("attribution", () => {
// {§emission-admission}











const response = (content: string): MockResponse => ({
    assistant: {
        content,
        reasoning: null,
    },
    assistantRaw: null,
});

const invalid = response("````READ (workspace:///unframed-prose");
const valid = response("\n````SEND\ndone\n````");
const canonical = (...tags: string[]): string[] => [...new Set(tags)].toSorted();

test("{§emission-admission} each emission attempt composes opaque family hooks and records exactly what it composed", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `attr-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const sessionIdentity = await db.test_sessions_get_provider_identity.get<{ provider_identity: string }>({ id: sessionId });
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const contexts: ExtensionAttributionContext[] = [];

        const schemes = new SchemeRegistry();
        schemes.attributions = ({ attempt }) => ["shared", `scheme:${attempt}`];
        const executors = new ExecutorRegistry(new Map());
        executors.attributions = ({ attempt }) => ["shared", `executor:${attempt}`];
        const mimetypes = new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map(), packageAttributions: new Map(), skipped: [] },
        });
        mimetypes.attributions = async ({ attempt }) => ["shared", `mimetype:${attempt}`];

        const provider = new Mock({ contextWindow: 100_000, responses: [invalid, valid] });
        const providerWithAttribution = provider as Mock & {
            attributions?: (context: ExtensionAttributionContext) => readonly string[];
        };
        providerWithAttribution.attributions = (context) => {
            contexts.push(context);
            return ["shared", `provider:${context.attempt}`];
        };
        const engine = new Engine({ db, schemes, mimetypes });
        engine.setExecutors(executors);
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const first = canonical("shared", "scheme:1", "executor:1", "mimetype:1", "provider:1");
        const second = canonical("shared", "scheme:2", "executor:2", "mimetype:2", "provider:2");
        assert.deepEqual(contexts, [
            {
                workspaceId: String(workspaceId),
                sessionId: sessionIdentity?.provider_identity,
                loop: 1,
                turn: 2,
                attempt: 1,
            },
            {
                workspaceId: String(workspaceId),
                sessionId: sessionIdentity?.provider_identity,
                loop: 1,
                turn: 2,
                attempt: 2,
            },
        ], "extensions receive only the exact provider-attempt coordinates");

        const attempts = await db.test_turn_attempts.all<{ sequence: number; attributions: string }>({
            turn_id: result.turnId,
        });
        assert.deepEqual(
            attempts.map(({ sequence, attributions }) => ({ sequence, attributions: JSON.parse(attributions) })),
            [
                { sequence: 1, attributions: first },
                { sequence: 2, attributions: second },
            ],
            "attempt evidence retains each exact composed set",
        );

        const row = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row!.packet) as { attributions: string[] };
        assert.deepEqual(packet.attributions, second, "the turn request retains the latest attempted set");
        assert.deepEqual(
            await engine.loopAttributions(loopId),
            canonical(...first, ...second),
            "loop reporting derives its union from exact request evidence",
        );
    } finally {
        await db.close();
    }
});

test("{§emission-admission} an empty folksonomy omits the provider field but persists the exact empty request set", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `attr-empty-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100_000, responses: [valid] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const row = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        assert.deepEqual((JSON.parse(row!.packet) as { attributions: string[] }).attributions, []);
        assert.deepEqual(await engine.loopAttributions(loopId), []);
    } finally {
        await db.close();
    }
});
});

describe("child-provider-policy", () => {
const declaredProviderEnv = new Map<string, string | undefined>();
test.afterEach(() => {
    for (const [key, value] of declaredProviderEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    declaredProviderEnv.clear();
});

const declaredProvider = (name: string, model: string): ProviderAlias => {
    const spec = {
        alias: `${name}-${crypto.randomUUID()}`,
        provider: "openai",
        model,
    };
    const key = `PLURNK_MODEL_${spec.alias}`;
    declaredProviderEnv.set(key, process.env[key]);
    process.env[key] = `${spec.provider}/${spec.model}`;
    return spec;
};

type LoopRow = {
    id: number;
    session_id: number;
    model_route_id: number | null;
    spawn_model_route_id: number | null;
    status: number;
};

const routeSpec = async (db: Db, routeId: number | null): Promise<ProviderSpec | null> => {
    if (routeId === null) return null;
    const row = await db.model_route_by_id.get<{ alias: string | null; provider: string; model: string; base_url: string | null }>({ id: routeId });
    if (row === undefined) throw new Error(`model_route ${routeId} is missing`);
    return {
        provider: row.provider,
        model: row.model,
        ...(row.alias === null ? {} : { alias: row.alias }),
        ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
    };
};

const withConfiguredChild = async <T>(spec: ProviderAlias, run: () => Promise<T>): Promise<T> => {
    const declaration = `PLURNK_MODEL_${spec.alias}`;
    const priorDeclaration = process.env[declaration];
    const priorSelection = process.env.PLURNK_MODEL_CHILD;
    process.env[declaration] = `${spec.provider}/${spec.model}`;
    process.env.PLURNK_MODEL_CHILD = spec.alias;
    try {
        return await run();
    } finally {
        if (priorDeclaration === undefined) delete process.env[declaration];
        else process.env[declaration] = priorDeclaration;
        if (priorSelection === undefined) delete process.env.PLURNK_MODEL_CHILD;
        else process.env.PLURNK_MODEL_CHILD = priorSelection;
    }
};

test("{§session-model-selection}: a smaller WORK provider carries through every descendant", async () => {
    const parentSpec = declaredProvider("parent", "large-parent");
    const childSpec = declaredProvider("child", "smaller-child");
    const parent = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse("````WORK (session://child)\ndelegate once\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\ntree complete\n````"),
        ],
    });
    const child = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("````WORK (session://grandchild)\ndelegate again\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\nleaf complete\n````"),
            makeMockResponse("````SEND [200]\nchild complete\n````"),
        ],
    });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `child-policy-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "build a two-level session tree",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
            });
            assert.equal(result.finalStatus, 200);
            const sessionId = result.modelSessionId;
            assert.ok(sessionId !== undefined);
            const sessions = await db.test_sessions_with_parent.all<{ id: number; parent_session_id: number | null; origin: string }>({});
            const root = sessions.find(({ id }) => id === sessionId);
            const first = sessions.find(({ parent_session_id: parentId }) => parentId === root?.id);
            const second = sessions.find(({ parent_session_id: parentId }) => parentId === first?.id);
            assert.ok(root && first && second, "WORK created the complete root → child → grandchild topology");

            const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ model_route_id }) => model_route_id !== null);
            const rootLoop = loops.find(({ session_id: owner }) => owner === root.id);
            const childLoops = loops.filter(({ session_id: owner }) => owner === first.id || owner === second.id);
            assert.deepEqual(await routeSpec(db, rootLoop?.model_route_id ?? null), parentSpec, "only the client-started root uses the parent provider");
            assert.deepEqual(await routeSpec(db, rootLoop?.spawn_model_route_id ?? null), childSpec, "the root persists its resolved spawn policy");
            assert.equal(childLoops.length, 2);
            for (const loop of childLoops) {
                assert.deepEqual(await routeSpec(db, loop.model_route_id), childSpec, "every descendant runs on the selected child provider");
                assert.equal(
                    loop.spawn_model_route_id,
                    null,
                    "a descendant carries the effective model by value and inherits it deeper without a redundant override",
                );
            }
        } finally {
            ws.close();
        }
    });
});

test("{§session-model-selection}: the configured child alias supplies an omitted run policy", async () => {
    const parentSpec = declaredProvider("configured-parent", "configured-parent-model");
    const childSpec = declaredProvider("configured-child", "configured-child-model");
    const parent = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("````WORK (session://child)\nuse configured child\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\nparent complete\n````"),
        ],
    });
    const child = new Mock({
        contextWindow: 8192,
        responses: [makeMockResponse("````SEND [200]\nchild complete\n````")],
    });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withConfiguredChild(childSpec, async () => {
        await withDaemon(null, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `configured-child-${crypto.randomUUID()}` });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "use the configured child provider",
                    selector: parentSpec.alias,
                });
                assert.equal(result.finalStatus, 200);
                const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ model_route_id }) => model_route_id !== null);
                const root = loops.find(({ id }) => id === result.loopId);
                const descendant = loops.find(({ id }) => id !== result.loopId);
                assert.deepEqual(await routeSpec(db, root?.spawn_model_route_id ?? null), childSpec);
                assert.deepEqual(await routeSpec(db, descendant?.model_route_id ?? null), childSpec);
            } finally {
                ws.close();
            }
        });
    });
});

test("{§op-methods-op-dispatch}: BARE consumes the loop's durable child provider without spawning a session", async () => {
    const parentSpec = declaredProvider("bare-parent", "bare-parent-model");
    const childSpec = declaredProvider("bare-child", "bare-child-model");
    const parent = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("\n````BARE\nWhat is the capital of Germany?\n````\n\n````NOTE\nReview the answer.\n````"),
            makeMockResponse("````SEND [200]\nThe isolated answer was reviewed.\n````"),
        ],
    });
    const child = new Mock({
        contextWindow: 8_192,
        responses: [{ assistant: { content: "Berlin", reasoning: null } }],
    });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `bare-child-policy-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "answer one isolated factual question",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
            });
            assert.equal(result.finalStatus, 200);
            assert.equal(parent.remaining, 0);
            assert.equal(child.remaining, 0, "the selected child provider handled BARE");
            const rows = await db.test_log_entries_by_loop.all<{ op: string | null; rx: string }>({ loop_id: result.loopId });
            const bare = rows.find(({ op }) => op === "BARE");
            assert.equal((JSON.parse(bare?.rx ?? "null") as { content?: string } | null)?.content, "Berlin");
            const sessions = await db.test_sessions_with_parent.all<{ parent_session_id: number | null }>({});
            assert.equal(sessions.filter(({ parent_session_id }) => parent_session_id !== null).length, 0, "BARE creates no child session");
        } finally {
            ws.close();
        }
    });
});

test("{§session-model-selection}: explicit inherit overrides configuration and follows the spawning loop", async () => {
    const spec = declaredProvider("inherit", "same-through-tree");
    const configuredSpec = declaredProvider("ignored", "configured-child-must-not-run");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("````WORK (session://child)\ndo it\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\nchild complete\n````"),
            makeMockResponse("````SEND [200]\nparent complete\n````"),
        ],
    });
    ProviderInstantiate.registerInstance(mock, spec);

    await withConfiguredChild(configuredSpec, async () => {
        await withDaemon(null, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `inherit-policy-${crypto.randomUUID()}` });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "spawn one inherited child",
                    selector: spec.alias,
                    childSelector: null,
                });
                assert.equal(result.finalStatus, 200);
                const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ model_route_id }) => model_route_id !== null);
                assert.equal(loops.length, 2);
                for (const loop of loops) {
                    assert.deepEqual(await routeSpec(db, loop.model_route_id), spec);
                    assert.equal(await routeSpec(db, loop.spawn_model_route_id), null, "inherit remains absence rather than becoming a sticky explicit alias");
                }
            } finally {
                ws.close();
            }
        });
    });
});

test("{§session-model-selection}: an oversized FORK fails as an ordinary child loop", async () => {
    const parentSpec = declaredProvider("fork-parent", "large-parent");
    const childSpec = declaredProvider("fork-child", "tiny-child");
    const parent = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse("````FORK (session://branch)\ncontinue with inherited history\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\nobserved child failure\n````"),
        ],
    });
    // {§tokenomics} — a window whose wall cannot hold the inherited packet.
    const child = new Mock({ contextWindow: 1537, responses: [] });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `fork-capacity-${crypto.randomUUID()}` });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "fork work to a much smaller child",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
            });
            assert.equal(result.finalStatus, 200, "the parent observes the failed child and can conclude normally");
            const loops = await db.test_all_loops.all<LoopRow>({});
            let selectedChildLoop: LoopRow | undefined;
            for (const loop of loops) {
                const loopSpec = await routeSpec(db, loop.model_route_id);
                if (loopSpec?.alias === childSpec.alias) {
                    selectedChildLoop = loop;
                    break;
                }
            }
            assert.ok(selectedChildLoop, "FORK created a real child loop on the selected provider before admission");
            assert.equal(selectedChildLoop.status, 413, "the wall, not preflight spawn logic, rejects the inherited packet ({§tokenomics})");
            const [event] = await waitFor(
                () => (terminated() as Array<{ loopId: number; result: { status: number } }>).filter(({ loopId }) => loopId === selectedChildLoop.id),
                (events) => events.length > 0,
            );
            assert.equal(event.result.status, 413, "the ordinary child terminal result carries the admission failure");
        } finally {
            ws.close();
        }
    });
});

// The specimen exercises results after server admission, not interactive approval.
process.env.PLURNK_SERVICE_PROPOSALS = "accept";
});

describe("client-telemetry", () => {
// {§emission-admission} — the workspace's self-identified client id (the originating frontend, e.g.
// "@plurnk/plurnk-tui/1.4.0") is stored with the workspace and validated on write. It reaches no
// provider (#697). The attribution sibling lives in attribution.test.ts.






// Run a loop against a provider whose generate() is shadowed, with the workspace created carrying
// settings.client, and report whether any `client` field reached the provider call.
const captureClient = async (clientId: string | null): Promise<string | undefined> => {
    const mock = new Mock({ contextWindow: 100000, responses: [makeMockResponse("````SEND [200]\ndone\n````", 5)] });
    let captured: string | undefined;
    let seen = false;
    const real = mock.generate.bind(mock);
    mock.generate = (req) => { captured = (req as { client?: string }).client; seen = true; return real(req); };

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const settings = clientId !== null ? { client: clientId } : {};
            await rpcCall(ws, 1, "workspace.create", { name: `client-${clientId ?? "none"}`, settings });
            await runLoopToTerminal(ws, 2, { prompt: "go" });
        } finally { ws.close(); }
    });
    assert.ok(seen, "generate() was called");
    return captured;
};

test("{§emission-admission} a stored client id never reaches the provider call", async () => {
    assert.equal(await captureClient("@plurnk/plurnk-tui/1.4.0"), undefined, "the client id stays inside the daemon");
});

test("{§operation-results} workspace.create refuses an empty client id", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "workspace.create", { name: "bad-client", settings: { client: "" } });
            const problem = rpcProblem(r);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(problem.field, "settings.client");
            assert.equal(problem.recovery, "Provide the client identifier."); // {§operation-results}
        } finally { ws.close(); }
    });
});
});

describe("coordinate-metadata", () => {
// {§provider-surface}: core supplies the workspace this call serves as ordinary call
// context. Nothing about it reaches a backend (#697).








class CoordMock extends Mock {
    seen: { workspaceId?: string; sessionId?: string; callKind?: string } = {};
    override async generate(args: Parameters<Mock["generate"]>[0] & { workspaceId?: string; sessionId?: string; callKind?: string }): ReturnType<Mock["generate"]> {
        this.seen = { workspaceId: args.workspaceId, sessionId: args.sessionId, callKind: args.callKind };
        return super.generate(args);
    }
}

test("{§provider-surface} generate carries the workspace this call serves, and its durable session identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `coord-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        // Loop SEQUENCE 5 while its db id is the first loop row (1): the two diverge so `loop` proves
        // it carried the coordinate, not the id.
        const loopId = await insertLoop(db, sessionId, 5, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const mock = new CoordMock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
        await engine.runTurn({ provider: mock, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "x" }, { role: "user", content: "go" }] });
        assert.equal(mock.seen.workspaceId, String(workspaceId), "the workspace id, stringified");
        assert.equal(mock.seen.callKind, "emission", "ordinary turns declare the emission output contract");
    } finally { await db.close(); }
});
});

describe("grammar-configuration-admission", () => {
// {§provider-instantiation} — a configured operator grammar admits only a provider that can carry it (#588).





const fakeProvider = (
    calls: string[],
    constrainsOutput: boolean = true,
): Provider => ({
    model: "fake",
    contextWindow: 1000,
    inputWall: null,
    outputFloor: null,
    inputModalities: new Set<InputModality>(),
    constrainsOutput,
    generate: async () => {
        calls.push("generate");
        throw new Error("startup generated tokens");
    },
    countPromptTokens: async () => ({ kind: "exact", tokens: 1, source: "test:exact" }),
}) as unknown as Provider;

test("{§provider-instantiation} configured GBNF startup performs no model generation", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(calls);
    const alias = {
        alias: "startupguard",
        provider: "fake",
        model: "fake",
    };
    const env = {
        PLURNK_MODEL: alias.alias,
        PLURNK_MODEL_startupguard: `${alias.provider}/${alias.model}`,
        PLURNK_PROVIDERS_GBNF_startupguard: "/operator/rails/startup.gbnf",
    };
    const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    ProviderInstantiate.registerInstance(provider, alias);
    try {
        assert.equal(await ProviderInstantiate.loadActiveProvider(), provider);
        assert.deepEqual(calls, [], "daemon startup has no authority to generate tokens");
    } finally {
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("{§provider-instantiation} no grammar requested makes admission a no-op", () => {
    const calls: string[] = [];
    ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls, false), {});
    ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls, false), {
        PLURNK_PROVIDERS_GBNF: "0",
    });
    assert.deepEqual(calls, []);
});

test("{§provider-instantiation} configured GBNF requires a provider that advertises local transport", () => {
    const calls: string[] = [];
    assert.throws(
        () => ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls, false), {
            PLURNK_PROVIDERS_GBNF: "/operator/rails/custom.gbnf",
        }),
        /does not advertise GBNF transport/,
    );
    assert.deepEqual(calls, []);
});

test("{§provider-instantiation} per-alias GBNF admission resolves when the bare setting is empty", () => {
    const calls: string[] = [];
    ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls), {
        PLURNK_PROVIDERS_GBNF: "",
        PLURNK_MODEL: "rig",
        PLURNK_MODEL_rig: "openai/local",
        PLURNK_PROVIDERS_GBNF_rig: "/operator/rails/rig.gbnf",
    });
    assert.deepEqual(calls, []);
});
});

describe("meta-passthrough", () => {
// {§provider-surface}: provider metadata reaches the client through loop usage
// as an opaque, unenforced blob.










// Mock can't return `meta`; wrap it so the turn still concludes but the
// response carries an opaque blob — exactly what a real hosted provider does.
class MetaProvider implements Provider {
    #base: Mock;
    #meta: Record<string, unknown>;
    constructor(meta: Record<string, unknown>) {
        this.#base = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        this.#meta = meta;
    }
    get contextWindow(): number | null { return this.#base.contextWindow; }
    get maxInputTokens(): number | null { return this.#base.maxInputTokens; }
    get maxOutputTokens(): number | null { return this.#base.maxOutputTokens; }
    get outputBudget(): number | null { return this.#base.outputBudget; }
    get reasoningBudget(): number | null { return this.#base.reasoningBudget; }
    get supportedEfforts() { return this.#base.supportedEfforts; }
    get inputCapacity(): number | null { return this.#base.inputCapacity; }
    get outputFloor(): number | null { return this.#base.outputFloor; }
    get inputWall(): number | null { return this.#base.inputWall; }
    get model(): string { return this.#base.model; }
    get inputModalities(): ReadonlySet<InputModality> { return this.#base.inputModalities; }
    countPromptTokens(...args: Parameters<Mock["countPromptTokens"]>): ReturnType<Mock["countPromptTokens"]> {
        return this.#base.countPromptTokens(...args);
    }
    assessRequestCapacity(...args: Parameters<Mock["assessRequestCapacity"]>): ReturnType<Mock["assessRequestCapacity"]> {
        return this.#base.assessRequestCapacity(...args);
    }
    async generate(args: Parameters<Mock["generate"]>[0]): Promise<ProviderResponse> {
        return { ...(await this.#base.generate(args)), meta: this.#meta };
    }
}

test("{§provider-surface} a provider's opaque meta blob rides through to the loop usage payload, unenforced", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `meta-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const meta = { balance: { amount: "0.000123456789", currency: "XMR" }, vendorWhatever: { nested: true }, future: "field we never coded for" };
        await engine.runTurn({ provider: new MetaProvider(meta), workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const usage = await engine.loopUsage(loopId);
        // Forwarded verbatim — including fields the service has never heard of (the honest passthrough).
        assert.deepEqual(usage.meta, meta, "the provider's whole meta blob reaches the loop payload, byte-for-byte");
        assert.deepEqual((usage.meta as { balance: object }).balance, meta.balance, "provider metadata is reachable by the client");
    } finally { await db.close(); }
});

test("{§provider-surface} no provider meta → empty {} (never null, never fabricated)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `meta-empty-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // A plain Mock returns no `meta`.
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const usage = await engine.loopUsage(loopId);
        assert.deepEqual(usage.meta, {}, "absent provider meta surfaces as {}, so the client renders nothing");
    } finally { await db.close(); }
});
});

describe("operator-grammar", () => {
// {§provider-instantiation} and {§provider-instantiation} across a real core turn: an
// operator's GBNF file reaches the provider verbatim, unrelated alias settings never leak, an
// unreadable grammar fails instead of running unconstrained, and the turn records
// transport as evidence (#588).














const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const usage = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    outputTokenDetails: { textTokens: 1, reasoningTokens: 1 },
};

const staticProvider = (response: Omit<ProviderResponse, "accounting" | "capacity">): Provider => ({
    model: "fake",
    inputModalities: new Set<InputModality>(),
    contextWindow: 100000,
    maxInputTokens: null,
    maxOutputTokens: null,
    outputBudget: 1,
    reasoningBudget: null,
    supportedEfforts: ["off", "adaptive", "low", "medium", "high"],
    inputCapacity: 99999,
    inputWall: null,
    outputFloor: null,
    constrainsOutput: true,
    generate: async ({ messages, observeRequest }) => {
        const accounting = {
            provider: "provider:fake",
            model: "fake",
            outcome: "response",
            usage,
            cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "rail fixture" },
        } as const;
        const settle = await observeRequest?.({ provider: accounting.provider, model: accounting.model });
        await settle?.(accounting);
        return { ...response, accounting: [accounting], capacity: testProviderCapacity(messages, 100000) };
    },
    countPromptTokens: async () => ({ kind: "exact", tokens: 1, source: "test:exact" }),
    assessRequestCapacity: async (messages) => testProviderCapacity(messages, 100000),
});

// A Mock that RECORDS what generate receives — the end of the chain, observed directly.
const recordingProvider = (): { provider: Provider; calls: Array<{ grammar?: string }> } => {
    const calls: Array<{ grammar?: string }> = [];
    const base = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: "````SEND\nok\n````", reasoning: null } },
    ] });
    // plain delegation — a Proxy breaks Mock's private-field getters (#contextWindow via Reflect)
    const provider = {
        get contextWindow() { return base.contextWindow; },
        get maxInputTokens() { return base.maxInputTokens; },
        get maxOutputTokens() { return base.maxOutputTokens; },
        get outputBudget() { return base.outputBudget; },
        get reasoningBudget() { return base.reasoningBudget; },
        get supportedEfforts() { return base.supportedEfforts; },
        get inputModalities() { return base.inputModalities; },
        get inputCapacity() { return base.inputCapacity; },
        get inputWall() { return base.inputWall; },
        get outputFloor() { return base.outputFloor; },
        get model() { return base.model; },
        countPromptTokens: (...args: Parameters<Mock["countPromptTokens"]>) => base.countPromptTokens(...args),
        assessRequestCapacity: (...args: Parameters<Mock["assessRequestCapacity"]>) => base.assessRequestCapacity(...args),
        generate: (args: { grammar?: string }) => { calls.push({ grammar: args.grammar }); return base.generate(args as never); },
    } as unknown as Provider;
    return { provider, calls };
};

const envelope = async (db: Awaited<ReturnType<typeof openMigrated>>) => {
    const workspaceId = await insertWorkspace(db, `rail-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    return { workspaceId, sessionId, loopId };
};

test("{§provider-instantiation} the operator's grammar file text reaches generate through a real turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railprobe";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railprobe");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(calls.length, 1, "one generate call");
        assert.equal(calls[0].grammar, 'root ::= "PROBE-RAIL"\n', "the grammar FILE TEXT arrived at the provider, verbatim");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("{§provider-instantiation} an alias-free provider ignores unrelated suffixed grammars and uses the global configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_someotheralias";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        // Remove the active selector so this provider is explicitly alias-free.
        const modelKeys = Object.keys(process.env).filter((k) => k.startsWith("PLURNK_MODEL"));
        const savedModels = modelKeys.map((k) => [k, process.env[k]] as const);
        for (const k of modelKeys) delete process.env[k];
        try {
            const { provider, calls } = recordingProvider();
            ProviderInstantiate.registerConfigurationScope(provider, null);
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const { workspaceId, sessionId, loopId } = await envelope(db);
            await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
            assert.equal(calls.length, 1);
            assert.equal(calls[0].grammar, undefined, "another alias's grammar is not a global fallback");
        } finally { for (const [k, v] of savedModels) process.env[k] = v; }
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

for (const path of ["/nonexistent/rail/never-here.gbnf", `missing-${crypto.randomUUID()}.gbnf`]) test(`{§provider-instantiation} unreadable ${path} fails before inference`, async () => {
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railbroken";
    const prior = process.env[key];
    try {
        process.env[key] = path;
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railbroken");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        await assert.rejects(
            () => engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 }),
            { code: "ENOENT" },
        );
        assert.equal(calls.length, 0, "unreadable grammar never falls back to unconstrained inference");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close();
    }
});

test("{§provider-instantiation} a filename in the daemon working directory reaches the provider verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const previousCwd = process.cwd();
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railnamed";
    const prior = process.env[key];
    try {
        const grammar = 'root ::= "LOCAL-GRAMMAR"\n';
        await writeFile(join(dir, "local.gbnf"), grammar);
        process.chdir(dir);
        process.env[key] = "local.gbnf";
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railnamed");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.deepEqual(calls, [{ grammar }]);
    } finally {
        process.chdir(previousCwd);
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§provider-instantiation} the turn records whether the grammar reached the wire, and grades nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "evidence.gbnf");
    await writeFile(gbnfPath, 'root ::= "anything the operator wrote"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_evidencebox";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, sessionId, loopId } = await envelope(db);
        // The emission does not match the grammar at all; nothing in the service cares.
        const content = "````SEND\ndone\n````";
        const transported = staticProvider({
            assistant: { content, reasoning: null, finishReason: "stop", model: "fake" },
            assistantRaw: {},
            grammarEvidence: { input: content, contentStart: 0, transported: true },
        });
        ProviderInstantiate.registerConfigurationScope(transported, "evidencebox");
        const t1 = await engine.runTurn({ provider: transported, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 1 });
        const meta1 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t1.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta1.railsAttached, "client", "transport evidence is recorded");
        assert.deepEqual(Object.keys(meta1), ["railsAttached"], "the turn records transport evidence and nothing else");

        const withheld = staticProvider({
            assistant: { content, reasoning: null, finishReason: "stop", model: "fake" },
            assistantRaw: {},
            grammarEvidence: { input: content, contentStart: 0, transported: false },
        });
        ProviderInstantiate.registerConfigurationScope(withheld, "evidencebox");
        const t2 = await engine.runTurn({ provider: withheld, workspaceId, sessionId, loopId, messages: MESSAGES, turnNumber: 2 });
        const meta2 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t2.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta2.railsAttached, "withheld", "a provider that did not send it says so, and the turn still completes");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});
});

describe("provider-accounting", () => {
// {§provider-request-accounting}: normalized physical requests are the only
// accounting authority; every broader total is an exact derived projection.















test("{§provider-surface} model evidence cannot be orphaned or replaced by a fabricated terminal state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `model-specialization-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "specialization");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const call = await ModelCall.open(db, {
            turnId: turn.id, kind: "emission", attributions: [], model: "fixture/generation-model",
        });
        await assert.rejects(
            db.test_delete_model_call_specialization.run({ id: call.id }),
            /cannot be deleted independently/u,
        );
        await assert.rejects(
            db.test_terminalize_inference_call_without_evidence.run({ id: call.id, state: "response" }),
            /terminal state requires specialization evidence/u,
        );
        assert.equal((await db.test_workspaces_delete.run({ id: workspaceId })).changes, 1);
        assert.deepEqual(await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }), []);
    } finally { await db.close(); }
});

const openRequest = async (
    db: Db,
    loopId: number,
    turnSequence: number,
    accounting: ProviderRequestAccounting,
): Promise<void> => {
    const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
    assert.equal(turn.sequence, turnSequence);
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turn.id,
        kind: "emission",
        attributions: "[]",
        model: accounting.model,
    });
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        model_call_id: modelCall!.id,
    });
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall!.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    const settled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request!.id, accounting),
    );
    assert.equal(settled.changes, 1);
    if (accounting.outcome === "response") {
        await db.engine_observe_model_call_response.run({
            id: modelCall!.id,
            native_inputs: "[]",
            response: JSON.stringify({ assistant: { content: "fixture" } }),
            failure: null,
            capacity: JSON.stringify(testDeferredProviderCapacity("accounting:fixture")),
            finish_reason: "stop",
            model: accounting.model,
        });
        await db.engine_classify_turn_attempt_response.run({
            id: attempt!.id,
            accepted: 1,
            parse_errors: "[]",
        });
    } else {
        await db.engine_fail_model_call.run({
            id: modelCall!.id,
            failure: JSON.stringify({ status: 502, problem: { status: 502 } }),
            capacity: null,
        });
    }
    await Turn.recordInference(db, turn.id, {
        packet: JSON.stringify({ weight: 0, attributions: [] }),
        sections: "[]",
        usageCurationBudget: null,
        finishReason: accounting.outcome === "response" ? "stop" : null,
        model: accounting.model,
        meta: "{}",
    });
    await Turn.complete(db, turn.id, accounting.outcome === "response" ? 200 : 502);
};

const fixture = async (): Promise<{
    db: Db;
    loopId: number;
}> => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `money-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "account");
    return { db, loopId };
};

test("{§provider-request-accounting} loop accounting adds decimal strings exactly without denormalized rollups", async () => {
    const { db, loopId } = await fixture();
    try {
        await openRequest(db, loopId, 1, {
            provider: "provider:a",
            model: "a",
            outcome: "response",
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            cost: {
                kind: "estimated",
                amount: { amount: "0.1", currency: "USD" },
                source: "fixture rate",
            },
        });
        await openRequest(db, loopId, 2, {
            provider: "provider:b",
            model: "b",
            outcome: "response",
            usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
            cost: {
                kind: "charged",
                amount: { amount: "0.2", currency: "USD" },
                source: "fixture charge",
            },
        });

        const accounting = (await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, "0.3");
        assert.deepEqual(accounting.usage, {
            inputTokens: 30,
            outputTokens: 5,
            totalTokens: 35,
        });
        assert.equal(accounting.requests.length, 2);
    } finally {
        await db.close();
    }
});

test("{§provider-request-accounting} one unknown request makes the total unknown without erasing its known subtotal", async () => {
    const { db, loopId } = await fixture();
    try {
        await openRequest(db, loopId, 1, {
            provider: "provider:a",
            model: "a",
            outcome: "response",
            cost: {
                kind: "charged",
                amount: { amount: "4.25", currency: "USD" },
                source: "direct charge",
            },
        });
        await openRequest(db, loopId, 2, {
            provider: "provider:b",
            model: "b",
            outcome: "error",
            cost: { kind: "unknown", reason: "provider supplied no monetary evidence" },
        });

        const accounting = (await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, null, "the unknown request is not free");
        assert.equal(accounting.knownCostUsd, "4.25", "received price evidence survives separately");
        assert.equal(accounting.requests[0]?.cost.kind, "charged");
        assert.equal(accounting.requests[1]?.cost.kind, "unknown");
    } finally {
        await db.close();
    }
});

test("{§provider-request-accounting} the baseline has no floating-point or denormalized accounting columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-money-schema-"));
    const path = join(dir, "plurnk.db");
    const db = await openMigrated(path);
    try {
        const tableInfo = (table: string): Promise<Array<{ name: string; type: string }>> =>
            db.test_provider_accounting_table_info.all({ table });
        for (const table of [
            "workspaces",
            "sessions",
            "turns",
            "inference_calls",
            "model_calls",
            "turn_attempts",
        ]) {
            assert.equal(
                (await tableInfo(table)).some(({ name }) => name.startsWith("usage_") || name === "cost_usd"),
                table === "turns",
                `${table} has no accounting rollup (turns retains only usage_curation_budget)`,
            );
        }
        assert.deepEqual(
            (await tableInfo("turns")).filter(({ name }) => name.startsWith("usage_")).map(({ name }) => name),
            ["usage_curation_budget"],
        );
        assert.equal(
            (await tableInfo("provider_requests")).some(({ type }) => type === "REAL"),
            false,
            "money is stored as canonical TEXT, never REAL",
        );
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
});
