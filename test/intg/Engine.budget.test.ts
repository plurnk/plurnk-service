import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, packetSection } from "./_helpers.ts";

test("computeCeiling: dual-mode — <=1 is a window ratio, >1 an absolute wall capped at the window", () => {
    assert.equal(Engine.computeCeiling(1000, 0.9), 900, "ratio");
    assert.equal(Engine.computeCeiling(32768, 0.9), 29491, "ratio, floored");
    assert.equal(Engine.computeCeiling(32768, 1500), 1500, "absolute wall under the window");
    assert.equal(Engine.computeCeiling(1000, 1500), 1000, "absolute wall capped at the real window");
    assert.equal(Engine.computeCeiling(null, 1500), 1500, "absolute wall holds with no reported window");
    assert.equal(Engine.computeCeiling(null, 0.9), null, "ratio mode needs a window");
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
});

test("Engine.runTurn: budget readout — ratio-derived ceiling, free reconciles to ceiling − assembled total", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextSize: 4000, responses: [response([sendStmt(200, "done")])] });
        const result = await engine.runTurn({
            provider, sessionId, runId, loopId,
            messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: "go" }],
        });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { tokens: number; sections: Array<{ tokens: number }> };
        const budget = packetSection(packet, "budget");
        // default ratio 0.9 → floor(4000 × 0.9) = 3600
        assert.match(budget, /Token Ceiling 3600 · Token Usage \d+ \(\d+%\) · Tokens Free \d+/, "headline carries the ratio-derived ceiling, usage, percent, and free");
        const free = Number(/Tokens Free (\d+)/.exec(budget)?.[1]);
        const total = packet.sections.reduce((n, s) => n + s.tokens, 0); // summed per-section render-weights (the assembled request size, inter-section joins aside)
        assert.ok(free > 0 && free < 3600, `free ${free} within (0, 3600)`);
        // Reconciles to ceiling − assembled total, within the placeholder/number
        // substitution delta (tokensFree's own digits change the packet's size).
        assert.ok(Math.abs(free - (3600 - total)) <= 25, `free ${free} ~= 3600 - ${total}`);
    } finally { await db.close(); }
});
