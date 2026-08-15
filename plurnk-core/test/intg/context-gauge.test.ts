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
    options: { kind?: "emission" | "bare"; sequence?: number; capacity?: number } = {},
): Promise<void> => {
    const kind = options.kind ?? "emission";
    const modelCall = await db.test_context_insert_model_call.get<{ id: number }>({
        turn_id: turnId,
        sequence: options.sequence ?? 1,
        kind,
        capacity: JSON.stringify({
            decision: "admit",
            contextWindow: (options.capacity ?? 1000) + 1,
            maxInputTokens: null,
            maxOutputTokens: null,
            outputBudget: 1,
            reasoningBudget: null,
            inputCapacity: options.capacity ?? 1000,
            prompt: { kind: "exact", tokens: input, source: "context-gauge-fixture" },
        }),
    });
    if (kind === "emission") {
        await db.test_context_insert_attempt.run({ model_call_id: modelCall!.id });
    }
    await db.test_context_insert_request.run({ model_call_id: modelCall!.id, input });
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
            curation_budget: null,
            curation_weight: 10,
        });
        const second = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            curation_budget: null,
            curation_weight: 20,
        });
        await recordRequest(db, first!.id, 100);
        await recordRequest(db, second!.id, 250);

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.accounting.usage?.inputTokens, 350, "inputTokens sums across physical requests");
        assert.equal(usage.contextTokens, 250, "contextTokens is the LAST turn's prompt (occupancy)");
    } finally { await db.close(); }
});

test("loopUsage.contextTokens ignores later BARE calls while accounting remains cardinal", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-bare-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turn = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: 8192,
            curation_weight: 20,
        });
        await recordRequest(db, turn!.id, 250);
        await recordRequest(db, turn!.id, 1, { kind: "bare", sequence: 2 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.accounting.requests.length, 2);
        assert.equal(usage.accounting.usage?.inputTokens, 251);
        assert.equal(usage.contextTokens, 250, "the gauge describes the emission packet, not the later isolated prompt");
    } finally { await db.close(); }
});

test("loopUsage keeps latest-turn curation and physical pairs together across a model switch", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-size-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // Turn 1 ran a 49k-window model; turn 2 switched to a 200k-window model.
        const first = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: 49152,
            curation_weight: 100,
        });
        const second = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            curation_budget: 200000,
            curation_weight: 300,
        });
        await recordRequest(db, first!.id, 100, { capacity: 48_000 });
        await recordRequest(db, second!.id, 250, { capacity: 180_000 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.curationWeight, 300);
        assert.equal(usage.curationBudget, 200000);
        assert.equal(usage.contextTokens, 250);
        assert.equal(usage.contextCapacity, 180_000, "physical occupancy and capacity come from the same latest emission call");
    } finally { await db.close(); }
});

test("loopUsage.curationBudget is null when provider input capacity is unknown", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-null-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A provider with unknown input capacity leaves the curation denominator NULL.
        const turn = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: null,
            curation_weight: 10,
        });
        await recordRequest(db, turn!.id, 100);

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.curationBudget, null);
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
            curation_budget: 49152,
            curation_weight: 100,
        });
        await recordRequest(db, completed!.id, 100);
        await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 2,
            curation_budget: 200000,
            curation_weight: 200,
        });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.contextTokens, null, "an absent latest exchange remains unknown rather than fabricated zero");
        assert.equal(usage.curationWeight, 200);
        assert.equal(usage.curationBudget, 200000, "curation still describes the latest assembled request");
        assert.equal(usage.contextCapacity, null, "physical capacity does not fall back to an earlier turn");
    } finally { await db.close(); }
});

test("loopUsage binds physical usage and capacity to the same latest emission call", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-preflight-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turn = await db.test_context_insert_turn.get<{ id: number }>({
            loop_id: loopId,
            sequence: 1,
            curation_budget: 1000,
            curation_weight: 100,
        });
        await recordRequest(db, turn!.id, 80, { sequence: 1, capacity: 900 });
        const failedCapacity = JSON.stringify({
            decision: "reject",
            contextWindow: 801,
            maxInputTokens: null,
            maxOutputTokens: null,
            outputBudget: 1,
            reasoningBudget: null,
            inputCapacity: 800,
            prompt: { kind: "exact", tokens: 801, source: "context-gauge-fixture" },
        });
        const failed = await db.test_context_insert_failed_model_call.get<{ id: number }>({
            turn_id: turn!.id,
            sequence: 2,
            capacity: failedCapacity,
        });
        await db.engine_open_turn_attempt.get({ model_call_id: failed!.id });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.contextTokens, null, "a preflight rejection issued no physical request and does not borrow the prior call's usage");
        assert.equal(usage.contextCapacity, 800, "capacity comes from that same latest rejected call");
        assert.equal(usage.accounting.usage?.inputTokens, 80, "cardinal accounting still retains the earlier physical request");
    } finally { await db.close(); }
});

test("runTurn stores provider-derived curation and request-shaped physical capacity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ctx-budget-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 8192, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } }] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }] });
        const usage = await engine.loopUsage(loopId);
        const expected = 8192 - Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
        assert.equal(usage.curationBudget, expected);
        assert.equal(usage.contextCapacity, expected);
        assert.ok((usage.curationWeight ?? 0) > 0);
    } finally { await db.close(); }
});

test("providers.list advertises resolved physical input capacity", async () => {
    const { rpcCall, connect, withDaemon, makeMockResponse } = await import("./_rpc.ts");
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("## SEND0 [200]\ndone", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "gauge-345" });
            const resp = await rpcCall(ws, 2, "providers.list");
            const result = resp.result as { aliases: Array<{ active: boolean; inputCapacity: number | null }> };
            const active = result.aliases.find((a) => a.active);
            const expected = 8192 - Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
            assert.equal(active?.inputCapacity, expected);
        } finally { ws.close(); }
    });
});
