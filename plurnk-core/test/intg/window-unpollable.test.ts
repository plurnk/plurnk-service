// #377/#421 — §tokenomics-window-unpollable-deliberate: "CONTEXT_WINDOW stands in for unknown physics" only when
// deliberate. An unpollable window (provider.contextSize null) with NO per-alias knob is nobody's
// policy — treated as NO-CAP: the prompt is unbounded, the budget/ceiling are null, and the gauge omits
// its headline (never a stand-in the operator never chose; a probe blip degrades, never crashes). A
// per-alias knob makes the window deliberate and the build proceeds bounded.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

const nullWindowMock = () => new Mock({ contextSize: null, responses: [{ assistant: { content: "", reasoning: null, ops: [] } }] });

test("[§tokenomics-window-unpollable-deliberate] null window + no per-alias knob → NO-CAP: the turn builds unbounded and the gauge omits its headline (#421)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `unpollable-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const mock = new Mock({ contextSize: null, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        // No cap: an unknown window has no denominator — null, not a stand-in improvised from bare numbers.
        assert.equal(engine.promptBudgetFor(mock), null, "the prompt budget is null — genuinely-unknown, uncapped");
        const result = await engine.runTurn({ provider: mock, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.ok(result.turnId > 0, "the turn builds unbounded — a probe blip degrades to no-cap, never crashes the loop");
        // The gauge omits its Token Ceiling headline (no percent to compute) — the FOLD-target lines still ship.
        const packet = JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        const budget = packet.sections.find((s) => s.name === "budget");
        assert.ok(budget, "the budget section still ships");
        assert.doesNotMatch(budget.content, /Token Ceiling/, "no ceiling headline — the window is unbounded, there is no percent to show");
    } finally { await db.close(); }
});

test("[§tokenomics-window-unpollable-deliberate] a per-alias partition knob makes the stand-in DELIBERATE — the build proceeds", async () => {
    // The active test alias is 'mocktest' (test/setup.ts); a per-alias CONTEXT_WINDOW marks its envelope chosen.
    process.env.PLURNK_SERVICE_CONTEXT_WINDOW_mocktest = "8192";
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `deliberate-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const r = await engine.runTurn({ provider: nullWindowMock(), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.ok(r.turnId > 0, "the turn builds — the operator's per-alias CONTEXT_WINDOW stands in deliberately");
    } finally {
        delete process.env.PLURNK_SERVICE_CONTEXT_WINDOW_mocktest;
        await db.close();
    }
});
