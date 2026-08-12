import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import type { MockResponse, ProviderAttempt, ProviderRequestAccounting, ProviderUsage } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Digest from "../../src/digest/Digest.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection, seedEntryWithChannel } from "./_helpers.ts";

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
        content: `# PLAN1\ncomplete the task\n\n## SEND1 [200]\n${body}`,
        reasoning: null,
    },
    ...(usage === undefined ? {} : { usage, cost: estimatedCost(usage) }),
});

const continuing = (body = "continue"): MockResponse => ({
    assistant: {
        content: `# PLAN1\ncontinue the task\n\n## FIND1 (log:///**) <1,1>\n\n## SEND1 [102]\n${body}`,
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
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, workspaceId, workerId, loopId, engine };
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
            const attempts = await db.test_turn_attempts.all<{
                state: string;
                completed_at: string | null;
            }>({ turn_id: (await db.test_turns_get_full.get<{ id: number }>({ loop_id: loopId }))!.id });
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

test("invalid emissions retry beneath one turn against the identical packet, then admit only the valid response", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("prose without a turn", requestUsage(10, 2, 1, 4)),
                invalid("# PLAN1\nstarted but never ended", requestUsage(20, 3, 2, 5)),
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
        assert.equal((await db.test_count_turns.get<{ n: number }>())?.n, 1, "attempts do not open extra turns");

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
        assert.equal(packet.assistant?.content, "# PLAN1\ncomplete the task\n\n## SEND1 [200]\naccepted");
        assert.doesNotMatch(JSON.stringify(packet), /prose without|never ended/, "rejected emissions never enter packet history");

        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string }>({ turn_id: result.turnId });
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "invalid emissions do not mint model-visible errors");
        assert.equal(rows.filter((row) => row.op === null && JSON.parse(row.attrs).kind === "model_emission").length, 2, "only the turn-zero exemplar and accepted emission are mirrored");

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
            "# PLAN1\ninspect first",
            "## READ1 (worker:///missing)",
            "## EDIT1 (worker:///notes.md",
        ].join("\n\n");
        const accepted = "# PLAN1\ncomplete despite the cap\n\n## SEND1 [200]\ndone";
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
            message: "target slot of `## EDIT1` opened at line 6 but never closed - add `)`",
            line: 6,
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

test("a GBNF-legal $fC matcher failure is bounded, admitted once, and made model-visible (#12/#16)", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const malformed = [
            "# PLAN1\ninspect relevant modules",
            "## FIND1 (worker:///x)\n$fC",
            "## SEND1 [102]\ninspect the results next",
        ].join("\n\n");
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid(malformed),
                invalid("# PLAN1\nweigh the failed operation\n\n## SEND1 [499]\nthe matcher was malformed"),
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
            origin === "model" && (op === "PLAN" || op === "error" || op === "SEND"));
        assert.deepEqual(
            authored.map(({ op, status_rx }) => ({ op, status_rx })),
            [
                { op: "PLAN", status_rx: 200 },
                { op: "error", status_rx: 400 },
                { op: "SEND", status_rx: 102 },
            ],
            "the recovered failure is committed before the turn disposition",
        );
        const syntaxFailure = JSON.parse(authored[1]!.rx) as {
            problem?: {
                type?: string;
                detail?: string;
                line?: number;
                source?: string;
                recovery?: string;
            };
        };
        assert.equal(
            syntaxFailure.problem?.type,
            "https://problems.plurnk.dev/grammar/parser/invalid-operation-syntax",
        );
        assert.match(syntaxFailure.problem?.detail ?? "", /not a valid jsonpath/i);
        assert.equal(syntaxFailure.problem?.line, 4);
        assert.equal(syntaxFailure.problem?.source, "visitor");
        assert.equal(
            syntaxFailure.problem?.recovery,
            "Correct only the failed operation; sibling operations were retained.",
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
        assert.match(packetSection(packet, "errors"), /400 log:\/\/\/.*\/error/);
        assert.match(
            packetSection(packet, "log"),
            /not a valid jsonpath/i,
            "the next turn receives the parser's actionable diagnostic",
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
                invalid([
                    "# PLAN1\nsearch and conclude",
                    "## FIND1 (**)\n/unterminated[",
                    "## SEND1 [200]\ndone",
                ].join("\n\n")),
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
            result.outcomes.some(({ op, status }) => op === "SEND" && status === 409),
            "SEND[200] refuses to conclude past the unseen failure",
        );
        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            status_rx: number;
            op: string;
            origin: string;
        }>({ turn_id: result.turnId });
        const authored = rows.filter(({ origin, op }) =>
            origin === "model" && (op === "PLAN" || op === "error" || op === "SEND"));
        assert.deepEqual(
            authored.map(({ op, status_rx }) => ({ op, status_rx })),
            [
                { op: "PLAN", status_rx: 200 },
                { op: "error", status_rx: 400 },
                { op: "SEND", status_rx: 409 },
            ],
        );
    } finally {
        await db.close();
    }
});

test("{§destination-scope-boundary} a malformed COPY destination cannot dispatch or materialize", async () => {
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
            responses: [invalid([
                "# PLAN1\ncopy the selected source lines",
                "## COPY1 (worker:///src.md) <2,3>\nworker:///slice.md<0>:",
                "## SEND1 [102]\ninspect the copy result",
            ].join("\n"))],
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

test("a hard parse error outside the PLAN...SEND frame retries wholesale", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid([
                    "# PLAN1\nconclude too early",
                    "## SEND1 [200]\ndone",
                    "## EDIT1 (worker:///must-not-exist)\nvalue",
                ].join("\n")),
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
        assert.equal(result.emissionAttempts, 2);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 1]);
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

test("{§invalid-emission-attempts} exhausted private attempts expose only the latest response and generic notice on one recovery turn", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    const latestRejected = [
        "# PLAN1\ninspect the source",
        "## READ1 (file:///main.go",
        "## SEND1 [102]\ncontinue after inspection",
    ].join("\n\n");
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
                const rows = await db.engine_render_log.all<{ expanded: number; attrs: string }>({ worker_id: workerId });
                const rejectedMirror = rows.find((row) => JSON.parse(row.attrs).admission === "rejected");
                assert.equal(rejectedMirror?.expanded, 0, "the recovery packet does not require durably OPEN malformed content");
            }
            return await generate(args);
        };

        const result = await engine.runLoop({
            provider,
            workspaceId,
            workerId,
            loopId,
            maxStrikes: 1,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.result.status, 200);
        assert.equal(result.reason, "external", "the admitted SEND concludes through the ordinary loop lifecycle");
        assert.equal(result.turnIds.length, 3, "the lifeline is an honestly stored engine turn");
        assert.equal(provider.packets.length, 5);
        assert.equal(new Set(provider.packets.slice(0, 3)).size, 1, "private attempts retain one exact packet");
        assert.notEqual(provider.packets[3], provider.packets[2], "the informed recovery has its own packet");
        assert.match(provider.packets[3]!, /Your previous response contained an unrecoverable syntax error\. No operations were performed\. Try again\./);
        assert.match(provider.packets[3]!, /1:# PLAN1\\n2:inspect the source/);
        assert.doesNotMatch(provider.packets[3]!, /first private invalid|second private invalid/);
        assert.doesNotMatch(provider.packets[3]!, /line [0-9]+|missing|expected/i, "no parser diagnosis is manufactured");
        assert.doesNotMatch(provider.packets[4]!, /1:# PLAN1\\n2:inspect the source/, "the rejected emission is projected only into its recovery packet");

        const [failedTurnId, recoveryTurnId, finalTurnId] = result.turnIds;
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
            expanded: number;
            attrs: string;
        }>({ worker_id: workerId });
        const rejectedMirror = rows.find((row) => JSON.parse(row.attrs).admission === "rejected");
        assert.ok(rejectedMirror !== undefined);
        assert.equal(rejectedMirror.turn_seq, 1);
        assert.equal(rejectedMirror.expanded, 0, "the rejected model item remains durably folded");
        assert.match(rejectedMirror.rx, /## READ1 \(file:\/\/\/main\.go/);
        assert.equal(rows.filter((row) => row.origin === "model" && row.op === "READ").length, 0, "no rejected operation dispatches");
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "the lifeline does not fabricate an operation failure");
    } finally {
        await db.close();
    }
});

test("{§invalid-emission-attempts} consecutive exhaustion of the informed recovery turn fails below the strike rail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-invalid-emission-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const { db, workspaceId, workerId, loopId, engine } = await setup(dbPath);
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("first invalid"),
                invalid("# PLAN1\nno terminal"),
                invalid("## SEND1 [200]\nno plan"),
                invalid("recovery invalid one"),
                invalid("recovery invalid two"),
                invalid("recovery invalid three"),
            ],
        });

        const result = await engine.runLoop({
            provider,
            workspaceId,
            workerId,
            loopId,
            maxStrikes: 1,
            messages: [{ role: "user", content: "do the task" }],
        });

        assert.equal(result.reason, "invalid_emission");
        assert.equal(result.result.status, 500);
        assert.equal(result.result.problem?.detail, "No valid PLAN...SEND turn was received after 3 emission attempts.");
        assert.equal(result.turnIds.length, 2);
        assert.equal(provider.packets.length, 6, "each turn receives its independent private attempt budget");
        assert.equal(new Set(provider.packets.slice(0, 3)).size, 1);
        assert.equal(new Set(provider.packets.slice(3)).size, 1);
        assert.notEqual(provider.packets[2], provider.packets[3]);
        assert.match(provider.packets[3]!, /Your previous response contained an unrecoverable syntax error\. No operations were performed\. Try again\./);
        assert.match(provider.packets[3]!, /1:## SEND1 \[200\]\\n2:no plan/);

        const [firstTurnId, recoveryTurnId] = result.turnIds;
        const firstAttempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: firstTurnId });
        const recoveryAttempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: recoveryTurnId });
        assert.deepEqual(firstAttempts.map((attempt) => attempt.accepted), [0, 0, 0]);
        assert.deepEqual(recoveryAttempts.map((attempt) => attempt.accepted), [0, 0, 0]);
        const firstTurn = await db.test_get_turn.get<{ packet: string; status: number }>({ id: firstTurnId });
        const recoveryTurn = await db.test_get_turn.get<{ packet: string; status: number }>({ id: recoveryTurnId });
        assert.equal(firstTurn?.status, 102);
        assert.equal(recoveryTurn?.status, 500);
        assert.equal((JSON.parse(firstTurn?.packet ?? "{}") as { assistant?: unknown }).assistant, undefined);
        assert.equal((JSON.parse(recoveryTurn?.packet ?? "{}") as { assistant?: unknown }).assistant, undefined);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string }>({ turn_id: recoveryTurnId });
        assert.equal(rows.filter((row) => row.op === "error").length, 0);
        assert.equal(rows.filter((row) => row.op === null && JSON.parse(row.attrs).kind === "model_emission").length, 0, "the terminal rejection is forensic-only");
        const mirrors = await db.test_model_emission_rows.all<{ turn_id: number; attrs: string }>({ worker_id: workerId });
        assert.equal(mirrors.filter((row) => JSON.parse(row.attrs).admission === "rejected").length, 1, "only the response that informs the bounded recovery is mirrored");
        const renderedMirrors = await db.engine_render_log.all<{ expanded: number; attrs: string }>({ worker_id: workerId });
        const rejectedMirror = renderedMirrors.find((row) => JSON.parse(row.attrs).admission === "rejected");
        assert.equal(rejectedMirror?.expanded, 0, "the rejected model item remains durably folded when recovery exhausts");
        Digest.run({ dbPath, digestDir });
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            loops: Array<{ result: unknown }>;
        };
        assert.deepEqual(
            digest.loops[0]?.result,
            result.result,
            "the digest preserves the exact terminal generation Problem",
        );
        const informedPacket = await readFile(join(digestDir, "packet001.user.md"), "utf8");
        assert.match(informedPacket, /Your previous response contained an unrecoverable syntax error\. No operations were performed\. Try again\./);
        assert.match(informedPacket, /1:## SEND1 \[200\]\n2:no plan/);
        assert.equal(
            await readFile(join(digestDir, "packet000.attempt003.rejected.assistant.md"), "utf8"),
            "## SEND1 [200]\nno plan",
        );
        assert.equal(
            await readFile(join(digestDir, "packet001.attempt003.rejected.assistant.md"), "utf8"),
            "recovery invalid three",
        );
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
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
            await readFile(join(digestDir, "packet000.attempt001.rejected.assistant.md"), "utf8"),
            rejected,
        );
        const rejectedResponse = JSON.parse(
            await readFile(join(digestDir, "packet000.attempt001.rejected.response.json"), "utf8"),
        ) as { assistant?: { content?: string } };
        assert.equal(rejectedResponse.assistant?.content, rejected);
        const parseErrors = JSON.parse(
            await readFile(join(digestDir, "packet000.attempt001.rejected.parse-errors.json"), "utf8"),
        ) as Array<{ line?: number; column?: number; source?: string }>;
        assert.deepEqual(
            { line: parseErrors[0]?.line, column: parseErrors[0]?.column, source: parseErrors[0]?.source },
            { line: 1, column: 15, source: "parser" },
            "the persisted digest evidence retains parser code-point coordinates",
        );
        assert.equal(
            await readFile(join(digestDir, "packet000.assistant.md"), "utf8"),
            "# PLAN1\ncomplete the task\n\n## SEND1 [200]\naccepted bytes",
        );
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /rejected-emissions=1\/2/);
        assert.doesNotMatch(markdown, /rejected bytes/, "rejected content stays out of the accepted-turn waterfall");
        const reasoning = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.match(reasoning, /Attempt 1 - rejected/);
        assert.match(reasoning, /rejected reasoning/);
        assert.match(reasoning, /turn must begin with/);
        assert.match(reasoning, /Attempt 2 - admitted/);
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turn_attempts: Array<{ accepted: boolean }>;
        };
        assert.deepEqual(json.turn_attempts.map(({ accepted }) => accepted), [false, true]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a provider failure after a rejected emission preserves both issued calls and the completed usage", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("rejected before outage", requestUsage(10, 2)),
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
                assert.equal(error.result.status, 503);
                return true;
            },
        );

        assert.equal(provider.packets.length, 2);
        assert.equal(new Set(provider.packets).size, 1, "the infrastructure failure occurred on the same-packet retry");
        const turn = await db.test_turns_get_full.get<{ id: number }>({ loop_id: loopId });
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
        ]);
        assert.equal((await engine.loopUsage(loopId)).accounting.costUsd, null);
        const attempts = await db.test_turn_attempts.all<{
            state: "response" | "error";
            accepted: number | null;
            failure: string | null;
        }>({ turn_id: turn!.id });
        assert.deepEqual(attempts.map(({ state, accepted }) => ({ state, accepted })), [
            { state: "response", accepted: 0 },
            { state: "error", accepted: null },
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

        const turn = await db.test_turns_get_full.get<{ id: number }>({ loop_id: loopId });
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
    const realConsoleError = console.error;
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
        console.error = () => {};

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
                assert.equal(error.result.status, 502);
                assert.equal(
                    error.result.problem.type,
                    "https://problems.plurnk.dev/engine/provider/provider-contract-violation",
                );
                return true;
            },
        );

        assert.deepEqual((await engine.loopUsage(loopId)).accounting.requests, [requestAccounting]);
    } finally {
        console.error = realConsoleError;
        await db.close();
    }
});

test("#161: a complete-looking resource-interrupted attempt is persisted but never admitted or replayed", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const content = "# PLAN1\nlooks complete\n\n## SEND1 [200]\nmust never dispatch";
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
            meta: { requestId: "interrupted-1" },
        };
        const provider = new AttemptWitness({ contextWindow: 100_000, responses: [] });
        let calls = 0;
        provider.generate = async (args) => {
            calls++;
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
                assert.equal(error.result.status, 503);
                assert.equal(
                    error.result.problem.type,
                    "https://problems.plurnk.dev/provider/mock/resource-interrupted",
                );
                return true;
            },
        );

        assert.equal(calls, 1, "provider-declared interruption bypasses emission rerolls");
        const turn = await db.test_turns_get_full.get<{
            id: number;
            status: number;
            packet: string;
            finish_reason: string | null;
            model: string;
            meta: string;
        }>({ loop_id: loopId });
        assert.equal(turn?.status, 503);
        const accounting = (await engine.loopUsage(loopId)).accounting;
        assert.deepEqual(accounting.usage, requestAccounting.usage);
        assert.equal(accounting.costUsd, "0.02", "response-bearing interrupted requests retain their estimated cost");
        assert.equal(turn?.finish_reason, "resource_interrupted");
        assert.equal(turn?.model, "interrupted-model");
        assert.deepEqual(JSON.parse(turn?.meta ?? "{}"), { requestId: "interrupted-1" });
        assert.equal(
            "assistant" in (JSON.parse(turn?.packet ?? "{}") as Record<string, unknown>),
            false,
            "the failed turn remains request-only",
        );

        const attempts = await db.test_turn_attempts.all<{
            accepted: number;
            response: string;
            parse_errors: string;
            finish_reason: string | null;
            model: string;
        }>({ turn_id: turn!.id });
        assert.equal(attempts.length, 1);
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

        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: turn!.id });
        assert.equal(
            rows.some(({ origin, op }) => origin === "model" && (op === "PLAN" || op === "SEND")),
            false,
            "no operation from the interrupted response dispatches",
        );
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
        const turn = await db.test_turns_get_full.get<{ id: number }>({ loop_id: loopId });
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
                writableBy: ["plurnk"],
                volatile: false,
                modelVisible: true,
                example: "",
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
                        content: "# PLAN1\nattempt the edit\n\n## EDIT1 (sealed:///x)\nvalue\n\n## SEND1 [200]\ndone",
                        reasoning: null,
                    },
                },
                {
                    assistant: {
                        content: "# PLAN1\nweigh the failure\n\n## SEND1 [499]\ncannot write that resource",
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
        assert.match(packetSection(packet, "errors"), /403 log:\/\//, "the operation failure reaches the recovery turn");
        assert.match(packetSection(packet, "log"), /sealed:\/\/\/x/, "the failed operation remains in model-visible history");
    } finally {
        await db.close();
    }
});
