// SPEC §grinder — the budget grinder. The model "behaves" here (a clean SEND each
// turn); these tests exercise the engine's enforcement, not the model. An
// absolute ceiling far below any real packet forces overflow deterministically.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement, SendStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, seedEntryWithChannel } from "./_helpers.ts";

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null }, position: { line: 1, column: 1 },
});
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([sendStmt(200, "ok")]));

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const TINY = 2;          // absolute wall far below any real packet → forces overflow
const WIDE = 1_000_000;  // absolute wall capped to the window → never overflows

// Construct an engine pinned to an absolute budget ceiling (>1 = absolute).
// Set → construct (reads env) → delete is synchronous, so no cross-test race.
const engineAt = (db: Db, ceiling: number): Engine => {
    process.env.PLURNK_BUDGET_CEILING = String(ceiling);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    delete process.env.PLURNK_BUDGET_CEILING;
    return engine;
};

const envelope = async (db: Db): Promise<{ sessionId: number; runId: number; loopId: number }> => {
    const sessionId = await insertSession(db, `ge-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "go");
    return { sessionId, runId, loopId };
};

test("[§grinder-overflow-only] under the ceiling the grinder never fires — nothing is hidden", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: 4096, responses: okSends(2) });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        // Under the ceiling the grinder early-returns before pass 1, so turn 1's
        // log stays shown — it would be hidden only on overflow.
        const log = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number }>({ run_id: runId });
        assert.ok(log.some((r) => r.turn_seq === 1), "no overflow → prior turn's log still shown, grinder inert");
    } finally { await db.close(); }
});

test("[§grinder-layer1-rollback] on overflow the prior turn's log entries are folded to their coordinate", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        // Turn 1 runs under a WIDE ceiling so the model completes and leaves an
        // open SEND (the foisted prompt is now folded by default — §prompt-fold);
        // turn 2 runs under TINY so its accumulated packet overflows and the
        // grinder folds turn 1's open log.
        const wide = engineAt(db, WIDE);
        const tiny = engineAt(db, TINY);
        const provider = new Mock({ contextSize: 4096, responses: okSends(3) });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ run_id: runId });
        assert.ok(before.some((r) => r.turn_seq === 1 && r.expanded === 1), "turn 1 left an open (expanded=1) log entry");
        await tiny.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const after = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number }>({ run_id: runId });
        const t1 = after.filter((r) => r.turn_seq === 1);
        assert.ok(t1.length > 0 && t1.every((r) => r.expanded === 0), "prior turn's logs folded — still listed, collapsed to coordinate (expanded=0), not deleted");
    } finally { await db.close(); }
});

test("[§grinder-hard-413-abort] when even the manifest won't fit, the loop abandons at 499 (budget_overflow)", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const result = await engine.runLoop({ provider: new Mock({ contextSize: 4096, responses: okSends(3) }), sessionId, runId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 499, "hard-stop abandons the loop");
        assert.equal(result.reason, "budget_overflow", "abandonment reason is the budget, not a strike or max-turns");
    } finally { await db.close(); }
});

test("[§grinder-strike-coupling] a grinder fire past the first turn counts toward the strike streak", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const t2 = await engine.runTurn({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t2.budgetStruck, true, "overflow on turn 2 strikes (model over-subscribed)");
    } finally { await db.close(); }
});

test("[§grinder-soft-turn-0-1] the first turn's overflow is soft — no strike (the environment, not the model)", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const t1 = await engine.runTurn({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t1.budgetStruck, false, "turn-1 overflow does not strike");
        assert.equal(t1.budgetHardStop, true, "but it still hard-stops (env wall too low)");
    } finally { await db.close(); }
});

test("[§grinder-event-model-terms] the overflow event names hidden entries by scheme, no mechanism vocabulary", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const tiny = engineAt(db, TINY);
        const provider = new Mock({ contextSize: 4096, responses: okSends(4) });
        // Turn 1 runs under WIDE so the model leaves an open SEND (the foisted
        // prompt is folded by default — §prompt-fold); turn 2 overflows under TINY
        // and the prior-turn rollback folds that SEND (pass 1), emitting
        // budget_overflow into the buffer; turn 3 drains the event into its packet.
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        await tiny.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const t3 = await tiny.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 3 });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t3.turnId });
        const packet = JSON.parse(row!.packet) as { user: { telemetry: { errors: Array<Record<string, unknown>> } } };
        const evt = packet.user.telemetry.errors.find((e) => e.kind === "budget_overflow");
        assert.ok(evt, "budget_overflow event surfaced to the model");
        assert.ok(Array.isArray(evt!.folded), "carries folded-by-scheme facts");
        assert.equal(evt!.layer, undefined, "no mechanism vocabulary — no 'layer'");
    } finally { await db.close(); }
});
