// Budget stories — the grinder under real pressure, ported from rummy's proven
// budget suite (test/integration/budget_{math,cascade,preflight_uses_actual_packet,
// hard_413_shortcircuits_dispatch}.test.js) and ADAPTED to plurnk's architecture,
// not transplanted. The key divergence learned while porting:
//
//   * Entries are FREE. An EDIT's body lands in the catalog entry, which does not
//     render — so a "fat entry" adds nothing to the packet. rummy fattens context
//     with big entries; plurnk can't. The only thing that renders (and so the only
//     budget pressure) is the LOG: a READ result renders the content it pulled.
//   * The grinder runs PRE-LLM. A turn's stored request packet is what was sent
//     BEFORE the model spoke — it never contains that turn's own emission. The fat
//     log a turn produces only weighs on the NEXT turn's packet.
//   * The lever is the immediately-prior turn only (engine_grinder_prior_turn_logs:
//     MAX(turn) < current) — NOT rummy's progressive layered archive.
//
// Machinery anchors (overflow-only, layer1-rollback, hard-413-abort, strike-coupling,
// soft-turn-1, event-model-terms) live in Engine.budget-enforce. These are the
// BEHAVIORAL stories rummy proved that plurnk hadn't: the grinder gates on the
// CURRENT packet, folding RECLAIMS room and the turn still delivers ≤100%, and a
// hard-413 never reaches the model.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, packetSection } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, sendStmt } from "./_dsl.ts";

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const WINDOW = 100_000; // the model's window — wide enough to hold a fat read OPEN, so WIDE isn't capped below it (computeCeiling gates on the narrowest of ceiling/window)
const WIDE = 1_000_000; // absolute wall capped to the window → never overflows
const TINY = 2;         // absolute wall far below any packet → un-foldable overflow
const FAT = 4000;       // chars of read-back body — renders into the log, the only lever

const heavy = (chars: number): string => "x".repeat(chars);
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([sendStmt(200, null, "ok")]));
// A turn that writes a fat entry then READS it back (the read RESULT renders into
// the log — that is the budget pressure) then closes. The EDIT body is free; the
// READ render is not. Repeated n times for multi-turn accumulation.
const fatReads = (chars: number, n = 1): MockResponse[] =>
    Array.from({ length: n }, () => response([editStmt(urlPath("known", "big"), heavy(chars)), readStmt(urlPath("known", "big")), sendStmt(200, null, "ok")]));

const engineAt = (db: Db, ceiling: number): Engine => {
    process.env.PLURNK_BUDGET_CEILING = String(ceiling);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    delete process.env.PLURNK_BUDGET_CEILING;
    return engine;
};
const envelope = async (db: Db): Promise<{ sessionId: number; runId: number; loopId: number }> => {
    const sessionId = await insertSession(db, `bs-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "go");
    return { sessionId, runId, loopId };
};
const packetOf = async (db: Db, turnId: number): Promise<{ tokens: number; assistant: { ops: unknown[] }; telemetryErrors: Array<Record<string, unknown>>; packet: object }> => {
    const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row!.packet) as { tokens: number; assistant: { ops: unknown[] }; telemetryErrors: Array<Record<string, unknown>> };
    return { ...packet, packet };
};
const budgetHeadline = (packet: object): { ceiling: number; usage: number; percent: number; free: number } => {
    const budget = packetSection(packet, "budget");
    const m = budget.match(/Token Ceiling (\d+) · Token Usage (\d+) \((\d+)%\) · Tokens Free (\d+)/);
    assert.ok(m, `budget headline present; got: ${budget}`);
    return { ceiling: Number(m![1]), usage: Number(m![2]), percent: Number(m![3]), free: Number(m![4]) };
};
const logRows = async (db: Db, runId: number): Promise<Array<{ turn_seq: number; expanded: number; tokens: number }>> =>
    (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number; tokens: number }>({ run_id: runId });

// Two reference measurements on throwaway runs (deterministic FAT body), so the
// fold-to-fit ceilings track the real assembly and never magic numbers:
//   floor    = bare scaffolding (turn 1's pre-emission packet, no prior log)
//   expanded = floor + a fat READ log from the prior turn, all expanded
const measure = async (db: Db): Promise<{ floor: number; expanded: number }> => {
    const { sessionId, runId, loopId } = await envelope(db);
    const wide = engineAt(db, WIDE);
    const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
    const t1 = await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
    const t2 = await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
    return { floor: (await packetOf(db, t1.turnId)).tokens, expanded: (await packetOf(db, t2.turnId)).tokens };
};

// 0 — the fattener actually fattens. If this fails every fold-to-fit story below is
// vacuous, so it is pinned first (caught the EDIT-is-free trap during the port).
test("budget: a READ result renders into the log and weighs on the next turn's packet", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        assert.ok(expanded > floor + 200, `a fat READ log must add real weight (floor ${floor}, with-fat ${expanded})`);
    } finally { await db.close(); }
});

// 1 — cascade ok: comfortably under budget the grinder is inert, delivered ≤100%.
test("budget: under the ceiling the turn delivers and the budget reads at or below 100%", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, WIDE);
        const t = await engine.runTurn({ provider: new Mock({ contextSize: WINDOW, responses: fatReads(FAT) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t.status, 200, "delivered");
        assert.equal(t.budgetHardStop, false, "no hard-stop under a wide ceiling");
        const { percent } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(percent <= 100, `delivered packet reads ≤100% (got ${percent}%)`);
    } finally { await db.close(); }
});

// 2 — the grinder gates on the CURRENT assembled packet (rummy
// budget_preflight_uses_actual_packet "stale baseline" regression): a fat prior-turn
// READ log triggers the fold on the next turn — plurnk measures packet.tokens.
test("budget: overflow is judged on the current assembled packet, not a prior-turn baseline", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 }); // fat READ log, expanded
        // Ceiling sits ABOVE the floor but BELOW floor+fat: the only thing over the
        // wall is the fat prior-turn log, which the grinder must measure NOW and fold.
        const tight = engineAt(db, Math.floor((floor + expanded) / 2));
        await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const t1Log = (await logRows(db, runId)).filter((r) => r.turn_seq === 1);
        assert.ok(t1Log.length > 0 && t1Log.every((r) => r.expanded === 0), "the fat prior-turn log was folded — overflow judged on the current packet");
    } finally { await db.close(); }
});

// 3 — fold RECLAIMS budget and the turn still DELIVERS (the owner's core invariant:
// "impossible to go over budget if you started under and fold all of your previous
// turn's log items"). Overflow → fold prior turn → fits → 200, not 413.
test("budget: folding the prior turn reclaims room and the turn delivers (200, not 413)", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tight = engineAt(db, Math.floor((floor + expanded) / 2));
        const t2 = await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t2.status, 200, "the turn delivers after the grinder folds prior-turn logs to fit");
        assert.equal(t2.budgetHardStop, false, "fold-to-fit, not a hard-413");
        assert.equal(t2.budgetStruck, true, "a grinder fire past turn 1 still strikes (§grinder-strike-coupling)");
    } finally { await db.close(); }
});

// 4 — a DELIVERED packet is always ≤100% (owner: "the packet literally can't be over
// 100%"). The fold-to-fit turn's own readout never exceeds the ceiling.
test("budget: a delivered packet after fold-to-fit reads at or below 100%", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tight = engineAt(db, Math.floor((floor + expanded) / 2));
        const t2 = await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const { percent, free } = budgetHeadline((await packetOf(db, t2.turnId)).packet);
        assert.ok(percent <= 100, `delivered fold-to-fit packet reads ≤100% (got ${percent}%)`);
        assert.ok(free >= 0, "free never goes negative on a delivered packet");
    } finally { await db.close(); }
});

// 5 — folding drops the measured packet (rummy budget_math: a folded entry costs
// less than its expanded body). The post-fold delivered packet is lighter than the
// expanded reference.
test("budget: folding a fat log strictly reduces the measured packet", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tight = engineAt(db, Math.floor((floor + expanded) / 2));
        const t2 = await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const delivered = (await packetOf(db, t2.turnId)).tokens;
        assert.ok(delivered < expanded, `delivered post-fold packet (${delivered}) lighter than the expanded reference (${expanded})`);
    } finally { await db.close(); }
});

// 6 — a hard-413 never reaches the model (rummy budget_hard_413 "short-circuits
// dispatch"). The stored turn carries an EMPTY assistant — generate() was skipped.
test("budget: an un-foldable hard-413 short-circuits dispatch — the model is never called", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const t = await engine.runTurn({ provider: new Mock({ contextSize: WINDOW, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413, "un-foldable → hard-413");
        assert.equal(t.budgetHardStop, true, "the hard-stop fired before generate()");
        const packet = await packetOf(db, t.turnId);
        assert.equal(packet.assistant.ops.length, 0, "stored assistant is empty — the model never spoke (dispatch short-circuited)");
    } finally { await db.close(); }
});

// 7 — fold is render-only: stored log_entries.tokens (full body cost) is unchanged
// by a fold (rummy budget_math "tokens always reflect full body cost").
test("budget: folding changes the render, not the stored token cost of the entry", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = (await logRows(db, runId)).filter((r) => r.turn_seq === 1).reduce((s, r) => s + r.tokens, 0);
        const tight = engineAt(db, Math.floor((floor + expanded) / 2));
        await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const t1After = (await logRows(db, runId)).filter((r) => r.turn_seq === 1);
        assert.ok(t1After.every((r) => r.expanded === 0), "turn 1 folded");
        assert.equal(t1After.reduce((s, r) => s + r.tokens, 0), before, "stored tokens unchanged across the fold — only the render collapsed");
    } finally { await db.close(); }
});

// 8 — the lever is the IMMEDIATELY-prior turn, not progressive shedding. plurnk folds
// MAX(turn < current) only — it does NOT walk back through history like rummy's
// layered archive. Turn 2 folds turn 1, turn 3 folds turn 2, and turn 1 — already
// folded — stays folded, untouched.
test("budget: the grinder folds the immediately-prior turn each time, never older folded turns", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT, 3), ...okSends(2)] });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tight = engineAt(db, Math.floor((floor + expanded) / 2));
        await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.ok((await logRows(db, runId)).filter((r) => r.turn_seq === 1).every((r) => r.expanded === 0), "turn 2 folded turn 1");
        await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 3 });
        const afterT3 = await logRows(db, runId);
        assert.ok(afterT3.filter((r) => r.turn_seq === 2).every((r) => r.expanded === 0), "turn 3 folded turn 2 — the immediately-prior turn");
        assert.ok(afterT3.filter((r) => r.turn_seq === 1).every((r) => r.expanded === 0), "turn 1 stays folded — the grinder never reached back to re-touch it");
    } finally { await db.close(); }
});

// 9 — the budget_overflow event surfaces on a fold-to-FIT recovery, not only on the
// hard-413 path. The model learns the window was reclaimed even when the turn delivers.
test("budget: the overflow event surfaces on a fold-to-fit recovery turn", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { sessionId, runId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextSize: WINDOW, responses: [...fatReads(FAT), ...okSends(2)] });
        await wide.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tight = engineAt(db, Math.floor((floor + expanded) / 2));
        await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 }); // folds → emits budget_overflow
        const t3 = await tight.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 3 }); // drains it into the packet
        const evt = (await packetOf(db, t3.turnId)).telemetryErrors.find((e) => e.kind === "budget_overflow");
        assert.ok(evt, "budget_overflow surfaced after a fold-to-fit turn");
        assert.ok(Array.isArray(evt!.folded), "carries folded-by-scheme facts");
    } finally { await db.close(); }
});

// 10 — the un-foldable hard-413 record reports the overshoot honestly: usage over
// ceiling, percent past 100, free floored at 0. Forensics — never delivered.
test("budget: the un-foldable hard-413 record reports a positive overshoot honestly", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = engineAt(db, TINY);
        const t = await engine.runTurn({ provider: new Mock({ contextSize: WINDOW, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413);
        const { ceiling, usage, percent, free } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(usage > ceiling, `usage ${usage} exceeds ceiling ${ceiling} — a real overshoot`);
        assert.ok(percent > 100, `percent honestly past 100 in the failure record (got ${percent})`);
        assert.equal(free, 0, "free floors at 0, never negative");
    } finally { await db.close(); }
});

// 11 — ratio-mode ceiling is 90% of the window (rummy budget math: floor(window*0.9)).
// Pins computeCeiling's ratio arm against the absolute-mode tests.
test("budget: ratio-mode ceiling is 90% of the window, leaving headroom below the wall", async () => {
    const db = await openMigrated();
    try {
        const { sessionId, runId, loopId } = await envelope(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry() }); // no override → DEFAULT 0.9 ratio
        const t = await engine.runTurn({ provider: new Mock({ contextSize: 12, responses: okSends(1) }), sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const { ceiling } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.equal(ceiling, Math.floor(12 * 0.9), "ratio ceiling is floor(window * 0.9) = 10");
    } finally { await db.close(); }
});
