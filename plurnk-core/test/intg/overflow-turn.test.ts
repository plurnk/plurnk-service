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
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

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

        assert.equal(recovery.status, 102, `the transparent recovery made enough room for a successor model turn: ${JSON.stringify(recovery)}`);
        assert.equal(recoveryProvider.remaining, 1, "the over-ceiling candidate never reaches provider.generate");
        const recoveryTurn = await db.test_get_turn.get<{ packet: string | null }>({ id: recovery.turnId });
        assert.equal(recoveryTurn?.packet, null, "the recovery turn assembled no model request");

        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            origin: string;
            lineMarker: string | null;
            attrs: string;
            rx: string;
        }>({ turn_id: recovery.turnId });
        const receipt = rows.find(({ op }) => op === null);
        assert.equal(receipt?.origin, "_plurnk");
        assert.equal(JSON.parse(receipt!.attrs).kind, "overflow");
        const receiptBody = JSON.parse(receipt!.rx).content as string;
        assert.match(receiptBody, /^# PLAN0\n\* Token Budget Overflow:/);
        assert.match(receiptBody, /## FOLD0 \[\+_plurnk,\+overflow\].*<1,-1>/);
        assert.ok(rows.some(({ op, origin }) => op === "FOLD" && origin === "_plurnk"), "recovery uses the ordinary FOLD dispatcher");

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
        assert.match(packetSection(packet, "notices"), /token_budget_overflow: Token Budget Overflow:/);
    } finally {
        await db.close();
    }
});
