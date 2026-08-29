// {§overflow-turn} — an over-ceiling candidate becomes a transparent,
// packetless `_plurnk` turn. The provider never sees the rejected candidate;
// ordinary FOLD operations own every recovery effect.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, logEntries, packetSection } from "./_helpers.ts";
import { planValue, sendStmt } from "./_dsl.ts";

const MESSAGES = [
    { role: "system" as const, content: "You are an agent." },
    { role: "user" as const, content: "go" },
];

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

const providerAt = (capacity: number, responses: MockResponse[]): Mock => {
    const previousOutput = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const previousReasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(1_000_000 - capacity);
    delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    const provider = new Mock({ contextWindow: 1_000_000, responses });
    if (previousOutput === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previousOutput;
    if (previousReasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previousReasoning;
    return provider;
};

test("overflow is a packetless _plurnk turn composed from ordinary FOLD operations", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `overflow-turn-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const longBody = Array.from({ length: 120 }, (_, index) => `${index + 1}: ${"context ".repeat(16)}`).join("\n");

        await engine.runTurn({
            provider: providerAt(999_000, [response([sendStmt(102, null, longBody)])]),
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });

        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        const probeProvider = providerAt(999_000, []);
        const probe = await new PacketBuilder({ db, schemes, executors: () => undefined }).buildRequestPacket({
            initialMessages: MESSAGES,
            workspaceId,
            workerId,
            loopId,
            currentTurnSeq: next!.next,
            provider: probeProvider,
            gitStatus: null,
        });
        const recoveryProvider = providerAt(Math.max(1, probe.weight - 50), [response([sendStmt(200, null, "done")])]);

        const recovery = await engine.runTurn({
            provider: recoveryProvider,
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 2,
        });

        assert.equal(recovery.status, 102, `the automatic overflow turn made enough room for a successor model turn: ${JSON.stringify(recovery)}`);
        assert.equal(recoveryProvider.remaining, 1, "the over-ceiling candidate never reaches provider.generate");
        const recoveryTurn = await db.test_get_turn.get<{
            producer: string;
            kind: string;
            packet: string | null;
            sequence: number;
        }>({ id: recovery.turnId });
        assert.deepEqual(
            { producer: recoveryTurn?.producer, kind: recoveryTurn?.kind },
            { producer: "_plurnk", kind: "overflow" },
        );
        assert.equal(recoveryTurn?.packet, null, "the recovery turn assembled no model request");

        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            origin: string;
            lineMarker: string | null;
            attrs: string;
            tx: string;
            rx: string;
            folded: string;
        }>({ turn_id: recovery.turnId });
        const operationRows = rows.filter(({ op }) => op !== null);
        assert.equal(operationRows[0]?.op, "PLAN");
        assert.equal(operationRows[0]?.origin, "_plurnk");
        assert.deepEqual(
            (JSON.parse(operationRows[0]!.tx) as { body: unknown }).body,
            planValue("Automatically FOLD log bodies newly active at token-budget overflow."),
        );
        assert.equal(operationRows.at(-1)?.op, "SEND");
        assert.ok(operationRows.some(({ op, origin }) => op === "FOLD" && origin === "_plurnk"), "recovery uses the ordinary FOLD dispatcher");

        const turnOps = rows.find(({ op }) => op === null);
        assert.equal(turnOps?.origin, "_plurnk");
        assert.equal(JSON.parse(turnOps?.attrs ?? "null").kind, "turnOps");
        assert.equal(turnOps?.folded, "[[1,-1]]", "the exact recovery program is born folded like every non-initialization turnOps");
        const recoverySource = (JSON.parse(turnOps?.rx ?? "null") as { content: string }).content;
        assert.match(recoverySource, /^# PLAN0\n\[\{"content":"Automatically FOLD log bodies newly active at token-budget overflow\.","status":"in_progress"}\]\n/);
        assert.match(recoverySource, /\n## FOLD0 /, "the source records the same ordinary FOLD operations");
        assert.match(
            recoverySource,
            /\n## SEND0 \[102\]\nNext: YOU MUST ONLY FOLD, KILL, or trim ALL superseded, stale, or irrelevant log content in bulk\.$/,
            "the successor must dedicate its next turn to comprehensive bulk curation",
        );

        const tags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: workerId });
        assert.ok(tags.some(({ tag }) => tag === "_plurnk"));
        assert.ok(tags.some(({ tag }) => tag === "overflow"));

        const nextTurn = await engine.runTurn({
            provider: recoveryProvider,
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 2,
        });
        assert.equal(recoveryProvider.remaining, 0, "the fitted successor reaches the provider exactly once");
        const packetRow = await db.test_get_turn.get<{ packet: string | null }>({ id: nextTurn.turnId });
        const packet = JSON.parse(packetRow!.packet!);
        assert.equal(packetSection(packet, "notices"), "", "ordinary recovery needs no synthetic notice");
        const recoveryPrefix = `log:///1/${recoveryTurn!.sequence}/`;
        const materializedRecovery = logEntries(packet).filter(({ path }) => String(path).startsWith(recoveryPrefix));
        assert.ok(materializedRecovery.some((row) => String(row.path).endsWith("/PLAN") && "body" in row), "the actual PLAN row materializes open (body present, #338)");
        assert.ok(materializedRecovery.some((row) => String(row.path).endsWith("/SEND") && "body" in row), "the actual SEND row materializes open (body present, #338)");
        assert.ok(materializedRecovery.some((row) => String(row.path).endsWith("/ops") && !("body" in row) && "tokensBody" in row), "the actual turnOps row materializes folded (tokensBody without body, #338)");
        assert.ok(!materializedRecovery.some(({ path }) => String(path).endsWith("/FOLD")), "successful recovery FOLD receipts use the universal suppression rule");
    } finally {
        await db.close();
    }
});

test("overflow turn identity classifies pre-model rows created before reclassification", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `overflow-prelude-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "a prompt that becomes an ordinary prompt row");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = providerAt(1, [response([sendStmt(200, null, "unused")])]);

        const recovery = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });

        assert.equal(recovery.producer, "_plurnk");
        assert.equal(recovery.kind, "overflow");
        assert.equal(provider.remaining, 1, "reclassification happens before provider I/O");
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; op: string }>({ turn_id: recovery.turnId });
        assert.ok(rows.some(({ op }) => op === "prompt"), "the pre-model prompt remains an operation in the overflow turn");
        const tags = await db.test_log_tags_by_turn.all<{ sequence: number; tag: string }>({ turn_id: recovery.turnId });
        for (const row of rows) {
            const rowTags = tags.filter(({ sequence }) => sequence === row.sequence).map(({ tag }) => tag);
            assert.ok(rowTags.includes("_plurnk"), `row ${row.sequence} carries kernel provenance`);
            assert.ok(rowTags.includes("overflow"), `row ${row.sequence} carries overflow provenance`);
        }
        const visible = await db.engine_render_log.all<{
            turn_seq: number;
            op: string | null;
            folded: string;
            weight: number;
        }>({ worker_id: workerId });
        const causalBodies = visible.filter(({ turn_seq, op, weight }) =>
            weight > 0 && (turn_seq < 2 || op === "prompt"));
        assert.ok(causalBodies.length > 0, "initialization and prompt created model-facing bodies");
        assert.ok(causalBodies.every(({ folded }) => folded === "[[1,-1]]"), "the first overflow whole-folds both the preceding initialization and current prompt boundary");

        const successor = providerAt(999_000, [response([sendStmt(200, null, "done")])]);
        await engine.runTurn({
            provider: successor,
            workspaceId,
            workerId,
            loopId,
            messages: MESSAGES,
            turnNumber: 1,
        });
        const prompts = await db.test_count_op.get<{ n: number }>({ op: "prompt" });
        assert.equal(prompts?.n, 1, "the same model ordinal after overflow does not republish the durable prompt frame");
    } finally {
        await db.close();
    }
});
