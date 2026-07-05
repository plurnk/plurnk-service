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
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, seedEntryWithChannel } from "./_helpers.ts";

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

// Construct an engine pinned to an exact prompt budget: CTX = the pin, zero reserves —
// promptBudget IS the pin (§tokenomics-window-partition; the settable ceiling is retired).
// Set → construct (reads env) → restore is synchronous, so no cross-test race.
const engineAt = (db: Db, ceiling: number): Engine => {
    const prev = ["CTX", "REASONING", "ASSISTANT", "SAFETY"].map((k) => process.env[`PLURNK_SERVICE_${k}`]);
    process.env.PLURNK_SERVICE_CTX = String(ceiling);
    process.env.PLURNK_SERVICE_REASONING = "0";
    process.env.PLURNK_SERVICE_ASSISTANT = "0";
    process.env.PLURNK_SERVICE_SAFETY = "0";
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    ["CTX", "REASONING", "ASSISTANT", "SAFETY"].forEach((k, i) => {
        if (prev[i] === undefined) delete process.env[`PLURNK_SERVICE_${k}`]; else process.env[`PLURNK_SERVICE_${k}`] = prev[i];
    });
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

test("[§grinder-hard-413-abort] when even the manifest won't fit, the loop abandons at 413 (budget_overflow)", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const result = await engine.runLoop({ provider: new Mock({ contextSize: 4096, responses: okSends(3) }), sessionId, runId, loopId, messages: MESSAGES, maxTurns: 5 });
        assert.equal(result.finalStatus, 413, "hard-stop abandons the loop at 413 Content Too Large");
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

test("[§grinder-compaction-strikes] turn-1 overflow folds the turn's own foists and STRIKES — no soft exemption", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const t1 = await engine.runTurn({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t1.budgetStruck, true, "every compaction strikes — turn 0/1 is NOT exempt (#4): a fold happened, so it counts");
        assert.equal(t1.budgetHardStop, true, "the TINY env wall is below even the folded scaffolding, so it still hard-stops");
    } finally { await db.close(); }
});

test("[§grinder-overflow-error-row] overflow is a terse op='error' log row (413) surfaced THIS turn as a LogCoordinate — not a by-scheme JSON event", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const tiny = engineAt(db, TINY);
        const provider = new Mock({ contextSize: 4096, responses: okSends(4) });
        // Turn 1 under WIDE leaves an open SEND (the foisted prompt is folded by default — §prompt-fold);
        // turn 2 overflows under TINY → the grinder folds that SEND AND mints a terse 'Budget Overflow'
        // op='error' row, re-derived into turn 2's OWN packet (same-turn, not a turn late).
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const t2 = await tiny.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row!.packet) as { telemetryErrors: Array<Record<string, unknown>> };
        const evt = packet.telemetryErrors.find((e) => (e.position as { type?: string } | undefined)?.type === "log-coordinate" && e.status === 413);
        assert.ok(evt, "the overflow surfaced THIS turn as a 413 LogCoordinate pointer");
        assert.equal(evt!.folded, undefined, "no by-scheme 'folded' JSON — terseness");
        assert.equal(evt!.layer, undefined, "no mechanism vocabulary — no 'layer'");
    } finally { await db.close(); }
});

test("[§grinder-layer1-rollback] stage 2: a huge ENGINE-WRITTEN row on the current turn is folded — never a needless 413 (#332)", async () => {
    // The run14 shape: the prior turn is tiny, and the overflow lives in THIS turn's pre-model
    // rows (a wake turn's auto-surfaced stream conclusion — 68KB of search results). Stage 1
    // (fold the prior turn) cannot reclaim enough; stage 2 folds the current turn's own
    // engine-written rows and the packet fits — the loop survives to read the folded row.
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        // Turn 1 — small, real (leaves a tiny open log).
        const wide = engineAt(db, WIDE);
        await wide.runTurn({ provider: new Mock({ contextSize: 4096, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        // Turn 2 — opened manually; a HUGE OPEN engine-origin row lands on it pre-model (the wake surface).
        const turnId = await insertTurn(db, loopId, 2, 102);
        await (db.engine_insert_log_entry as PrepMethod).get({
            run_id: runId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "plurnk", source: null, op: "READ", suffix: "", signal: null,
            scheme: "search", username: null, password: null, hostname: null, port: null,
            pathname: "/1/1/7", params: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({ status: 200, content: "R".repeat(8000) }), mimetype_rx: "application/json",
            status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        const { default: PacketBuilder } = await import("../../src/core/PacketBuilder.ts");
        const { default: TelemetryChannel } = await import("../../src/core/TelemetryChannel.ts");
        const telemetry = new TelemetryChannel({ db });
        const provider = new Mock({ contextSize: 1_000_000, responses: [] });
        const buildAt = (ctx: number): InstanceType<typeof PacketBuilder> => {
            const prev = ["CTX", "REASONING", "ASSISTANT", "SAFETY"].map((k) => process.env[`PLURNK_SERVICE_${k}`]);
            process.env.PLURNK_SERVICE_CTX = String(ctx);
            process.env.PLURNK_SERVICE_REASONING = "0"; process.env.PLURNK_SERVICE_ASSISTANT = "0"; process.env.PLURNK_SERVICE_SAFETY = "0";
            const b = new PacketBuilder({ db, schemes: new SchemeRegistry(), telemetry, executors: () => undefined });
            ["CTX", "REASONING", "ASSISTANT", "SAFETY"].forEach((k, i) => { if (prev[i] === undefined) delete process.env[`PLURNK_SERVICE_${k}`]; else process.env[`PLURNK_SERVICE_${k}`] = prev[i]; });
            return b;
        };
        const args = { initialMessages: MESSAGES, requirements: "", sessionId, runId, loopId, currentTurnSeq: 2, provider, gitStatus: null };
        const open = await buildAt(WIDE).buildRequestPacket(args);
        // Pin the ceiling just under the open packet: stage 1 (tiny prior turn) can't save it;
        // stage 2 (the 8KB current-turn row) must.
        const builder = buildAt(open.tokens - 50);
        const packet = await builder.buildRequestPacket(args);
        const result = await builder.enforceBudget({
            packet, provider, runId, loopId, turnId, mintSequence: 99,
            rebuild: () => builder.buildRequestPacket(args),
        });
        assert.equal(result.struck, true, "the compaction struck (one strike for the fire)");
        assert.equal(result.fit, true, "stage 2 folded the current turn's engine row — the packet fits, no 413");
        const rows = await (db.engine_render_log as PrepMethod).all<{ turn_seq: number; op: string; expanded: number }>({ run_id: runId });
        const bigRow = rows.find((r) => r.turn_seq === 2 && r.op === "READ");
        assert.ok(bigRow !== undefined, "the wake row is still LISTED (folded, not deleted)");
        assert.equal(bigRow.expanded, 0, "the wake row is FOLDED (re-OPENable) — and not fatal");
    } finally { await db.close(); }
});
