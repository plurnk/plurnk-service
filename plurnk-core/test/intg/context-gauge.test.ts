import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import { Mock } from "@plurnk/plurnk-providers";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

// #263 — loopUsage.contextTokens is the gauge's numerator: the LAST turn's prompt tokens (window
// occupancy), distinct from the summed promptTokens (cost), which overcounts a growing context.

test("[#263] loopUsage.contextTokens is the last turn's prompt, not the summed total", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // Two turns, a context that grows: prompts 100 then 250.
        await (db.test_turns_insert_with_usage_prompt as PrepMethod).run({ loop_id: loopId, sequence: 1, status: 200, packet: "{}", val: 100 });
        await (db.test_turns_insert_with_usage_prompt as PrepMethod).run({ loop_id: loopId, sequence: 2, status: 200, packet: "{}", val: 250 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.promptTokens, 350, "promptTokens sums across turns (the cost figure)");
        assert.equal(usage.contextTokens, 250, "contextTokens is the LAST turn's prompt (occupancy)");
    } finally { await db.close(); }
});

// #274 — loopUsage.promptBudget is the gauge's DENOMINATOR: the LAST turn's PROMPT BUDGET
// (effective window minus the partition reserves — owner ruling: the raw n_ctx overstates the
// usable room by the reserve total). A /model-switched loop reports the budget of the model
// that actually ran (not the stale active one).
test("[#274] loopUsage.promptBudget is the last turn's model window — survives a model switch", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-size-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // Turn 1 ran a 49k-window model; turn 2 switched to a 200k-window model.
        await (db.test_turns_insert_with_prompt_and_context_size as PrepMethod).run({ loop_id: loopId, sequence: 1, status: 200, packet: "{}", prompt: 100, context_size: 49152 });
        await (db.test_turns_insert_with_prompt_and_context_size as PrepMethod).run({ loop_id: loopId, sequence: 2, status: 200, packet: "{}", prompt: 250, context_size: 200000 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.promptBudget, 200000, "promptBudget is the LAST turn's window — the switched-to model, not the stale default");
        assert.equal(usage.contextTokens, 250, "numerator + denominator come from the same (last) turn/model");
    } finally { await db.close(); }
});

test("[#274] loopUsage.promptBudget is null when the provider reports no window", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-null-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A windowless provider — usage_prompt set, usage_prompt_budget left NULL.
        await (db.test_turns_insert_with_usage_prompt as PrepMethod).run({ loop_id: loopId, sequence: 1, status: 200, packet: "{}", val: 100 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.promptBudget, null, "no window → null (the client omits the gauge)");
    } finally { await db.close(); }
});

test("[#274] runTurn stores the PROMPT BUDGET, not the raw window — the client gauge never overstates room", async () => {
    // .env.test partition: REASONING=256 COMPLETION=1024 SAFETY=64. A 8192-window model's stored
    // denominator = 8192 - 1344 = 6848 — the room the packet actually lives under.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-budget-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 8192, responses: [{ assistant: { content: "", reasoning: null, ops: [{ op: "SEND", suffix: "", signal: 200, target: null, lineMarker: null, body: "done", position: { line: 1, column: 1 } }] } }] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }] });
        const usage = await engine.loopUsage(loopId);
        const expected = 8192 - Number(process.env.PLURNK_SERVICE_REASONING) - Number(process.env.PLURNK_SERVICE_COMPLETION) - Number(process.env.PLURNK_SERVICE_SAFETY);
        assert.equal(usage.promptBudget, expected, `the stored denominator is the partitioned budget (${expected}), never the raw 8192`);
    } finally { await db.close(); }
});

test("[#274] providers.list advertises the EFFECTIVE prompt budget — one denominator meaning on every surface (#345)", async () => {
    const { rpcCall, connect, withDaemon, makeMockResponse } = await import("./_rpc.ts");
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "gauge-345" });
            const resp = await rpcCall(ws, 2, "providers.list");
            const result = resp.result as { aliases: Array<{ active: boolean; promptBudget: number | null }> };
            const active = result.aliases.find((a) => a.active);
            const expected = 8192 - Number(process.env.PLURNK_SERVICE_REASONING) - Number(process.env.PLURNK_SERVICE_COMPLETION) - Number(process.env.PLURNK_SERVICE_SAFETY);
            assert.equal(active?.promptBudget, expected, `the client's gauge denominator is the budget (${expected}), never the raw window (8192) — 'ctx 38%/49k' against a 35k reality was the lie`);
        } finally { ws.close(); }
    });
});
