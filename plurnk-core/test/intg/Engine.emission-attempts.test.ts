import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import type { MockResponse, ProviderUsage } from "@plurnk/plurnk-providers";
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

const invalid = (content: string, usage?: Partial<ProviderUsage>, reasoning: string | null = null): MockResponse => ({
    assistant: { content, reasoning, usage },
});

class AttemptWitness extends Mock {
    readonly packets: string[] = [];

    override calculateCost({ prompt, completion, reasoning }: ProviderUsage): number {
        return (prompt + completion + reasoning) / 1_000;
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
            usage_cost_usd: number;
            packet: string;
        }>({ id: result.turnId });
        assert.equal(turn?.usage_prompt, 60, "turn accounting includes every billed attempt");
        assert.equal(turn?.usage_completion, 9);
        assert.equal(turn?.usage_cost_usd, 0.069);
        const packet = JSON.parse(turn?.packet ?? "{}") as { assistant?: { content?: string } };
        assert.equal(packet.assistant?.content, "<<PLAN:complete the task:PLAN\n<<SEND[200]:accepted:SEND");
        assert.doesNotMatch(JSON.stringify(packet), /prose without|never ended/, "rejected emissions never enter packet history");

        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: result.turnId });
        assert.equal(rows.filter((row) => row.op === "error").length, 0, "invalid emissions do not mint model-visible errors");
        assert.equal(rows.filter((row) => row.op === "model").length, 2, "only the turn-zero exemplar and accepted emission are mirrored");

        const loopUsage = await engine.loopUsage(loopId);
        assert.equal(loopUsage.promptTokens, 60, "aggregate usage includes retries");
        assert.equal(loopUsage.contextTokens, 30, "context occupancy is the latest attempt, not the billed sum");
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
        }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, finish_reason }) => ({ accepted, finish_reason })), [
            { accepted: 0, finish_reason: "length" },
            { accepted: 1, finish_reason: "length" },
        ]);
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
            "<<READ(worker:///x):$fC:READ",
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
        assert.ok(failed.statuses.includes(400), "the malformed matcher becomes a failed operation");
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
        assert.ok(result.statuses.includes(400), "the syntax failure participates in strike accounting");
        assert.ok(result.statuses.includes(409), "SEND[200] refuses to conclude past the unseen failure");
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

test("three invalid emissions fail the run below the strike rail", async () => {
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
        assert.equal(result.turnIds.length, 1);
        assert.equal(provider.packets.length, 3, "the inner attempt limit is independent of maxStrikes");
        assert.equal(new Set(provider.packets).size, 1);

        const turnId = result.turnIds[0]!;
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: turnId });
        assert.deepEqual(attempts.map((attempt) => attempt.accepted), [0, 0, 0]);
        const turn = await db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
        assert.equal(turn?.status, 500);
        assert.equal((JSON.parse(turn?.packet ?? "{}") as { assistant?: unknown }).assistant, undefined);
        const rows = await db.test_log_entries_by_turn.all<{ op: string }>({ turn_id: turnId });
        assert.equal(rows.filter((row) => row.op === "error").length, 0);
        assert.equal(rows.filter((row) => row.op === "model").length, 1, "no rejected emission is mirrored");
        Digest.run({ dbPath, digestDir });
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            loops: Array<{ result: unknown }>;
        };
        assert.deepEqual(
            digest.loops[0]?.result,
            result.result,
            "the digest preserves the exact terminal generation Problem",
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
    try {
        const provider = new AttemptWitness({
            contextWindow: 100_000,
            responses: [
                invalid("rejected bytes", { prompt: 10, completion: 2, total: 12 }, "rejected reasoning"),
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
            "rejected bytes",
        );
        const rejectedResponse = JSON.parse(
            await readFile(join(digestDir, "packet000.attempt001.rejected.response.json"), "utf8"),
        ) as { assistant?: { content?: string } };
        assert.equal(rejectedResponse.assistant?.content, "rejected bytes");
        const parseErrors = JSON.parse(
            await readFile(join(digestDir, "packet000.attempt001.rejected.parse-errors.json"), "utf8"),
        ) as unknown[];
        assert.ok(parseErrors.length > 0);
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

test("a provider failure after a rejected emission preserves the completed attempt and its billed usage", async () => {
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
            usage_cost_usd: number;
        }>({ loop_id: loopId });
        assert.equal(turn?.usage_prompt, 10);
        assert.equal(turn?.usage_completion, 2);
        assert.equal(turn?.usage_cost_usd, 0.012);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: turn!.id });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0]);
    } finally {
        await db.close();
    }
});

test("an internal attempt-processing failure is not mislabeled as a provider failure", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const root = new Error("cost contract failed");
        class BrokenCost extends AttemptWitness {
            override calculateCost(): number {
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
                scope: "workspace",
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
        assert.ok(failed.statuses.includes(403), "the valid turn dispatches its failing operation");

        const recovery = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: recovery.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.match(packetSection(packet, "errors"), /403 log:\/\//, "the operation failure reaches the recovery turn");
        assert.match(packetSection(packet, "log"), /sealed:\/\/\/x/, "the failed operation remains in model-visible history");
    } finally {
        await db.close();
    }
});
