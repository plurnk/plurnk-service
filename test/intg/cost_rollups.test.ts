import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: { tokens: 0, prompt: "", turn: "", system_requirements: "" },
    assistant: { tokens: 0, content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

const insertTurnWithCost = (db: DatabaseSync, loopId: number, sequence: number, costPico: number): number => {
    const row = db
        .prepare("INSERT INTO turns (loop_id, sequence, status, packet, usage_cost_pico) VALUES (?, ?, 200, ?, ?) RETURNING id")
        .get(loopId, sequence, MIN_PACKET, costPico) as { id: number };
    return row.id;
};

const costs = (db: DatabaseSync, sessionId: number, runId: number) => ({
    run:     (db.prepare("SELECT cost_pico FROM runs     WHERE id = ?").get(runId)     as { cost_pico: number }).cost_pico,
    session: (db.prepare("SELECT cost_pico FROM sessions WHERE id = ?").get(sessionId) as { cost_pico: number }).cost_pico,
});

test("cost rollups: turn insert propagates to run AND session", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-single");
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1);
        insertTurnWithCost(db, loopId, 1, 1234);
        const c = costs(db, sessionId, runId);
        assert.equal(c.run, 1234);
        assert.equal(c.session, 1234);
    } finally { db.close(); }
});

test("cost rollups: multiple turns in same loop aggregate", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-multi");
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1);
        insertTurnWithCost(db, loopId, 1, 100);
        insertTurnWithCost(db, loopId, 2, 250);
        insertTurnWithCost(db, loopId, 3, 75);
        const c = costs(db, sessionId, runId);
        assert.equal(c.run, 425);
        assert.equal(c.session, 425);
    } finally { db.close(); }
});

test("cost rollups: turns in different loops of same run aggregate to that run + session", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-multiloop");
        const runId = insertRun(db, sessionId);
        const loopA = insertLoop(db, runId, 1);
        const loopB = insertLoop(db, runId, 2);
        insertTurnWithCost(db, loopA, 1, 100);
        insertTurnWithCost(db, loopA, 2, 200);
        insertTurnWithCost(db, loopB, 1, 300);
        const c = costs(db, sessionId, runId);
        assert.equal(c.run, 600);
        assert.equal(c.session, 600);
    } finally { db.close(); }
});

test("cost rollups: turns in different runs of same session aggregate per-run AND to session", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-multirun");
        const runA = insertRun(db, sessionId);
        const runB = insertRun(db, sessionId);
        const loopA = insertLoop(db, runA, 1);
        const loopB = insertLoop(db, runB, 1);
        insertTurnWithCost(db, loopA, 1, 500);
        insertTurnWithCost(db, loopB, 1, 700);
        const cA = costs(db, sessionId, runA);
        const cB = costs(db, sessionId, runB);
        assert.equal(cA.run, 500);
        assert.equal(cB.run, 700);
        assert.equal(cA.session, 1200, "session aggregates across all its runs");
    } finally { db.close(); }
});

test("cost rollups: forked run's turn rolls into the same session", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-fork");
        const trunkId = insertRun(db, sessionId);
        const forkId = insertRun(db, sessionId, trunkId);
        const loopT = insertLoop(db, trunkId, 1);
        const loopF = insertLoop(db, forkId, 1);
        insertTurnWithCost(db, loopT, 1, 100);
        insertTurnWithCost(db, loopF, 1, 200);
        const trunkCost = (db.prepare("SELECT cost_pico FROM runs WHERE id = ?").get(trunkId) as { cost_pico: number }).cost_pico;
        const forkCost = (db.prepare("SELECT cost_pico FROM runs WHERE id = ?").get(forkId) as { cost_pico: number }).cost_pico;
        const sessionCost = (db.prepare("SELECT cost_pico FROM sessions WHERE id = ?").get(sessionId) as { cost_pico: number }).cost_pico;
        assert.equal(trunkCost, 100);
        assert.equal(forkCost, 200);
        assert.equal(sessionCost, 300, "fork turns roll into the session too");
    } finally { db.close(); }
});

test("cost rollups: turns across different sessions are isolated", async () => {
    const db = await openMigrated();
    try {
        const sA = insertSession(db, "ws-cost-isolA");
        const sB = insertSession(db, "ws-cost-isolB");
        const rA = insertRun(db, sA);
        const rB = insertRun(db, sB);
        const lA = insertLoop(db, rA, 1);
        const lB = insertLoop(db, rB, 1);
        insertTurnWithCost(db, lA, 1, 100);
        insertTurnWithCost(db, lB, 1, 200);
        const cA = costs(db, sA, rA);
        const cB = costs(db, sB, rB);
        assert.equal(cA.session, 100);
        assert.equal(cB.session, 200);
    } finally { db.close(); }
});

test("cost rollups: UPDATE OF usage_cost_pico propagates the delta", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-update");
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1);
        const turnId = insertTurnWithCost(db, loopId, 1, 1000);
        let c = costs(db, sessionId, runId);
        assert.equal(c.run, 1000);
        db.prepare("UPDATE turns SET usage_cost_pico = ? WHERE id = ?").run(1500, turnId);
        c = costs(db, sessionId, runId);
        assert.equal(c.run, 1500, "update delta = +500");
        assert.equal(c.session, 1500);
        db.prepare("UPDATE turns SET usage_cost_pico = ? WHERE id = ?").run(800, turnId);
        c = costs(db, sessionId, runId);
        assert.equal(c.run, 800, "update delta = -700; rollup decreases");
        assert.equal(c.session, 800);
    } finally { db.close(); }
});

test("cost rollups: UPDATE with same usage_cost_pico is a no-op (WHEN guard)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-noop");
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1);
        const turnId = insertTurnWithCost(db, loopId, 1, 1000);
        db.prepare("UPDATE turns SET usage_cost_pico = 1000 WHERE id = ?").run(turnId);
        const c = costs(db, sessionId, runId);
        assert.equal(c.run, 1000);
        assert.equal(c.session, 1000);
    } finally { db.close(); }
});

test("cost rollups: zero-cost turn is a no-op for rollup", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-zero");
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1);
        insertTurnWithCost(db, loopId, 1, 0);
        const c = costs(db, sessionId, runId);
        assert.equal(c.run, 0);
        assert.equal(c.session, 0);
    } finally { db.close(); }
});

test("cost rollups: large cost values don't overflow (INTEGER pico-units)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-cost-large");
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1);
        const oneUsdInPico = 1_000_000_000_000; // 10^12
        insertTurnWithCost(db, loopId, 1, oneUsdInPico);
        insertTurnWithCost(db, loopId, 2, oneUsdInPico * 2);
        const c = costs(db, sessionId, runId);
        assert.equal(c.run, oneUsdInPico * 3);
        assert.equal(c.session, oneUsdInPico * 3);
    } finally { db.close(); }
});
