import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import { Mock } from "@plurnk/plurnk-providers";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

// {§tokenomics-client-gauge}: cardinal request totals are billing evidence; the
// latest physical request and latest turn allowance form the client gauge.

const recordRequest = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    turnId: number,
    input: number,
): Promise<void> => {
    const attempt = await db.test_context_insert_attempt.get<{ id: number }>({ turn_id: turnId });
    await db.test_context_insert_request.run({ turn_attempt_id: attempt!.id, input });
};

test("loopUsage.contextTokens is the latest turn's prompt, not the summed total", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // Two turns, a context that grows: prompts 100 then 250.
        const first = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            prompt_budget: null,
        });
        const second = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            prompt_budget: null,
        });
        await recordRequest(db, first!.id, 100);
        await recordRequest(db, second!.id, 250);

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.accounting.usage?.inputTokens, 350, "inputTokens sums across physical requests");
        assert.equal(usage.contextTokens, 250, "contextTokens is the LAST turn's prompt (occupancy)");
    } finally { await db.close(); }
});

test("loopUsage.promptBudget follows the latest turn across a model switch", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-size-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // Turn 1 ran a 49k-window model; turn 2 switched to a 200k-window model.
        const first = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            prompt_budget: 49152,
        });
        const second = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            prompt_budget: 200000,
        });
        await recordRequest(db, first!.id, 100);
        await recordRequest(db, second!.id, 250);

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.promptBudget, 200000, "promptBudget is the LAST turn's effective ceiling — the switched-to model's policy, not the stale default");
        assert.equal(usage.contextTokens, 250, "numerator + denominator come from the same (last) turn/model");
    } finally { await db.close(); }
});

test("loopUsage.promptBudget is null when the provider reports no window", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-null-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A windowless provider — usage_prompt set, usage_prompt_budget left NULL.
        const turn = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            prompt_budget: null,
        });
        await recordRequest(db, turn!.id, 100);

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.promptBudget, null, "no window → null (the client omits the gauge)");
    } finally { await db.close(); }
});

test("loopUsage does not reuse an earlier turn's context when the latest provider call never completed", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-failed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const completed = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            prompt_budget: 49152,
        });
        await recordRequest(db, completed!.id, 100);
        await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            prompt_budget: 200000,
        });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.contextTokens, null, "an absent latest exchange remains unknown rather than fabricated zero");
        assert.equal(usage.promptBudget, 200000, "the denominator still describes the latest attempted turn");
    } finally { await db.close(); }
});

test("runTurn stores the effective prompt budget, not the raw context window", async () => {
    // Mock-bootstrap partition: REASONING=256 COMPLETION=1024 SAFETY=64. A 8192-window model's stored
    // denominator = 8192 - 1344 = 6848 — the room the packet actually lives under.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-budget-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 8192, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } }] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }] });
        const usage = await engine.loopUsage(loopId);
        const expected = 8192 - Number(process.env.PLURNK_PROVIDERS_REASONING_RESERVE) - Number(process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE) - Number(process.env.PLURNK_SERVICE_SAFETY);
        assert.equal(usage.promptBudget, expected, `the stored denominator is the partitioned budget (${expected}), never the raw 8192`);
    } finally { await db.close(); }
});

test("providers.list advertises the effective prompt budget", async () => {
    const { rpcCall, connect, withDaemon, makeMockResponse } = await import("./_rpc.ts");
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("## SEND0 [200]\ndone", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "gauge-345" });
            const resp = await rpcCall(ws, 2, "providers.list");
            const result = resp.result as { aliases: Array<{ active: boolean; promptBudget: number | null }> };
            const active = result.aliases.find((a) => a.active);
            const expected = 8192 - Number(process.env.PLURNK_PROVIDERS_REASONING_RESERVE) - Number(process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE) - Number(process.env.PLURNK_SERVICE_SAFETY);
            assert.equal(active?.promptBudget, expected, `the gauge denominator is the effective budget (${expected}), not the raw window (8192)`);
        } finally { ws.close(); }
    });
});
