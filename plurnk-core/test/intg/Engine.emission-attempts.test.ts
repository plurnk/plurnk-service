import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkProvider, Mock, ProviderError } from "@plurnk/plurnk-providers";
import type { MockResponse, ProviderAttempt, ProviderRequestAccounting, ProviderUsage } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import Digest from "../../src/digest/Digest.ts";
import { ProviderAccountingIntegrityError } from "../../src/core/ModelCall.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection, seedEntryWithChannel, testProviderCapacity } from "./_helpers.ts";

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
\`\`\`SEND
${body}
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``,
        reasoning: null,
    },
    ...(usage === undefined ? {} : { usage, cost: estimatedCost(usage) }),
});

const continuing = (body = "continue"): MockResponse => ({
    assistant: {
        content: `
\`\`\`FIND (log:///**) <1,1>\`\`\`
\`\`\`TASK
${body}
\`\`\``,
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
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "do the task");
    const packetNotifications: Array<{ workspaceId: number; workerId: number; loopId: number; packetCount: number }> = [];
    const engine = new Engine({
        db,
        schemes: new SchemeRegistry(),
        loopPacketNotify: (notifiedWorkspaceId, packet) => packetNotifications.push({ workspaceId: notifiedWorkspaceId, ...packet }),
    });
    return { db, workspaceId, workerId, loopId, engine, packetNotifications };
};

test("provider I/O begins only after its pending attempt row is durable", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
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
            workerId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });
    } finally {
        await db.close();
    }
});

test("{§provider-connectivity}: one model call durably settles a transient request and its successful retry", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
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
                const content = "\n```SEND\nrecovered\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
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
            firstContentTimeoutMs: 1_000,
            streamIdleTimeoutMs: 1_000,
            temperature: 0.2,
            repeatPenalty: 1.15,
            reasoning: { mode: "off", budget: null },
            retryAttempts: 1,
            source: "provider:connectivity-witness",
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
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

test("separator-free provider preamble does not reject a complete model turn", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const content = "harmless status.```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(content)],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 1);
        assert.equal(result.emissionExhausted, false);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => ({
            accepted,
            parseErrors: JSON.parse(parse_errors),
        })), [{ accepted: 1, parseErrors: [] }]);
        const turn = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        assert.equal((JSON.parse(turn?.packet ?? "{}") as { assistant?: { content?: string } }).assistant?.content, content);
    } finally {
        await db.close();
    }
});

test("{§whitespace-contract}: interstitial text executes nothing and survives exactly in READable turnOps", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const source = [
            "Prelude: preparing the edit.",
            PlurnkParser.frame("EDIT (worker:///proof.md)", "Actual body."),
            "3 — invented result, not a receipt.",
            PlurnkParser.frame("SEND", "Only this message is sent."),
            PlurnkParser.frame("TASK", '[{"content":"Edit the proof.","status":"completed"}]'),
            "Postscript: not a second message.",
        ].join("\n");
        const result = await engine.runTurn({
            provider: new AttemptWitness({ contextWindow: 100_000, responses: [invalid(source)] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "Create the proof." }],
        });
        assert.equal(result.emissionAttempts, 1);
        assert.equal(result.emissionExhausted, false);
        assert.equal(result.status, 102, "invented interstitial output cannot satisfy the observation barrier");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => ({ accepted, errors: JSON.parse(parse_errors) })), [{ accepted: 1, errors: [] }]);
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; op: string | null; origin: string; attrs: string; rx: string }>({ turn_id: result.turnId });
        const modelRows = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(modelRows.map(({ op }) => op), ["EDIT", "SEND", "TASK"], "outside text has no independent log or message row");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.equal(sources.find((row) => row.turn_id === result.turnId && row.kind === "ops")?.content, source,
            "the complete submitted emission is retained verbatim");
        const landed = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/proof.md", scheme: "worker", name: "body" });
        assert.equal(landed?.content, "Actual body.");
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: result.turnId });
        const readSource = [
            PlurnkParser.frame(`READ (ops:///1/${turn!.sequence}) <1,-1>`, null),
            PlurnkParser.frame("TASK", '[{"content":"Inspect the original emission.","status":"in_progress"}]'),
        ].join("\n");
        const review = await engine.runTurn({
            provider: new AttemptWitness({ contextWindow: 100_000, responses: [invalid(readSource)] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "Inspect the original emission." }],
        });
        const reviewRows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; status_rx: number }>({ turn_id: review.turnId });
        const read = reviewRows.find(({ op }) => op === "READ");
        assert.equal(read?.status_rx, 200);
        assert.match(read!.rx, /Prelude: preparing the edit\./);
        assert.match(read!.rx, /3 — invented result, not a receipt\./);
        assert.match(read!.rx, /Postscript: not a second message\./);
    } finally {
        await db.close();
    }
});

test("invalid emissions retry beneath one turn against the identical packet, then admit only the valid response", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("prose without a turn", requestUsage(10, 2, 1, 4)),
                invalid("```READ (worker:///broken", requestUsage(20, 3, 2, 5)),
                valid("accepted", requestUsage(30, 4, 3, 6)),
            ],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
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
        assert.ok(JSON.parse(attempts[0]!.parse_errors).length > 0);
        assert.ok(JSON.parse(attempts[1]!.parse_errors).length > 0);
        assert.deepEqual(JSON.parse(attempts[2]!.parse_errors), []);

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
        assert.equal(packet.assistant?.content, "\n```SEND\naccepted\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```");
        assert.doesNotMatch(JSON.stringify(packet), /prose without|worker:\/\/\/broken/, "rejected emissions never enter packet history");

        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string }>({ turn_id: result.turnId });
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "invalid emissions do not mint model-visible errors");
        assert.ok(rows.every(({ op }) => op !== null), "accepted programs add no actionless log row");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
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

test("{§turn-shape} a valid operation without TASK is admitted once without an omission receipt", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid("```EDIT (worker:///proof.md)\nlanded\n```")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
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
        assert.deepEqual(JSON.parse(attempts[0]!.parse_errors), []);

        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            tx: string;
            status_rx: number;
        }>({ turn_id: result.turnId });
        assert.deepEqual(
            rows.filter(({ op }) => op !== null && op !== "prompt").map(({ op }) => op),
            ["EDIT"],
            "only the authored operation is recorded",
        );
        assert.equal(rows.filter(({ status_rx }) => status_rx >= 400).length, 0);
        const landed = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/proof.md",
            scheme: "worker",
            name: "body",
        });
        assert.equal(landed?.content, "landed");
    } finally {
        await db.close();
    }
});

// {§turn-shape} {§parse-diagnostics}
test("a literal nested TASK remains data and the next packet receives only the authored operation's receipt", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const source = "````EDIT (worker:///example.md)\nExample for later:\n```READ (package.json)```\n```TASK\n[{\"content\":\"inspect\",\"status\":\"in_progress\"}]\n```\n````";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(source), valid()],
        });
        const first = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "inspect" }],
        });
        assert.equal(first.status, 102);
        assert.equal(first.emissionAttempts, 1, "literal examples cannot reject the admitted EDIT");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: first.turnId });
        assert.equal(attempts[0]?.accepted, 1);
        assert.deepEqual(JSON.parse(attempts[0]!.parse_errors), []);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; rx: string }>({ turn_id: first.turnId });
        assert.equal(rows.some(({ op }) => op === "READ"), false, "shorter nested fences remain literal data");
        assert.equal(rows.some(({ op }) => op === "TASK"), false, "no real TASK was submitted");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.equal(sources.find(({ turn_id, kind }) => turn_id === first.turnId && kind === "ops")?.content, source);
        const second = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "inspect" }],
        });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: second.turnId });
        const log = packetSection(JSON.parse(row!.packet), "log");
        assert.match(log, /example\.md/u, "the next model turn receives the EDIT receipt");
        assert.doesNotMatch(log, /No tasks were supplied/u, "no omission feedback is injected");
    } finally {
        await db.close();
    }
});

test("a provider-authoritative charge is the settled turn and loop cost", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
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
            workerId,
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

test("finish=length is forensic evidence: an unfinished modifier retries wholesale while a complete frame is admitted", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const rejectedPrefix = [
            "",
            "```READ (worker:///missing)```",
            "```EDIT (worker:///notes.md",
        ].join("\n");
        const accepted = "\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                {
                    assistant: {
                        content: rejectedPrefix,
                        reasoning: null,
                        finishReason: "length",
                    },
                },
                {
                    assistant: {
                        content: accepted,
                        reasoning: null,
                        finishReason: "length",
                    },
                },
            ],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 2);
        const attempts = await db.test_turn_attempts.all<{
            accepted: number;
            finish_reason: string | null;
            parse_errors: string;
        }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, finish_reason }) => ({ accepted, finish_reason })), [
            { accepted: 0, finish_reason: "length" },
            { accepted: 1, finish_reason: "length" },
        ]);
        assert.deepEqual(JSON.parse(attempts[0]!.parse_errors), [{
            message: "target slot of `EDIT` opened at line 3 but never closed - add `)`",
            line: 3,
            column: 0,
            source: "grammar",
        }], "the rejected attempt preserves one tail fact and no recovered-tail diagnostics");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: result.turnId });
        assert.equal(
            rows.filter(({ op, origin }) => origin === "model" && op === "READ").length,
            0,
            "the valid prefix of a rejected frame never dispatches",
        );
        const turn = await db.test_get_turn.get<{ packet: string; finish_reason: string | null }>({ id: result.turnId });
        assert.equal(turn?.finish_reason, "length", "a complete frame remains valid even when the provider reports length");
        assert.equal(
            (JSON.parse(turn?.packet ?? "{}") as { assistant?: { content?: string } }).assistant?.content,
            accepted,
        );
    } finally {
        await db.close();
    }
});

test("{§plan-slotless}: a malformed continuation heading preserves siblings without authorizing completion", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const rejected = "```EDIT (worker:///proof.md)\nthe valid sibling is written\n```\n```TASK [{\"content\":\"keep\n[{\"content\":\"this\\\",\\\"status\\\":\\\"pending\\\"}]\",\"status\":\"in_progress\"}]\n```";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(rejected)],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
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
        const parseErrors = JSON.parse(attempts[0]!.parse_errors) as Array<{ message: string; line: number; source: string }>;
        assert.equal(parseErrors.length, 1, "one bounded diagnostic for the malformed continuation heading");
        assert.equal(parseErrors[0]?.message, "TASK's body begins below the header");
        assert.deepEqual({ line: parseErrors[0]?.line, source: parseErrors[0]?.source }, { line: 4, source: "lexer" });

        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string }>({
            turn_id: result.turnId,
        });
        assert.equal(rows.some(({ origin, op }) => origin === "model" && op === "EDIT"), true);
        const landed = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/proof.md",
            scheme: "worker",
            name: "body",
        });
        assert.equal(landed?.content, "the valid sibling is written");
    } finally {
        await db.close();
    }
});

test("a syntactically legal $fC matcher failure is bounded, admitted once, and made model-visible (#12/#16)", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const malformed = "\n```FIND (worker:///x) [{\"pattern\":\"$fC\"}]```\n\n```TASK\n[{\"content\":\"inspect the results next\",\"status\":\"in_progress\"}]\n```";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid(malformed),
                invalid("\n```SEND\nthe matcher was malformed\n```\n```TASK\n[{\"content\":\"Task failed.\",\"status\":\"failed\"}]\n```"),
            ],
        });

        const failed = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "inspect the code" }],
        });

        assert.equal(failed.status, 102);
        assert.equal(failed.emissionAttempts, 1, "a trustworthy frame is not blindly resampled");
        assert.equal(failed.emissionExhausted, false);
        assert.ok(
            failed.outcomes.some(({ op, status }) => op === null && status === 400),
            "the malformed matcher becomes a failed operation",
        );
        const attempts = await db.test_turn_attempts.all<{
            accepted: number;
            parse_errors: string;
        }>({ turn_id: failed.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
        assert.equal(JSON.parse(attempts[0]!.parse_errors).length, 1, "accepted attempts retain their parse evidence");

        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            status_rx: number;
            op: string;
            origin: string;
            rx: string;
        }>({ turn_id: failed.turnId });
        const authored = rows.filter(({ origin, op }) =>
            origin === "model" && (op === "PLAN" || op === "error" || op === "TASK"));
        assert.deepEqual(
            authored.map(({ op, status_rx }) => ({ op, status_rx })),
            [
                { op: "error", status_rx: 400 },
                { op: "TASK", status_rx: 102 },
            ],
            "the recovered failure is committed before the turn disposition",
        );
        const syntaxFailure = JSON.parse(authored[0]!.rx) as {
            problem?: {
                type?: string;
                detail?: string;
                line?: number;
                source?: string;
                siblingsRetained?: boolean;
            };
        };
        assert.equal(
            syntaxFailure.problem?.type,
            "https://problems.plurnk.xyz/grammar/parser/invalid-operation-syntax",
        );
        assert.match(syntaxFailure.problem?.detail ?? "", /not a valid jsonpath/i);
        assert.equal(syntaxFailure.problem?.line, 2);
        assert.equal(syntaxFailure.problem?.source, "visitor");
        assert.equal(syntaxFailure.problem?.siblingsRetained, true);
        assert.equal("recovery" in (syntaxFailure.problem ?? {}), false);

        const recovery = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "inspect the code" }],
        });
        const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: recovery.turnId });
        const packet = JSON.parse(packetRow?.packet ?? "{}");
        assert.match(packetSection(packet, "errors"), /"status":400,"path":"log:\/\/\/[^"]*\/error"/);
        assert.match(
            packetSection(packet, "log"),
            /not a valid jsonpath/i,
            "the next turn receives the parser's actionable diagnostic",
        );
    } finally {
        await db.close();
    }
});

test("#409: a READ carrying pasted READ lines as a body dispatches without it; one advisory names the option form, echoing nothing", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const renderedRead = [
            "@et6xE 2286:\t// Set debug flag from environment if not already set",
            "@alreh 2287:\tif !requireDebug {",
            "@84fBk 2288:\t\trequireDebug = true;",
        ].join("\n");
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid([
                    `\`\`\`READ (evaluator/functions.go) <2286,2292>
${renderedRead}
\`\`\``,
                    "```TASK\n[{\"content\":\"inspect the result\",\"status\":\"in_progress\"}]\n```",
                ].join("\n\n")),
                invalid("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task failed.\",\"status\":\"failed\"}]\n```"),
            ],
        });

        const failed = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
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
            "the body-bearing READ dispatches without its body ({§matcher-body-redirect})",
        );
        assert.equal(rows.some(({ origin, op }) => origin === "model" && op === "error"), false, "an ignored body is an advisory, never an error row");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
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
            workerId,
            loopId,
            messages: [{ role: "user", content: "inspect the code" }],
        });
        const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: recovery.turnId });
        const packet = JSON.parse(packetRow?.packet ?? "{}");
        const log = packetSection(packet, "log");
        assert.match(JSON.stringify(packet), /READ takes no body; the body was ignored/, "the advisory reaches the next packet");
        assert.doesNotMatch(
            log,
            /@et6xE/,
            "the terse advisory does not echo the body-suppressed submitted program",
        );
    } finally {
        await db.close();
    }
});

test("a bounded malformed operation prevents same-turn completion until the model observes it", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("\n```FIND (**) [{\"pattern\":\"/unterminated[\"}]```\n\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
            ],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "search" }],
        });

        assert.equal(result.emissionAttempts, 1);
        assert.equal(result.status, 102, "the refused SEND keeps the turn non-terminal");
        assert.ok(
            result.outcomes.some(({ op, status }) => op === null && status === 400),
            "the syntax failure participates in strike accounting",
        );
        assert.ok(
            result.outcomes.some(({ op, status }) => op === "TASK" && status === 409),
            "completed TASK inventory cannot conclude past the unseen failure",
        );
        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            status_rx: number;
            op: string;
            origin: string;
        }>({ turn_id: result.turnId });
        const authored = rows.filter(({ origin, op }) =>
            origin === "model" && (op === "PLAN" || op === "error" || op === "TASK"));
        assert.deepEqual(
            authored.map(({ op, status_rx }) => ({ op, status_rx })),
            [
                { op: "error", status_rx: 400 },
                { op: "TASK", status_rx: 409 },
            ],
        );
    } finally {
        await db.close();
    }
});

test("{§transfer-resource-selections} a malformed COPY destination cannot dispatch or materialize", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/src.md",
            content: "one\ntwo\nthree",
            mimetype: "text/markdown",
        });
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid("```COPY (worker:///src.md) <2,3> (worker:///slice.md) <0>:```\n```TASK\n[{\"content\":\"inspect the copy result\",\"status\":\"in_progress\"}]\n```")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
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
            scheme: "worker",
            name: "body",
        });
        assert.equal(source?.content, "one\ntwo\nthree", "admission fails before any source or destination mutation");
    } finally {
        await db.close();
    }
});

test("duplicate dispositions destroy the single-turn boundary and retry wholesale", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```\n```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```\n\n```EDIT (worker:///must-not-exist)\nvalue\n```"),
                invalid("```READ (worker:///anything)```\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```\n```TASK\n[{\"content\":\"Another turn cannot begin here.\",\"status\":\"in_progress\"}]\n```\n```EDIT (worker:///must-not-exist)\nvalue\n```"),
                valid("accepted retry"),
            ],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.status, 200);
        assert.equal(result.emissionAttempts, 3);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 1]);
        const rows = await db.test_log_entries_by_turn.all<{
            op: string;
            origin: string;
        }>({ turn_id: result.turnId });
        assert.equal(
            rows.filter(({ op, origin }) => op === "EDIT" && origin === "model").length,
            0,
            "no parsed prefix or trailing operation from the untrustworthy frame dispatches",
        );
    } finally {
        await db.close();
    }
});

test("{§error-shape}: informed fence recovery explains the boundary, preserves the body, and dispatches no rejected prefix", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const body = "The example:\n```ts\nconst value = 42;\n```\nVerified.";
        const task = PlurnkParser.frame("TASK", '[{"content":"Reported the result.","status":"completed"}]');
        // {§unparsed-tail-boundary} — an unfinished target slot at the end of the input is the one
        // boundary loss left; a missing or mismatched closer no longer is ({§closer-fallback}).
        const rejected = [
            PlurnkParser.frame("EDIT (worker:///must-not-exist)", "never write"),
            "````SEND (worker://reviewer",
        ].join("\n");
        const corrected = [PlurnkParser.frame("SEND", body), task].join("\n");
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [invalid(rejected), invalid(rejected), invalid(rejected), invalid(corrected)],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "Report the result with its code example." }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.turnIds.length, 3, "initialization, rejected turn, and informed recovery");
        const [, failedTurn, recoveryTurn] = result.turnIds;
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: failedTurn });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 0]);
        const message = "target slot of `SEND` opened at line 4 but never closed - add `)`";
        for (const attempt of attempts) assert.deepEqual(JSON.parse(attempt.parse_errors), [{
            line: 4, column: 0, source: "grammar", message,
        }]);
        assert.equal(new Set(provider.packets.slice(0, 3)).size, 1, "private resamples keep the same cacheable packet");
        assert.ok(provider.packets[3]?.includes(message), "the informed recovery sees the parser-owned boundary diagnosis");
        assert.doesNotMatch(provider.packets[3]!, /No tasks were supplied/, "the unfinished SEND is not misreported as an absent TASK");
        const recoveryAttempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: recoveryTurn });
        assert.deepEqual(recoveryAttempts.map(({ accepted }) => accepted), [1]);
        const rows = await db.engine_render_log.all<{ op: string; origin: string; tx: string }>({ worker_id: workerId });
        assert.equal(rows.filter(({ op, origin }) => op === "EDIT" && origin === "model").length, 0);
        assert.equal(rows.filter(({ op, origin }) => op === "SEND" && origin === "model").length, 1);
        const entries = await db.test_list_entries_by_workspace_workspace_pathname.all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.equal(entries.some(({ pathname }) => pathname === "/must-not-exist"), false);
        const send = rows.find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.equal(JSON.parse(send!.tx).body?.raw, body, "the durable message retains the complete literal body");
    } finally { await db.close(); }
});

test("{§invalid-emission-attempts} exhausted private attempts expose the latest response and the parser's diagnostic on one recovery turn", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    const latestRejected = [
        "",
        "```READ (file:///main.go",
        "",
        "continue after inspection",
    ].join("\n");
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("first private invalid response"),
                invalid("second private invalid response"),
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
                const rows = await db.engine_render_log.all<{ initial_folded: string; folded: string; attrs: string }>({ worker_id: workerId });
                const rejectedMirror = rows.find((row) => JSON.parse(row.attrs).kind === "emissionAttempt");
                assert.equal(rejectedMirror?.initial_folded, "[[1,-1]]", "the recovery packet does not require durably visible malformed content");
                assert.equal(rejectedMirror?.folded, "[]", "initial suppression does not trim the rejected program");
            }
            return await generate(args);
        };

        const result = await engine.runLoop({
            provider,
            workspaceId,
            workerId,
            loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.result.status, 200);
        assert.equal(result.reason, "external", "the admitted SEND concludes through the ordinary loop lifecycle");
        assert.equal(result.turnIds.length, 4, "initialization, rejected, informed recovery, and final turns are durable");
        assert.equal(provider.packets.length, 5);
        assert.equal(new Set(provider.packets.slice(0, 3)).size, 1, "private attempts retain one exact packet");
        assert.notEqual(provider.packets[3], provider.packets[2], "the informed recovery has its own packet");
        assert.match(provider.packets[3]!, /Response rejected before dispatch; no operations were performed\./);
        assert.match(provider.packets[3]!, /2:```READ \(file:\/\/\/main\.go\\n3:.*\\n4:continue after inspection/);
        assert.doesNotMatch(provider.packets[3]!, /first private invalid|second private invalid/);
        // {§invalid-emission-attempts} — the informed turn carries the parser's diagnostic and position.
        assert.match(provider.packets[3]!, /Parser: .+ @ \d+:\d+/, "the parser's diagnosis reaches the informed turn");
        assert.doesNotMatch(provider.packets[4]!, /2:```READ \(file:\/\/\/main\.go\\n3:.*\\n4:continue after inspection/, "the rejected emission is projected only into its recovery packet");

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
        }>({ worker_id: workerId });
        const rejectedMirror = rows.find((row) => JSON.parse(row.attrs).kind === "emissionAttempt");
        assert.ok(rejectedMirror !== undefined);
        assert.equal(rejectedMirror.turn_seq, 2, "the rejected emission belongs to the first packet-bearing turn");
        assert.equal(rejectedMirror.initial_folded, "[[1,-1]]", "the rejected model item remains durably body-suppressed");
        assert.equal(rejectedMirror.folded, "[]", "the rejected program remains readable");
        assert.match(rejectedMirror.rx, /```READ \(file:\/\/\/main\.go/);
        assert.equal(rows.filter((row) => row.origin === "model" && row.op === "READ").length, 0, "no rejected operation dispatches");
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "the lifeline does not fabricate an operation failure");
    } finally {
        await db.close();
    }
});

class GarbageProvider extends AttemptWitness {
    garbage: number;
    constructor(garbage: number, responses: ConstructorParameters<typeof AttemptWitness>[0]["responses"]) {
        super({ contextWindow: 100_000, responses });
        this.garbage = garbage;
    }
    override async generate(...args: Parameters<AttemptWitness["generate"]>): ReturnType<AttemptWitness["generate"]> {
        if (this.garbage > 0) {
            this.garbage -= 1;
            const accounting = { provider: "provider:mock", model: this.model, outcome: "error" as const, cost: { kind: "unknown" as const, reason: "torn frame" } };
            const settle = await args[0].observeRequest?.({ provider: "provider:mock", model: this.model });
            await settle?.(accounting);
            throw new ProviderError("mock", "invalid_response", "Failed to process successful response", { accounting: [accounting] });
        }
        return super.generate(...args);
    }
}

test("{§engine-rails} Contract Strikes: one invalid provider response strikes; the loop continues", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new GarbageProvider(1, [
            { assistant: { content: "\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null } },
        ]);
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.result.status, 200, "one torn frame is one strike, never a loop death");
        assert.equal(result.reason, "external", "the loop concluded through its ordinary lifecycle");
    } finally { await db.close(); }
});

test("{§engine-rails} Contract Strikes: three consecutive invalid provider responses strike out", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new GarbageProvider(3, [
            { assistant: { content: "\n```SEND\nnever reached\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null } },
        ]);
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.reason, "strike_threshold", "sustained provider garbage ends through the rail");
        assert.equal(result.result.status, 500);
        assert.equal(provider.garbage, 0, "all three violations were spent crossing the threshold");
    } finally { await db.close(); }
});

test("{§engine-rails} Contract Strikes: consecutive emission exhaustions strike out at three; a clean turn clears", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const cut = { assistant: { content: "no ops here at all", reasoning: null } };
        const good = (body: string) => ({ assistant: { content: `
\`\`\`FIND (log:///**) <1,1>\`\`\`
\`\`\`TASK
${body}
\`\`\``, reasoning: null } });
        const done = { assistant: { content: "\n```SEND\nfinished\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null } };
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
            provider, workspaceId, workerId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.reason, "strike_threshold", "the rail, not a bespoke terminal, ends the loop");
        assert.equal(result.result.status, 500);
        assert.equal(provider.packets.length, 16, "the third consecutive exhaustion crossed; the queued conclusion was never requested");
    } finally { await db.close(); }
});
test("{§invalid-emission-attempts} a frame exhaustion shares prior contract strikes and retains evidence without another request", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        // {§unparsed-tail-boundary} — only an unfinished heading slot at the end of the input rejects.
        const rejected = "````READ (worker:///unfinished";
        const message = "target slot of `READ` opened at line 1 but never closed - add `)`";
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                // Two admitted turns each struck by a bounded matcher failure (an empty TASK is soft).
                invalid("```READ (worker:///absent)```\n```FIND (worker:///x) [{\"pattern\":\"$fC\"}]```"),
                invalid("```READ (worker:///absent)```\n```FIND (worker:///x) [{\"pattern\":\"$fC\"}]```"),
                invalid(rejected), invalid(rejected), invalid(rejected),
                valid("Not requested."),
            ],
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxStrikes: 3, messages: [] });
        assert.equal(result.result.status, 500);
        assert.equal(result.reason, "strike_threshold");
        assert.equal(provider.packets.length, 5, "two admitted struck turns plus three private attempts; no fourth engine turn");
        assert.equal(new Set(provider.packets.slice(2)).size, 1, "private resampling remains cache-stable");
        assert.ok(provider.packets.every((packet) => !packet.includes(message)), "the terminating exhaustion cannot deliver a future recovery packet");
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnIds.at(-1) });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 0]);
        for (const attempt of attempts) assert.deepEqual(JSON.parse(attempt.parse_errors), [{
            line: 1, column: 0, source: "grammar", message,
        }], "the undelivered diagnostic remains in forensic evidence");
    } finally { await db.close(); }
});

test("digest preserves rejected emissions as forensic artifacts without putting them in the accepted packet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-emission-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const { db, workspaceId, workerId, loopId, engine } = await setup(dbPath);
    const rejected = "😀rejected bytes";
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
            workerId,
            loopId,
            messages: [{ role: "user", content: "do the task" }],
        });
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
        assert.equal(
            await readFile(join(digestDir, "packet001.attempt001.rejected.assistant.md"), "utf8"),
            rejected,
        );
        const rejectedResponse = JSON.parse(
            await readFile(join(digestDir, "packet001.attempt001.rejected.response.json"), "utf8"),
        ) as { assistant?: { content?: string } };
        assert.equal(rejectedResponse.assistant?.content, rejected);
        const parseErrors = JSON.parse(
            await readFile(join(digestDir, "packet001.attempt001.rejected.parse-errors.json"), "utf8"),
        ) as Array<{ line?: number; column?: number; source?: string }>;
        assert.deepEqual(
            { line: parseErrors[0]?.line, column: parseErrors[0]?.column, source: parseErrors[0]?.source },
            { line: 1, column: 15, source: "parser" },
            "the persisted digest evidence retains parser code-point coordinates",
        );
        assert.equal(
            await readFile(join(digestDir, "packet001.assistant.md"), "utf8"),
            "\n```SEND\naccepted bytes\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```",
        );
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /rejected-emissions=1\/2/);
        assert.doesNotMatch(markdown, /rejected bytes/, "rejected content stays out of the accepted-turn waterfall");
        const reasoning = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.match(reasoning, /Attempt 1 - rejected/);
        assert.match(reasoning, /rejected reasoning/);
        assert.match(reasoning, /no valid Plurnk operation was found/);
        assert.match(reasoning, /Attempt 2 - admitted/);
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turn_attempts: Array<{ accepted: boolean }>;
        };
        assert.deepEqual(json.turn_attempts.map(({ accepted }) => accepted), [false, true]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§provider-recovery} a provider outage after a rejected emission is absorbed inside the turn and every issued call stays durable", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("rejected before outage", requestUsage(10, 2)),
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
            workerId,
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
        assert.equal((await engine.loopUsage(loopId)).accounting.costUsd, "0.024", "the response-less failure is skipped; the expressible cost survives");
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
        assert.equal(JSON.parse(attempts[1]!.failure!).status, 503);
    } finally {
        await db.close();
    }
});

test("a classified provider error retains billed usage and authoritative charge without a fabricated response", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
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
                workerId,
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
        }>({ turn_id: turn!.id }))[0]!;
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
        assert.equal(attempts[0]!.state, "error");
        assert.equal(attempts[0]!.response, null);
        assert.equal(JSON.parse(attempts[0]!.failure).status, 422);
    } finally {
        await db.close();
    }
});

test("Core rejects a ProviderError whose accounting differs from its observed physical requests", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
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
                workerId,
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

test("#161 {§provider-recovery}: a complete-looking resource-interrupted attempt is persisted, never admitted or replayed, and the call is re-issued", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const content = "\n```SEND\nmust never dispatch\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
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
            workerId,
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
        }>({ turn_id: turn!.id });
        assert.equal(attempts.length, 2, "the interrupted attempt and the re-issued call");
        assert.equal(attempts[1]!.accepted, 1);
        assert.equal(attempts[0]!.accepted, 0);
        assert.deepEqual(JSON.parse(attempts[0]!.parse_errors), [], "the frame was complete but inadmissible");
        assert.equal(attempts[0]!.finish_reason, "resource_interrupted");
        assert.equal(attempts[0]!.model, "interrupted-model");
        const recordedAttempt = JSON.parse(attempts[0]!.response) as Omit<ProviderAttempt, "accounting">;
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

        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string | null }>({ turn_id: turn!.id });
        assert.equal(
            rows.some(({ origin, op, tx }) => origin === "model" && (op === "PLAN" || op === "TASK") && (tx ?? "").includes(content)),
            false,
            "no operation from the interrupted response dispatches",
        );
        assert.equal(rows.filter(({ origin, op }) => origin === "model" && op === "TASK").length, 1, "the re-issued call's emission is the one that dispatches");
        assert.equal(rows.filter(({ op }) => op === "error").length, 1, "the ProviderError remains one durable failure");
    } finally {
        await db.close();
    }
});

test("an internal attempt-processing failure is not mislabeled as a provider failure", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
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
                workerId,
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
        assert.equal(attempts[0]!.state, "response");
        assert.equal(attempts[0]!.accepted, null, "classification failure never erases the observed response");
        assert.notEqual(attempts[0]!.response, null);
        assert.equal((await db.test_provider_requests.all({ turn_id: turn!.id })).length, 1);
        classify.run = originalRun;
    } finally {
        await db.close();
    }
});

test("a valid turn with a failed operation remains recoverable and model-visible", async () => {
    const { db, workspaceId, workerId, loopId } = await setup();
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
                        content: "\n```EDIT (sealed:///x)\nvalue\n```\n\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```",
                        reasoning: null,
                    },
                },
                {
                    assistant: {
                        content: "\n```SEND\ncannot write that resource\n```\n```TASK\n[{\"content\":\"Task failed.\",\"status\":\"failed\"}]\n```",
                        reasoning: null,
                    },
                },
            ],
        });

        const failed = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(failed.emissionAttempts, 1);
        assert.equal(failed.emissionExhausted, false);
        assert.ok(
            failed.outcomes.some(({ op, status }) => op === "EDIT" && status === 403),
            "the valid turn dispatches its failing operation",
        );

        const recovery = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: recovery.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.match(packetSection(packet, "errors"), /"status":403,"path":"log:\/\//, "the operation failure reaches the recovery turn");
        assert.match(packetSection(packet, "log"), /sealed:\/\/\/x/, "the failed operation remains in model-visible history");
    } finally {
        await db.close();
    }
});

test("(#478) a length finish surfaces the output allowance on the next packet, never grammar blame", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                { assistant: { content: "```SEND\nbig write, cut mid-wo\n```", reasoning: null, finishReason: "length" } },
                { assistant: { content: "\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null, finishReason: "stop" } },
            ],
        });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "go" }] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.ok(t1.turnId < t2.turnId);
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        const notices = packetSection(packet, "notices");
        assert.match(
            notices,
            /output_truncated: emission truncated at the output allowance \(\d+ tokens\)$/m,
            "the ceiling cut names its cause and the number",
        );
        assert.doesNotMatch(notices, /incomplete grammar sentence/, "no grammar blame for a capacity cut");
    } finally { await db.close(); }
});

test("(#478) a cut too deep to parse names the truncation, never the parser", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const cut = { assistant: { content: "I will now write the module cache implementa", reasoning: null, finishReason: "length" as const } };
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [cut, cut, cut, continuing("split the write"), valid("finished")],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            maxStrikes: 3,
            messages: [{ role: "user", content: "do the task" }],
        });
        assert.equal(result.result.status, 200);
        // Exhausting the attempt budget opens the informed recovery turn
        // ({§invalid-emission-attempts}); packets[3] is its rendered request.
        assert.equal(provider.packets.length, 5);
        assert.match(
            provider.packets[3]!,
            /output_truncated: emission truncated at the output allowance \(\d+ tokens\); no operations were performed/,
            "the recovery names the engine's cut and the recovery fact",
        );
        assert.doesNotMatch(provider.packets[3]!, /emit in smaller pieces/, "the fact rides without steering");
        assert.doesNotMatch(provider.packets[3]!, /Parser: /, "the parser's symptom never blames the model for the ceiling's cut");
    } finally { await db.close(); }
});
