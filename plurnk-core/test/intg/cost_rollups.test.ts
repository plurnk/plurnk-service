import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock, type ProviderAccountingResult, type ProviderAccountingScope } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    sections: [],
    attributions: [],
    assistant: {
        content: "", ops: [], reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
        finishReason: null, model: "mock",
    },
    assistantRaw: null,
});

const insertTurn = async (db: Db, loopId: number, sequence: number): Promise<number> => {
    const row = await db.test_cost_insert_turn.get<{ id: number }>({
        loop_id: loopId, sequence, packet: MIN_PACKET,
    });
    if (row === undefined) throw new Error("turn insert returned no row");
    return row.id;
};

const recordAttemptWithCost = async (
    db: Db,
    turnId: number,
    sequence: number,
    costUsd: number | null,
    accepted = true,
): Promise<void> => {
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        turn_id: turnId,
        sequence,
        attributions: "[]",
        model: "mock",
    });
    if (attempt === undefined) throw new Error("provider attempt did not open");
    const cost = costUsd === null
        ? { kind: "unknown" as const, reason: "fixture has no settled charge" }
        : costUsd === 0
            ? { kind: "free" as const, source: "cost rollup fixture" }
            : {
                kind: "authoritative" as const,
                amount: { amount: String(costUsd), currency: "USD" },
                usdEquivalent: String(costUsd),
                source: "cost rollup fixture",
            };
    await db.engine_observe_turn_attempt_response.run({
        id: attempt.id,
        response: JSON.stringify({ assistant: { model: "mock" } }),
        usage_prompt: 0,
        usage_completion: 0,
        usage_reasoning: 0,
        usage_cached: 0,
        usage_cost: JSON.stringify({ kind: "unknown", reason: "awaiting classification" }),
        finish_reason: "stop",
        model: "mock",
    });
    await db.engine_classify_turn_attempt_response.run({
        id: attempt.id,
        accepted: accepted ? 1 : 0,
        parse_errors: "[]",
        failure: null,
        usage_cost: JSON.stringify(cost),
        usage_cost_usd: costUsd,
    });
};

const insertTurnWithCost = async (db: Db, loopId: number, sequence: number, costUsd: number | null): Promise<number> => {
    const turnId = await insertTurn(db, loopId, sequence);
    await recordAttemptWithCost(db, turnId, 1, costUsd);
    return turnId;
};

const costs = async (db: Db, workspaceId: number, workerId: number) => ({
    worker: (await db.test_cost_worker.get<{ cost_usd: number | null }>({ id: workerId }))?.cost_usd,
    workspace: (await db.test_cost_workspace.get<{ cost_usd: number | null }>({ id: workspaceId }))?.cost_usd,
});

class ScopedAccountingMock extends Mock {
    readonly scopes: ProviderAccountingScope[] = [];
    #result: ProviderAccountingResult;

    constructor(result: ProviderAccountingResult) {
        super({ contextWindow: 100_000, responses: [] });
        this.#result = result;
    }

    async reconcileAccounting(scope: ProviderAccountingScope): Promise<ProviderAccountingResult> {
        this.scopes.push(scope);
        return this.#result;
    }
}

test("cost rollups: turn insert propagates to worker and workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-single");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await insertTurnWithCost(db, loopId, 1, 1234);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.worker, 1234);
        assert.equal(c.workspace, 1234);
    } finally { await db.close(); }
});

test("cost rollups: multiple turns in same loop aggregate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-multi");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await insertTurnWithCost(db, loopId, 1, 100);
        await insertTurnWithCost(db, loopId, 2, 250);
        await insertTurnWithCost(db, loopId, 3, 75);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.worker, 425);
        assert.equal(c.workspace, 425);
    } finally { await db.close(); }
});

test("cost rollups: turns in different loops of the same worker aggregate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-multiloop");
        const workerId = await insertWorker(db, workspaceId);
        const loopA = await insertLoop(db, workerId, 1);
        const loopB = await insertLoop(db, workerId, 2);
        await insertTurnWithCost(db, loopA, 1, 100);
        await insertTurnWithCost(db, loopA, 2, 200);
        await insertTurnWithCost(db, loopB, 1, 300);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.worker, 600);
        assert.equal(c.workspace, 600);
    } finally { await db.close(); }
});

test("cost rollups: turns in different workers of the same workspace aggregate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-multirun");
        const workerA = await insertWorker(db, workspaceId);
        const workerB = await insertWorker(db, workspaceId);
        const loopA = await insertLoop(db, workerA, 1);
        const loopB = await insertLoop(db, workerB, 1);
        await insertTurnWithCost(db, loopA, 1, 500);
        await insertTurnWithCost(db, loopB, 1, 700);
        const cA = await costs(db, workspaceId, workerA);
        const cB = await costs(db, workspaceId, workerB);
        assert.equal(cA.worker, 500);
        assert.equal(cB.worker, 700);
        assert.equal(cA.workspace, 1200);
    } finally { await db.close(); }
});

test("cost rollups: forked worker's turn rolls into the same workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-fork");
        const trunkId = await insertWorker(db, workspaceId);
        const forkId = await insertWorker(db, workspaceId, trunkId);
        const loopT = await insertLoop(db, trunkId, 1);
        const loopF = await insertLoop(db, forkId, 1);
        await insertTurnWithCost(db, loopT, 1, 100);
        await insertTurnWithCost(db, loopF, 1, 200);
        const trunkCost = (await db.test_cost_worker.get<{ cost_usd: number }>({ id: trunkId }))?.cost_usd;
        const forkCost = (await db.test_cost_worker.get<{ cost_usd: number }>({ id: forkId }))?.cost_usd;
        const workspaceCost = (await db.test_cost_workspace.get<{ cost_usd: number }>({ id: workspaceId }))?.cost_usd;
        assert.equal(trunkCost, 100);
        assert.equal(forkCost, 200);
        assert.equal(workspaceCost, 300);
    } finally { await db.close(); }
});

test("cost rollups: turns across different workspaces are isolated", async () => {
    const db = await openMigrated();
    try {
        const sA = await insertWorkspace(db, "ws-cost-isolA");
        const sB = await insertWorkspace(db, "ws-cost-isolB");
        const rA = await insertWorker(db, sA);
        const rB = await insertWorker(db, sB);
        const lA = await insertLoop(db, rA, 1);
        const lB = await insertLoop(db, rB, 1);
        await insertTurnWithCost(db, lA, 1, 100);
        await insertTurnWithCost(db, lB, 1, 200);
        const cA = await costs(db, sA, rA);
        const cB = await costs(db, sB, rB);
        assert.equal(cA.workspace, 100);
        assert.equal(cB.workspace, 200);
    } finally { await db.close(); }
});

test("cost rollups: an open call is unknown until its attempt classification settles", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-update");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
            turn_id: turnId,
            sequence: 1,
            attributions: "[]",
            model: "mock",
        });
        assert.ok(attempt !== undefined);
        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: null, workspace: null });
        await db.engine_observe_turn_attempt_response.run({
            id: attempt.id,
            response: JSON.stringify({ assistant: { model: "mock" } }),
            usage_prompt: 10,
            usage_completion: 5,
            usage_reasoning: 0,
            usage_cached: 0,
            usage_cost: JSON.stringify({ kind: "unknown", reason: "awaiting classification" }),
            finish_reason: "stop",
            model: "mock",
        });
        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: null, workspace: null });
        await db.engine_classify_turn_attempt_response.run({
            id: attempt.id,
            accepted: 1,
            parse_errors: "[]",
            failure: null,
            usage_cost: JSON.stringify({
                kind: "authoritative",
                amount: { amount: "1500", currency: "USD" },
                usdEquivalent: "1500",
                source: "cost rollup fixture",
            }),
            usage_cost_usd: 1500,
        });
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.worker, 1500);
        assert.equal(c.workspace, 1500);
    } finally { await db.close(); }
});

test("cost rollups: multiple attempts in one turn aggregate from attempt evidence", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-noop");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await recordAttemptWithCost(db, turnId, 1, 1000, false);
        await recordAttemptWithCost(db, turnId, 2, 500);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.worker, 1500);
        assert.equal(c.workspace, 1500);
    } finally { await db.close(); }
});

test("cost rollups: unknown attempt evidence dominates later settled attempts", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-unknown");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await insertTurnWithCost(db, loopId, 1, 25);
        await insertTurnWithCost(db, loopId, 2, null);
        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: null, workspace: null });
        await insertTurnWithCost(db, loopId, 3, 75);
        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: null, workspace: null });
    } finally { await db.close(); }
});

test("cost rollups: zero-cost turn is a no-op for rollup", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-zero");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await insertTurnWithCost(db, loopId, 1, 0);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.worker, 0);
        assert.equal(c.workspace, 0);
    } finally { await db.close(); }
});

test("cost rollups: ordinary USD values retain fractional precision", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-large");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await insertTurnWithCost(db, loopId, 1, 1.25);
        await insertTurnWithCost(db, loopId, 2, 2.5);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.worker, 3.75);
        assert.equal(c.workspace, 3.75);
    } finally { await db.close(); }
});

test("cost rollups: a settled provider scope supersedes rather than adds to its turn sum", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-scoped");
        const workerId = await insertWorker(db, workspaceId);
        const scopedLoopId = await insertLoop(db, workerId, 1);
        const ordinaryLoopId = await insertLoop(db, workerId, 2);
        await insertTurnWithCost(db, scopedLoopId, 1, 100);
        await insertTurnWithCost(db, scopedLoopId, 2, 200);
        await insertTurnWithCost(db, ordinaryLoopId, 1, 50);
        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: 350, workspace: 350 });

        const charge = {
            kind: "authoritative" as const,
            amount: { amount: "7.25", currency: "USD" },
            usdEquivalent: "7.25",
            source: "scoped accounting fixture",
        };
        const provider = new ScopedAccountingMock({
            status: "settled",
            charge,
            evaluatedAt: "2026-08-08T12:00:00.000Z",
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const scopeId = await engine.beginLoopAccounting(scopedLoopId, provider);
        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: null, workspace: null });
        await db.test_set_loop_status.run({
            id: scopedLoopId,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        await engine.reconcileLoopAccounting(scopedLoopId, provider);

        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: 57.25, workspace: 57.25 });
        const usage = await engine.loopUsage(scopedLoopId);
        assert.equal(usage.costUsd, 7.25);
        assert.deepEqual(usage.accounting, {
            scopeId,
            status: "settled",
            charge,
            evaluatedAt: "2026-08-08T12:00:00.000Z",
        });
        assert.equal(provider.scopes.length, 1);
        assert.equal(provider.scopes[0]!.id, scopeId);
    } finally { await db.close(); }
});

test("cost rollups: reconciliation counts every durable provider call identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-open-call");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        const provider = new ScopedAccountingMock({
            status: "pending",
            reason: "provider ledger has not settled",
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.beginLoopAccounting(loopId, provider);
        await db.engine_open_turn_attempt.get({
            turn_id: turnId,
            sequence: 1,
            attributions: "[]",
            model: provider.model,
        });
        await db.test_set_loop_status.run({
            id: loopId,
            status: 500,
            terminal_result: JSON.stringify({ status: 500 }),
        });

        await engine.reconcileLoopAccounting(loopId, provider);

        assert.equal(provider.scopes.length, 1);
        assert.equal(provider.scopes[0]!.attempts, 1,
            "an open pre-I/O row is possible issued-call evidence, never a free scope");
    } finally { await db.close(); }
});

test("cost rollups: pending scoped accounting remains explicitly unknown", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-scope-pending");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await insertTurnWithCost(db, loopId, 1, 100);
        const provider = new ScopedAccountingMock({
            status: "pending",
            reason: "provider ledger has not settled",
            evaluatedAt: "2026-08-08T12:00:00.000Z",
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const scopeId = await engine.beginLoopAccounting(loopId, provider);
        await db.test_set_loop_status.run({
            id: loopId,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        await engine.reconcileLoopAccounting(loopId, provider);

        assert.deepEqual(await costs(db, workspaceId, workerId), { worker: null, workspace: null });
        const usage = await engine.loopUsage(loopId);
        assert.equal(usage.costUsd, null);
        assert.deepEqual(usage.accounting, {
            scopeId,
            status: "pending",
            reason: "provider ledger has not settled",
            evaluatedAt: "2026-08-08T12:00:00.000Z",
        });
    } finally { await db.close(); }
});
