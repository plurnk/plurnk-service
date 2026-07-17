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
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, sendStmt } from "./_dsl.ts";

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const WINDOW = 100_000; // the model's window — wide enough to hold a fat read OPEN, so WIDE isn't capped below it (the partition gates on min(CONTEXT_WINDOW, window))
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
// A heavy read turn — EDIT a fat entry then READ it back; the READ folds into the NEXT turn's packet
// (that's what makes the next turn fat). It CONTINUES (SEND[102]) — the result is for the next turn
// anyway (a same-turn READ + SEND[200] is a parser-rejected shape, grammar#51).
const fatReads = (chars: number, n = 1): MockResponse[] =>
    Array.from({ length: n }, () => response([editStmt(urlPath("known", "big"), heavy(chars)), readStmt(urlPath("known", "big")), sendStmt(102, null, "ok")]));

process.env.PLURNK_SERVICE_SAFETY = "0"; // the stories compute exact ceilings — no margin
// #507 — the envelope rides the provider: the ceiling pins as the Mock's window − the 1+1
// reserve floor (parseReserve rejects 0), with SAFETY zeroed for the pin's duration.
const engineAt = (db: Db, _ceiling?: number): Engine => new Engine({ db, schemes: new SchemeRegistry() });
const RESERVE_KEYS = ["PLURNK_PROVIDERS_REASONING_RESERVE", "PLURNK_PROVIDERS_COMPLETION_RESERVE"] as const;
const mockCeiling = (ceiling: number, responses: MockResponse[]): Mock => {
    const prev = RESERVE_KEYS.map((k) => process.env[k]);
    process.env.PLURNK_PROVIDERS_REASONING_RESERVE = "1";
    process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE = "1";
    const m = new Mock({ contextWindow: ceiling + 2, responses });
    RESERVE_KEYS.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
    return m;
};
const envelope = async (db: Db): Promise<{ workspaceId: number; workerId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, `bs-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    return { workspaceId, workerId, loopId };
};
const packetOf = async (db: Db, turnId: number): Promise<{ tokens: number; assistant: { ops: unknown[] }; telemetryErrors: Array<Record<string, unknown>>; packet: object }> => {
    const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row!.packet) as { tokens: number; assistant: { ops: unknown[] }; telemetryErrors: Array<Record<string, unknown>> };
    return { ...packet, packet };
};
const budgetHeadline = (packet: object): { ceiling: number; usage: number; percent: number; free: number } => {
    const budget = packetSection(packet, "budget");
    // percent renders `<1` for sub-1% usage (be85626 — never a bare 0%); accept it, mapping to 0.5.
    const m = budget.match(/Token Ceiling (\d+) · Token Usage (\d+) \((<1|\d+)%\) · Tokens Free (\d+)/);
    assert.ok(m, `budget headline present; got: ${budget}`);
    return { ceiling: Number(m![1]), usage: Number(m![2]), percent: m![3] === "<1" ? 0.5 : Number(m![3]), free: Number(m![4]) };
};
const logRows = async (db: Db, workerId: number): Promise<Array<{ turn_seq: number; expanded: number; tokens: number; op: string; pathname: string | null }>> =>
    (db.engine_render_log as PrepMethod).all<{ turn_seq: number; expanded: number; tokens: number; op: string; pathname: string | null }>({ worker_id: workerId });
// #382 — the user prompt (plurnk://prompt/…) is grinder-EXEMPT frame; the grinder folds work, never the task.
const isPrompt = (r: { pathname: string | null }): boolean => (r.pathname ?? "").startsWith("/prompt/");

// Two reference measurements on throwaway runs (deterministic FAT body), so the
// fold-to-fit ceilings track the real assembly and never magic numbers:
//   floor    = bare scaffolding (turn 1's pre-emission packet, no prior log)
//   expanded = floor + a fat READ log from the prior turn, all expanded
const measure = async (db: Db): Promise<{ floor: number; expanded: number }> => {
    const { workspaceId, workerId, loopId } = await envelope(db);
    const wide = engineAt(db, WIDE);
    const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
    const t1 = await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
    const t2 = await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
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
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db, WIDE);
        // A heavy DELIVERING turn (fat EDIT + terminal SEND[200], no same-turn READ) — under a wide
        // ceiling it delivers and the packet reads ≤ 100%.
        const fatDeliver = [response([editStmt(urlPath("known", "big"), heavy(FAT)), sendStmt(200, null, "ok")])];
        const t = await engine.runTurn({ provider: new Mock({ contextWindow: WINDOW, responses: fatDeliver }), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
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
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 }); // fat READ log, expanded
        // Ceiling sits ABOVE the floor but BELOW floor+fat: the only thing over the
        // wall is the fat prior-turn log, which the grinder must measure NOW and fold.
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const t1Log = (await logRows(db, workerId)).filter((r) => r.turn_seq === 1 && !isPrompt(r));
        assert.ok(t1Log.length > 0 && t1Log.every((r) => r.expanded === 0), "the fat prior-turn log (excl. the exempt prompt) was folded — overflow judged on the current packet");
    } finally { await db.close(); }
});

// 3 — fold RECLAIMS budget and the turn still DELIVERS (the owner's core invariant:
// "impossible to go over budget if you started under and fold all of your previous
// turn's log items"). Overflow → fold prior turn → fits → 200, not 413.
test("budget: folding the prior turn reclaims room and the turn delivers (200, not 413)", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
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
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
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
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const delivered = (await packetOf(db, t2.turnId)).tokens;
        assert.ok(delivered < expanded, `delivered post-fold packet (${delivered}) lighter than the expanded reference (${expanded})`);
    } finally { await db.close(); }
});

// 6 — a hard-413 never reaches the model (rummy budget_hard_413 "short-circuits
// dispatch"). The stored turn carries an EMPTY assistant — generate() was skipped.
test("budget: an un-foldable hard-413 short-circuits dispatch — the model is never called", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        // §grinder-hard-413-recovery: the first overflow is the recovery turn (consumes the one
        // grant + the one Mock response); the SECOND is the hard-413 this test pins.
        await engine.runTurn({ provider: mockCeiling(TINY, [response([sendStmt(102, null, "on it")])]), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const t = await engine.runTurn({ provider: mockCeiling(TINY, []), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 });
        assert.equal(t.status, 413, "recovery declined → hard-413");
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
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = (await logRows(db, workerId)).filter((r) => r.turn_seq === 1).reduce((s, r) => s + r.tokens, 0);
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const t1After = (await logRows(db, workerId)).filter((r) => r.turn_seq === 1);
        assert.ok(t1After.filter((r) => !isPrompt(r)).every((r) => r.expanded === 0), "turn 1's work folded (the exempt prompt stays open)");
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
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), [...fatReads(FAT, 2), ...okSends(2)]);
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        // op='error' rows (the grinder's own overflow row) are exempt from folding (§grinder-errors-exempt),
        // so the "all folded" invariant is over the non-error rows.
        const folded = (rows: Array<{ turn_seq: number; expanded: number; op: string; pathname: string | null }>, t: number): boolean =>
            rows.filter((r) => r.turn_seq === t && r.op !== "error" && !isPrompt(r)).every((r) => r.expanded === 0);
        assert.ok(folded(await logRows(db, workerId), 1), "turn 2 folded turn 1");
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 });
        const afterT3 = await logRows(db, workerId);
        assert.ok(folded(afterT3, 2), "turn 3 folded turn 2 — the immediately-prior turn");
        assert.ok(folded(afterT3, 1), "turn 1 stays folded — the grinder never reached back to re-touch it");
    } finally { await db.close(); }
});

// 8b — error rows are grinder-exempt: turn 3's grinder folds turn 2's content but NEVER turn 2's
// own op='error' overflow row, so the overflow trail stays OPEN and accumulates across turns.
test("[§grinder-errors-exempt] the grinder folds turn-2's content but never its op='error' overflow row", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), [...fatReads(FAT, 2), ...okSends(2)]);
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 }); // overflows → mints a turn-2 op='error' overflow row
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 }); // folds turn 2 — but not its error row
        const t2 = (await logRows(db, workerId)).filter((r) => r.turn_seq === 2);
        const errs = t2.filter((r) => r.op === "error");
        assert.ok(errs.length >= 1, "turn 2 minted an op='error' overflow row");
        assert.ok(errs.every((r) => r.expanded === 1), "the error row stays OPEN after turn 3's grinder folds turn 2 — exempt");
        assert.ok(t2.filter((r) => r.op !== "error").every((r) => r.expanded === 0), "every non-error row on turn 2 was folded");
    } finally { await db.close(); }
});

// 9 — the overflow error (op='error', 413) surfaces as a terse LogCoordinate pointer on a
// fold-to-FIT recovery, not only on the hard-413 path. Same-turn (§grinder-overflow-error-row):
// it lands on turn 2's OWN packet — the turn whose assembly overflowed — not a turn late.
test("budget: the overflow error surfaces on the fold-to-fit recovery turn (same-turn)", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(2));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 }); // folds → mints + surfaces the overflow error
        const evt = (await packetOf(db, t2.turnId)).telemetryErrors.find(
            (e) => (e.position as { type?: string } | undefined)?.type === "log-coordinate" && e.status === 413,
        );
        assert.ok(evt, "the overflow surfaced THIS turn as a 413 log-coordinate pointer");
        assert.equal(evt!.folded, undefined, "terse — no by-scheme JSON facts");
    } finally { await db.close(); }
});

// 10 — the un-foldable hard-413 record reports the overshoot honestly: usage over
// ceiling, percent past 100, free floored at 0. Forensics — never delivered.
test("budget: the un-foldable hard-413 record reports a positive overshoot honestly", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        await engine.runTurn({ provider: mockCeiling(TINY, [response([sendStmt(102, null, "on it")])]), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const t = await engine.runTurn({ provider: mockCeiling(TINY, []), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 });
        assert.equal(t.status, 413);
        const { ceiling, usage, percent, free } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(usage > ceiling, `usage ${usage} exceeds ceiling ${ceiling} — a real overshoot`);
        assert.ok(percent > 100, `percent honestly past 100 in the failure record (got ${percent})`);
        assert.equal(free, 0, "free floors at 0, never negative");
    } finally { await db.close(); }
});

// 11 — the provider window governs the partition, minus the reserves (a real build).
test("budget: the provider window governs the partition — ceiling = window − reserves", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // #507 — mockCeiling(10): window 12 with the 1+1 reserve floor → promptBudget 10.
        const t = await engine.runTurn({ provider: mockCeiling(10, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const { ceiling } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.equal(ceiling, 10, "window 12 − 1 − 1 reserves → promptBudget 10");
    } finally { await db.close(); }
});

test("[§budget-mermaid] toggle on: two budget-scaled mermaid diagrams, placeholders resolved, headline preserved, never truncated at low usage", async () => {
    // #440 — the visual layer, measured against the tabular baseline (default off). Under a WIDE ceiling
    // usage is <50%, where the TABLES would truncate; the diagrams must stay (calm view is the point).
    process.env.PLURNK_SERVICE_BUDGET_MERMAID = "on";
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT, 1), ...okSends(1)] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });        // turn 1: fat READ folds into turn 2
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES }); // turn 2: its packet carries the log weight
        const budget = packetSection((await packetOf(db, t2.turnId)).packet, "budget");
        // Headline stays (weighability), and it is NOT truncated to just the headline despite <50% usage.
        assert.match(budget, /Token Ceiling \d+ · Token Usage \d+ \((<1|\d+)%\) · Tokens Free \d+/, "the ceiling/usage/free line stays");
        assert.equal((budget.match(/```mermaid/g) ?? []).length, 2, "two mermaid diagrams render even under half-full (self-scaling, not truncated)");
        assert.doesNotMatch(budget, /xychart/, "the heaviest-items xychart was cut (#450 — cryptic coord labels)");
        // Treemap: turn boxes + system+context + free compose the ceiling; all resolved to numbers.
        assert.match(budget, /treemap-beta/, "turn-composition treemap");
        assert.match(budget, /"free": \d+/, "treemap free box resolved to a number");
        assert.match(budget, /"system \+ context": \d+/, "treemap system+context box resolved (total − Σturns)");
        assert.match(budget, /"turn 1\/1": \d+/, "a per-turn box carries its token weight");
        // Xychart: bars against the FULL ceiling y-axis (the space above is headroom).
        // Pie: used vs free.
        assert.match(budget, /pie showData[\s\S]*?"used" : \d+[\s\S]*?"free" : \d+/, "used-vs-free gauge");
        // No placeholder survived — every total-dependent value resolved post-assembly.
        assert.doesNotMatch(budget, /\{\{/, "no {{…}} placeholder left in any diagram");
        // #450 — the heaviest-items list stays a plain ranked table alongside the mermaid, not a chart.
        assert.match(budget, /Heaviest items \(FOLD targets/, "the heaviest-items list stays a table in the mermaid budget");
        assert.match(budget, /\| log:\/\/\/.+ \| \d+ \|/, "its rows are log:/// handles + tokens (the FOLD targets)");
    } finally {
        delete process.env.PLURNK_SERVICE_BUDGET_MERMAID;
        await db.close();
    }
});

test("[§budget-mermaid] set off: the tabular readout renders — the A/B baseline (#440 before/after)", async () => {
    process.env.PLURNK_SERVICE_BUDGET_MERMAID = "off";
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db, WIDE);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT, 1), ...okSends(1)] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const budget = packetSection((await packetOf(db, t2.turnId)).packet, "budget");
        assert.doesNotMatch(budget, /```mermaid/, "off → no diagrams, the tabular baseline for the A/B");
    } finally {
        delete process.env.PLURNK_SERVICE_BUDGET_MERMAID;
        await db.close();
    }
});
