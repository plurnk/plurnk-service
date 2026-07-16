import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";

// These pin the TABULAR budget baseline; #440's default is the mermaid form (covered by [§budget-mermaid]).
process.env.PLURNK_SERVICE_BUDGET_MERMAID = "off";

test("[§tokenomics-window-partition] the prompt ceiling derives from min(CONTEXT_WINDOW, window) minus reserves — reserves over the window fail hard", async () => {
    // The partition arithmetic, end to end through a real packet build: CONTEXT_WINDOW 10000, reserves
    // 1000+2000+500 → promptBudget 6500 against a wide window; a 5000 window → min caps →
    // 1500; a 3000 window → reserves exceed it → the build fails hard (config contradiction).
    const prev = ["CONTEXT_WINDOW", "REASONING", "COMPLETION", "SAFETY"].map((k) => process.env[`PLURNK_SERVICE_${k}`]);
    process.env.PLURNK_SERVICE_CONTEXT_WINDOW = "10000";
    process.env.PLURNK_SERVICE_REASONING = "1000";
    process.env.PLURNK_SERVICE_COMPLETION = "2000";
    process.env.PLURNK_SERVICE_SAFETY = "500";
    const db = await openMigrated();
    try {
        const run = async (contextWindow: number): Promise<string> => {
            const workspaceId = await insertWorkspace(db, `part-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "p");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow, responses: [response([sendStmt(200, "done")])] });
            const r = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
            return packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: r.turnId }))!.packet), "budget");
        };
        assert.match(await run(100000), /Token Ceiling 6500 /, "wide window → CONTEXT_WINDOW governs: 10000 − 3500 reserves");
        assert.match(await run(5000), /Token Ceiling 1500 /, "narrow window → min(CONTEXT_WINDOW, window) governs: 5000 − 3500");
        await assert.rejects(() => run(3000), /partition contradiction/, "reserves exceeding the window fail hard");
    } finally {
        ["CONTEXT_WINDOW", "REASONING", "COMPLETION", "SAFETY"].forEach((k, i) => {
            if (prev[i] === undefined) delete process.env[`PLURNK_SERVICE_${k}`]; else process.env[`PLURNK_SERVICE_${k}`] = prev[i];
        });
        await db.close();
    }
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
});

test("Engine.runTurn: budget readout — partition-derived ceiling, free reconciles to ceiling − assembled total", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 4000, responses: [response([sendStmt(200, "done")])] });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: "go" }],
        });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { tokens: number; sections: Array<{ tokens: number }> };
        const budget = packetSection(packet, "budget");
        // partition: min(CONTEXT_WINDOW 78848, window 4000) − test reserves (256+1024+64) = 2656
        assert.match(budget, /Token Ceiling 2656 · Token Usage \d+ \(\d+%\) · Tokens Free \d+/, "headline carries the partition-derived ceiling, usage, percent, and free");
        const free = Number(/Tokens Free (\d+)/.exec(budget)?.[1]);
        const total = packet.sections.reduce((n, s) => n + s.tokens, 0); // summed per-section render-weights (the assembled request size, inter-section joins aside)
        assert.ok(free > 0 && free < 2656, `free ${free} within (0, 2656)`);
        // Reconciles to ceiling − assembled total, within the placeholder/number
        // substitution delta (tokensFree's own digits change the packet's size).
        assert.ok(Math.abs(free - (2656 - total)) <= 25, `free ${free} ~= 2656 - ${total}`);
    } finally { await db.close(); }
});
