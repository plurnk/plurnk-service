// #421/#507 — §tokenomics-window-unpollable-deliberate: an unpollable window (provider.contextWindow
// null after the provider tier's env/probe/catalog all miss) is genuinely-unknown — nobody chose an
// envelope — and is treated as NO-CAP: the prompt is unbounded, the budget/ceiling are null, and the
// gauge omits its headline (never a stand-in the operator never chose; a probe blip degrades, never
// crashes). The deliberate-window arm lives in the PROVIDER tier (PLURNK_PROVIDERS_CONTEXT_WINDOW);
// core's retired per-alias spelling fails hard naming the successor.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

test("[§tokenomics-window-unpollable-deliberate] null window + no per-alias knob → NO-CAP: the turn builds unbounded and the gauge omits its headline (#421)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `unpollable-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const mock = new Mock({ contextWindow: null, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        // No cap: an unknown window has no denominator — null, not a stand-in improvised from bare numbers.
        assert.equal(engine.promptBudgetFor(mock), null, "the prompt budget is null — genuinely-unknown, uncapped");
        const result = await engine.runTurn({ provider: mock, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.ok(result.turnId > 0, "the turn builds unbounded — a probe blip degrades to no-cap, never crashes the loop");
        // The gauge omits its Token Ceiling headline (no percent to compute) — the FOLD-target lines still ship.
        const packet = JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        const budget = packet.sections.find((s) => s.name === "budget");
        assert.ok(budget, "the budget section still ships");
        assert.doesNotMatch(budget.content, /Token Ceiling/, "no ceiling headline — the window is unbounded, there is no percent to show");
    } finally { await db.close(); }
});

test("[§tokenomics-window-unpollable-deliberate] the retired per-alias window knob FAILS HARD naming its provider-tier successor (#507)", async () => {
    // The deliberate-stand-in arm moved to the provider tier (PLURNK_PROVIDERS_CONTEXT_WINDOW_<alias>);
    // a stale core-prefixed pin must never silently lose the operator's window to the move.
    process.env.PLURNK_SERVICE_CONTEXT_WINDOW_mocktest = "8192";
    const db = await openMigrated();
    try {
        assert.throws(
            () => new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES }),
            /PLURNK_SERVICE_CONTEXT_WINDOW_mocktest is retired \(#507\).+PLURNK_PROVIDERS_CONTEXT_WINDOW_mocktest/,
        );
    } finally {
        delete process.env.PLURNK_SERVICE_CONTEXT_WINDOW_mocktest;
        await db.close();
    }
});
