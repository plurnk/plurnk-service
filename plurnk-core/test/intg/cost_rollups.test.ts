import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    sections: [],
    telemetryErrors: [],
    assistant: {
        content: "", ops: [], reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
        finishReason: null, model: "mock",
    },
    assistantRaw: null,
});

const insertTurnWithCost = async (db: Db, loopId: number, sequence: number, costPico: number): Promise<number> => {
    const row = await (db.test_cost_insert_turn as PrepMethod).get<{ id: number }>({
        loop_id: loopId, sequence, packet: MIN_PACKET, cost_pico: costPico,
    });
    if (row === undefined) throw new Error("turn insert returned no row");
    return row.id;
};

const costs = async (db: Db, workspaceId: number, workerId: number) => ({
    run: (await (db.test_cost_run as PrepMethod).get<{ cost_pico: number }>({ id: workerId }))?.cost_pico ?? 0,
    workspace: (await (db.test_cost_session as PrepMethod).get<{ cost_pico: number }>({ id: workspaceId }))?.cost_pico ?? 0,
});

test("[§provider-surface-costfor] cost rollups: turn insert propagates to run AND workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-single");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await insertTurnWithCost(db, loopId, 1, 1234);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.run, 1234);
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
        assert.equal(c.run, 425);
        assert.equal(c.workspace, 425);
    } finally { await db.close(); }
});

test("cost rollups: turns in different loops of same run aggregate", async () => {
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
        assert.equal(c.run, 600);
        assert.equal(c.workspace, 600);
    } finally { await db.close(); }
});

test("cost rollups: turns in different runs of same workspace aggregate", async () => {
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
        assert.equal(cA.run, 500);
        assert.equal(cB.run, 700);
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
        const trunkCost = (await (db.test_cost_run as PrepMethod).get<{ cost_pico: number }>({ id: trunkId }))?.cost_pico;
        const forkCost = (await (db.test_cost_run as PrepMethod).get<{ cost_pico: number }>({ id: forkId }))?.cost_pico;
        const workspaceCost = (await (db.test_cost_session as PrepMethod).get<{ cost_pico: number }>({ id: workspaceId }))?.cost_pico;
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

test("cost rollups: UPDATE OF usage_cost_pico propagates the delta", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-update");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurnWithCost(db, loopId, 1, 1000);
        let c = await costs(db, workspaceId, workerId);
        assert.equal(c.run, 1000);
        await (db.test_cost_update_turn as PrepMethod).run({ cost_pico: 1500, id: turnId });
        c = await costs(db, workspaceId, workerId);
        assert.equal(c.run, 1500);
        assert.equal(c.workspace, 1500);
        await (db.test_cost_update_turn as PrepMethod).run({ cost_pico: 800, id: turnId });
        c = await costs(db, workspaceId, workerId);
        assert.equal(c.run, 800);
        assert.equal(c.workspace, 800);
    } finally { await db.close(); }
});

test("cost rollups: UPDATE with same usage_cost_pico is a no-op", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-noop");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurnWithCost(db, loopId, 1, 1000);
        await (db.test_cost_update_turn as PrepMethod).run({ cost_pico: 1000, id: turnId });
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.run, 1000);
        assert.equal(c.workspace, 1000);
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
        assert.equal(c.run, 0);
        assert.equal(c.workspace, 0);
    } finally { await db.close(); }
});

test("cost rollups: large cost values don't overflow", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cost-large");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const oneUsdInPico = 1_000_000_000_000;
        await insertTurnWithCost(db, loopId, 1, oneUsdInPico);
        await insertTurnWithCost(db, loopId, 2, oneUsdInPico * 2);
        const c = await costs(db, workspaceId, workerId);
        assert.equal(c.run, oneUsdInPico * 3);
        assert.equal(c.workspace, oneUsdInPico * 3);
    } finally { await db.close(); }
});
