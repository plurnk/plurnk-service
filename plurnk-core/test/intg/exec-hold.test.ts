// §exec-hold-until-concluded — the turn-hold exception (owner ruling): runtimes in
// PLURNK_SERVICE_EXEC_HOLD pause the cycle until their stream concludes, so the model never
// burns a turn waiting on a result the engine controls end-to-end. Bounded + fail-open.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertSession, insertRun, insertLoop, testExecutors, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

let wireN = 0;
const wire = async (finishAfterMs: number) => {
    // unique tag per wiring: testExecutors() is a shared cached registry — a duplicate
    // hotload tag throws and leaks the just-opened db, wedging the file run.
    const tag = `holdstub${++wireN}`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.hotloadRuntime(tag, {
        executor: {
            runtime: tag, glyph: "?",
            get manifest() { return { name: tag, protocol: `${tag}:`, channels: {}, defaultChannel: "results", category: "action", scope: "run", writableBy: ["model"], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return {}; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args) => {
                await new Promise((r) => setTimeout(r, finishAfterMs));
                args.write("results", JSON.stringify([{ title: "HOLD-DONE" }]), "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        glyph: "?", example: "", documentation: "", available: true, detail: undefined,
    });
    const sessionId = await insertSession(db, `hold-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "hold test");
    return { db, engine, sessionId, runId, loopId, tag };
};

const streamsSection = (packetJson: string): string => {
    const p = JSON.parse(packetJson) as { sections?: Array<{ name: string; content: string }> };
    return p.sections?.find((s) => s.name === "child-streams")?.content ?? "";
};

const driveLoop = async (finishAfterMs: number, midTurns: number) => {
    const { db, engine, sessionId, runId, loopId, tag } = await wire(finishAfterMs);
    try {
        const responses = [
            { assistant: { content: "", reasoning: null, ops: [execStmt(tag, "go"), sendStmt(102, null, "searching")] } },
            ...Array.from({ length: midTurns }, () => ({ assistant: { content: "", reasoning: null, ops: [sendStmt(102, null, "the standard-cycle waiting turn")] } })),
            { assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } },
        ];
        const provider = new Mock({ contextWindow: 100000, responses: responses as never });
        const t0 = Date.now();
        const result = await engine.runLoop({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }], maxTurns: 5 });
        const elapsed = Date.now() - t0;
        const turn2 = await (db.test_get_turn as import("../../src/core/Db.ts").PrepMethod).get<{ packet: string }>({ id: result.turnIds[1] });
        return { result, elapsed, streams: streamsSection(turn2?.packet ?? "{}"), tag };
    } finally { await db.close(); }
};

test("[§exec-hold-until-concluded] a HOLD runtime pauses the cycle — turn 2 assembles AFTER the stream concludes", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "holdstub1";
    try {
        const { result, elapsed, streams } = await driveLoop(800, 0);
        assert.equal(result.finalStatus, 200);
        assert.ok(elapsed >= 800, `the cycle paused for the stream (elapsed ${elapsed}ms >= 800ms)`);
        assert.ok(!/holdstub1/.test(streams), "turn 2's packet lists NO live holdstub stream — it woke to a finished world");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});

test("[§exec-hold-until-concluded] a runtime OUTSIDE the hold set keeps the standard cycle — turn 2 sees the live stream", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "some-other-runtime";
    try {
        // The standard cycle: T2 assembles IMMEDIATELY (stream live), continues; T3 concludes
        // after the stream finished — the pending set never falsely blocks a concluded world.
        const { result, streams } = await driveLoop(1200, 1);
        assert.equal(result.finalStatus, 200);
        assert.ok(/holdstub2/.test(streams), "turn 2's packet LISTS the live stream — no hold applied outside the set");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});
