import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import type { MockResponse, ProviderAttempt, ProviderUsage } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Digest from "../../src/digest/Digest.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection } from "./_helpers.ts";

const valid = (body = "done", usage?: Partial<ProviderUsage>): MockResponse => ({
    assistant: {
        content: `<<PLAN:complete the task:PLAN\n<<SEND[200]:${body}:SEND`,
        reasoning: null,
        usage,
    },
});

const continuing = (body = "continue"): MockResponse => ({
    assistant: {
        content: `<<PLAN:continue the task:PLAN\n<<FIND(log:///**)<1,1>::FIND\n<<SEND[102]:${body}:SEND`,
        reasoning: null,
    },
});

const invalid = (content: string, usage?: Partial<ProviderUsage>, reasoning: string | null = null): MockResponse => ({
    assistant: { content, reasoning, usage },
});

class AttemptWitness extends Mock {
    readonly packets: string[] = [];

    override calculateCost({ prompt, completion, reasoning }: ProviderUsage): number {
        return (prompt + completion + reasoning) / 1_000;
    }

    override calculateCharge(usage: ProviderUsage) {
        return { kind: "estimated" as const, usd: String(this.calculateCost(usage)), source: "attempt witness" };
    }

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

test("provider I/O receives the attempt identity only after its pending row is durable", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [valid("accepted")],
        });
        const generate = provider.generate.bind(provider);
        provider.generate = async (args) => {
            assert.notEqual(args.accounting, undefined);
            const attempts = await db.test_turn_attempts.all<{
                accounting_id: string;
                state: string;
                completed_at: string | null;
            }>({ turn_id: (await db.test_turns_get_full.get<{ id: number }>({ loop_id: loopId }))!.id });
            assert.deepEqual(attempts.map(({ accounting_id, state, completed_at }) => ({
                accounting_id,
                state,
                completed_at,
            })), [{
                accounting_id: args.accounting!.callId,
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
                invalid("prose without a turn", { prompt: 10, completion: 2, total: 12 }),
                invalid("<<PLAN:started but never ended:PLAN", { prompt: 20, completion: 3, total: 23 }),
                valid("accepted", { prompt: 30, completion: 4, total: 34 }),
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
            usage_prompt: number;
        }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ sequence, accepted, usage_prompt }) => ({ sequence, accepted, usage_prompt })), [
            { sequence: 1, accepted: 0, usage_prompt: 10 },
            { sequence: 2, accepted: 0, usage_prompt: 20 },
            { sequence: 3, accepted: 1, usage_prompt: 30 },
        ]);
        assert.ok(JSON.parse(attempts[0]!.parse_errors).length > 0);
        assert.ok(JSON.parse(attempts[1]!.parse_errors).length > 0);
        assert.deepEqual(JSON.parse(attempts[2]!.parse_errors), []);

        const turn = await db.test_get_turn.get<{
            usage_prompt: number;
            usage_completion: number;
            usage_cost_usd: number | null;
            usage_cost: string;
            packet: string;
        }>({ id: result.turnId });
        assert.equal(turn?.usage_prompt, 60, "turn accounting includes every billed attempt");
        assert.equal(turn?.usage_completion, 9);
        assert.equal(turn?.usage_cost_usd, null, "catalog-rate estimates are not settled provider charges");
        const packet = JSON.parse(turn?.packet ?? "{}") as { assistant?: { content?: string } };
        assert.equal(packet.assistant?.content, "<<PLAN:complete the task:PLAN\n<<SEND[200]:accepted:SEND");
        assert.doesNotMatch(JSON.stringify(packet), /prose without|never ended/, "rejected emissions never enter packet history");

        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string }>({ turn_id: result.turnId });
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "invalid emissions do not mint model-visible errors");
        assert.equal(rows.filter((row) => row.op === null && JSON.parse(row.attrs).kind === "model_emission").length, 2, "only the turn-zero exemplar and accepted emission are mirrored");

        const loopUsage = await engine.loopUsage(loopId);
        assert.equal(loopUsage.promptTokens, 60, "aggregate usage includes retries");
        assert.equal(loopUsage.costUsd, null);
        assert.equal(loopUsage.projectedCostUsd, 0.069);
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
                ...valid("settled", { prompt: 10, completion: 2, total: 12 }),
                charge: {
                    kind: "authoritative",
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
        const turn = await db.test_get_turn.get<{
            usage_cost: string;
            usage_cost_usd: number | null;
        }>({ id: result.turnId });
        assert.equal(turn?.usage_cost_usd, 0.0000123456);
        assert.deepEqual(JSON.parse(turn?.usage_cost ?? "[]"), [{
            kind: "authoritative",
            amount: { amount: "123456", currency: "USDTICK" },
            usdEquivalent: "0.0000123456",
            source: "provider response billing fixture",
        }]);
        const loopUsage = await engine.loopUsage(loopId);
        assert.equal(loopUsage.costUsd, 0.0000123456);
        assert.equal(loopUsage.projectedCostUsd, 0.0000123456);
    } finally {
        await db.close();
    }
});

test("finish=length is forensic evidence: an incomplete frame retries wholesale while a complete frame is admitted", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const rejectedPrefix = [
            "<<PLAN:inspect first:PLAN",
            "<<READ(worker:///missing)::READ",
            "<<EDIT(worker:///notes.md):never closed",
        ].join("\n");
        const accepted = "<<PLAN:complete despite the cap:PLAN\n<<SEND[200]:done:SEND";
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
            message: "body of `<<EDIT` opened at line 3 but never closed - add `:EDIT` to terminate",
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

test("a GBNF-legal $fC matcher failure is bounded, admitted once, and made model-visible (#12/#16)", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const malformed = [
            "<<PLAN:inspect relevant modules:PLAN",
            "<<FIND(worker:///x):$fC:FIND",
            "<<SEND[102]:inspect the results next:SEND",
        ].join("\n");
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid(malformed),
                invalid("<<PLAN:weigh the failed operation:PLAN\n<<SEND[499]:the matcher was malformed:SEND"),
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
        assert.equal(syntaxFailure.problem?.line, 2);
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
                    "<<PLAN:search and conclude:PLAN",
                    "<<FIND(**):/unterminated[:FIND",
                    "<<SEND[200]:done:SEND",
                ].join("\n")),
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

test("a hard parse error outside the PLAN...SEND frame retries wholesale", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid([
                    "<<PLAN:conclude too early:PLAN",
                    "<<SEND[200]:done:SEND",
                    "<<EDIT(worker:///must-not-exist):value:EDIT",
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
        "<PLAN:inspect the source:PLAN",
        "<READ(file:///main.go)::READ",
        "<SEND[102]:continue after inspection:SEND",
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
        assert.match(provider.packets[3]!, /<PLAN:inspect the source:PLAN/);
        assert.doesNotMatch(provider.packets[3]!, /first private invalid|second private invalid/);
        assert.doesNotMatch(provider.packets[3]!, /line [0-9]+|missing|expected/i, "no parser diagnosis is manufactured");
        assert.doesNotMatch(provider.packets[4]!, /<PLAN:inspect the source:PLAN/, "the rejected emission is projected only into its recovery packet");

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
        assert.match(rejectedMirror.rx, /<READ\(file:\/\/\/main\.go\)::READ/);
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
                invalid("<<PLAN:no terminal:PLAN"),
                invalid("<<SEND[200]:no plan:SEND"),
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
        assert.match(provider.packets[3]!, /<<SEND\[200\]:no plan:SEND/);

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
        assert.match(informedPacket, /<<SEND\[200\]:no plan:SEND/);
        assert.equal(
            await readFile(join(digestDir, "packet000.attempt003.rejected.assistant.md"), "utf8"),
            "<<SEND[200]:no plan:SEND",
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
                invalid(rejected, { prompt: 10, completion: 2, total: 12 }, "rejected reasoning"),
                valid("accepted bytes", { prompt: 10, completion: 3, total: 13 }),
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
            "<<PLAN:complete the task:PLAN\n<<SEND[200]:accepted bytes:SEND",
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
                invalid("rejected before outage", { prompt: 10, completion: 2, total: 12 }),
            ],
        });
        const realGenerate = provider.generate.bind(provider);
        let calls = 0;
        provider.generate = async (args) => {
            calls++;
            if (calls === 2) {
                provider.packets.push(JSON.stringify(args.messages));
                throw new ProviderError("mock", "network_failure", "provider went offline");
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
        const turn = await db.test_turns_get_full.get<{
            id: number;
            usage_prompt: number;
            usage_completion: number;
            usage_cost_usd: number | null;
            usage_cost: string;
        }>({ loop_id: loopId });
        assert.equal(turn?.usage_prompt, 10);
        assert.equal(turn?.usage_completion, 2);
        assert.equal(turn?.usage_cost_usd, null, "an unpriced provider failure makes the turn total unknown");
        assert.deepEqual(JSON.parse(turn!.usage_cost), [
            { kind: "estimated", usd: "0.012", source: "attempt witness" },
            { kind: "unknown", reason: "provider call failed without response-bearing charge evidence" },
        ]);
        const attempts = await db.test_turn_attempts.all<{
            accounting_id: string;
            state: "response" | "error";
            accepted: number | null;
            failure: string | null;
        }>({ turn_id: turn!.id });
        assert.deepEqual(attempts.map(({ state, accepted }) => ({ state, accepted })), [
            { state: "response", accepted: 0 },
            { state: "error", accepted: null },
        ]);
        assert.equal(new Set(attempts.map(({ accounting_id }) => accounting_id)).size, 2);
        assert.equal(JSON.parse(attempts[1]!.failure!).status, 503);
    } finally {
        await db.close();
    }
});

test("#161: a complete-looking resource-interrupted attempt is persisted but never admitted or replayed", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const content = "<<PLAN:looks complete:PLAN\n<<SEND[200]:must never dispatch:SEND";
        const attempt: ProviderAttempt = {
            assistant: {
                content,
                reasoning: "partial reasoning",
                usage: { prompt: 11, completion: 7, reasoning: 2, cached: 3, total: 20 },
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
            meta: { requestId: "interrupted-1" },
        };
        const provider = new AttemptWitness({ contextWindow: 100_000, responses: [] });
        let calls = 0;
        provider.generate = async (args) => {
            calls++;
            provider.packets.push(JSON.stringify(args.messages));
            throw new ProviderError(
                "mock",
                "resource_interrupted",
                "The provider interrupted generation because inference resources were unavailable.",
                {
                    attempt,
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
            usage_prompt: number;
            usage_completion: number;
            usage_reasoning: number;
            usage_cached: number;
            usage_cost_usd: number | null;
            finish_reason: string | null;
            model: string;
            meta: string;
        }>({ loop_id: loopId });
        assert.equal(turn?.status, 503);
        assert.equal(turn?.usage_prompt, 11);
        assert.equal(turn?.usage_completion, 7);
        assert.equal(turn?.usage_reasoning, 2);
        assert.equal(turn?.usage_cached, 3);
        assert.equal(turn?.usage_cost_usd, null, "an estimated interrupted-attempt cost is not settled money");
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
            usage_cost_usd: number | null;
            finish_reason: string | null;
            model: string;
        }>({ turn_id: turn!.id });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]!.accepted, 0);
        assert.deepEqual(JSON.parse(attempts[0]!.parse_errors), [], "the frame was complete but inadmissible");
        assert.equal(attempts[0]!.usage_cost_usd, null);
        assert.equal(attempts[0]!.finish_reason, "resource_interrupted");
        assert.equal(attempts[0]!.model, "interrupted-model");
        const recordedAttempt = JSON.parse(attempts[0]!.response) as ProviderAttempt;
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
        const root = new Error("cost contract failed");
        class BrokenCost extends AttemptWitness {
            override calculateCharge(): never {
                throw root;
            }
        }
        const provider = new BrokenCost({
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
            usage_cost: string;
        }>({ turn_id: turn!.id });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]!.state, "response");
        assert.equal(attempts[0]!.accepted, null, "parser/cost classification never erases the observed response");
        assert.notEqual(attempts[0]!.response, null);
        assert.deepEqual(JSON.parse(attempts[0]!.usage_cost), {
            kind: "unknown",
            reason: "provider response retained before monetary classification",
        });
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
                        content: "<<PLAN:attempt the edit:PLAN\n<<EDIT(sealed:///x):value:EDIT\n<<SEND[200]:done:SEND",
                        reasoning: null,
                    },
                },
                {
                    assistant: {
                        content: "<<PLAN:weigh the failure:PLAN\n<<SEND[499]:cannot write that resource:SEND",
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
