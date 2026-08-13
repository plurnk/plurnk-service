// Budget stories — the grinder under real pressure. The specimens exercise
// PLURNK's own packet architecture:
//
//   * Entries are FREE. An EDIT's body lands in the catalog entry, which does not
//     render — so a "fat entry" adds nothing to the packet. The only thing that
//     renders (and therefore creates budget pressure) is the LOG: a READ result
//     renders the content it pulled.
//   * The grinder runs PRE-LLM. A turn's stored request packet is what was sent
//     BEFORE the model spoke — it never contains that turn's own emission. The fat
//     log a turn produces only weighs on the NEXT turn's packet.
//   * The lever is the immediately-prior turn only
//     (engine_grinder_prior_turn_logs: MAX(turn) < current).
//
// Machinery anchors (overflow-only, layer1-rollback, context-envelope admission,
// and negative-pressure telemetry) live in Engine.budget-enforce. These behavioral
// stories prove that the grinder gates on the CURRENT packet, folding RECLAIMS
// room, and a failed hard admission never reaches the model.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, sendStmt } from "./_dsl.ts";

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const WINDOW = 100_000; // the provider's effective window — wide enough to hold a fat read OPEN
const TINY = 2;         // absolute wall far below any packet → un-foldable overflow
const FAT = 4000;       // chars of read-back body — renders into the log, the only lever
const OVERFLOW_DETAIL = "Token Budget Overflow: Token Usage exceeded Token Ceiling. Newest log items were automatically FOLDed to fit within token budget. Curate the log and/or perform more conservatively scoped or chunked retrieval operations to recover.";

const heavy = (chars: number): string => "x".repeat(chars);
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([sendStmt(200, null, "ok")]));
// A turn that writes a fat entry then READS it back (the read RESULT renders into
// the log — that is the budget pressure) then closes. The EDIT body is free; the
// READ render is not. Repeated n times for multi-turn accumulation.
// A heavy read turn — EDIT a fat entry then READ it back; the READ folds into the NEXT turn's packet
// (that's what makes the next turn fat). It CONTINUES (SEND[102]) — the result is for the next turn
// and therefore cannot be observed in the emission that requested it.
const fatReads = (chars: number, n = 1): MockResponse[] =>
    Array.from({ length: n }, () => response([editStmt(urlPath("worker", "big"), heavy(chars)), readStmt(urlPath("worker", "big")), sendStmt(102, null, "ok")]));

process.env.PLURNK_SERVICE_SAFETY = "0"; // the stories compute exact ceilings — no margin
// {§tokenomics-window-partition} — the envelope rides the provider: the ceiling pins as the Mock's window − the 1+1
// reserve floor (parseReserve rejects 0), with SAFETY zeroed for the pin's duration.
const engineAt = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });
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
const packetOf = async (db: Db, turnId: number): Promise<{ tokens: number; assistant?: { ops: unknown[] }; packet: object }> => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row!.packet) as { tokens: number; assistant?: { ops: unknown[] } };
    return { ...packet, packet };
};
const budgetHeadline = (packet: object): { ceiling: number; usage: number; percent: number; free: number } => {
    const budget = packetSection(packet, "budget");
    // percent renders `<1` for sub-1% usage (be85626 — never a bare 0%); accept it, mapping to 0.5.
    const m = budget.match(/Token Ceiling (\d+) · Token Usage\s+(\d+) \(\s*(<1|\d+)%\) · Tokens Free\s+(-?\d+)/);
    assert.ok(m, `budget headline present; got: ${budget}`);
    return { ceiling: Number(m![1]), usage: Number(m![2]), percent: m![3] === "<1" ? 0.5 : Number(m![3]), free: Number(m![4]) };
};
const logRows = async (db: Db, workerId: number): Promise<Array<{ turn_seq: number; expanded: number; tokens: number; op: string; pathname: string | null; tags: string }>> =>
    db.engine_render_log.all<{ turn_seq: number; expanded: number; tokens: number; op: string; pathname: string | null; tags: string }>({ worker_id: workerId });
// The prompt frame is grinder-exempt. {§grinder-errors-exempt}
const isPrompt = (r: { scheme?: string | null; pathname: string | null }): boolean => (r as { scheme?: string | null }).scheme === "prompt";

// Two reference measurements on throwaway workers (deterministic FAT body), so the
// fold-to-fit ceilings track the real assembly and never magic numbers:
//   floor    = bare scaffolding (turn 1's pre-emission packet, no prior log)
//   expanded = floor + a fat READ log from the prior turn, all expanded
const measure = async (db: Db): Promise<{ floor: number; expanded: number }> => {
    const { workspaceId, workerId, loopId } = await envelope(db);
    const wide = engineAt(db);
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
        const engine = engineAt(db);
        // A heavy DELIVERING turn (fat EDIT + terminal SEND[200], no same-turn READ) — under a wide
        // ceiling it delivers and the packet reads ≤ 100%.
        const fatDeliver = [response([editStmt(urlPath("worker", "big"), heavy(FAT)), sendStmt(200, null, "ok")])];
        const t = await engine.runTurn({ provider: new Mock({ contextWindow: WINDOW, responses: fatDeliver }), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t.status, 200, "delivered");
        assert.equal(t.budgetHardStop, false, "no hard-stop under a wide ceiling");
        const { percent } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(percent <= 100, `delivered packet reads ≤100% (got ${percent}%)`);
    } finally { await db.close(); }
});

// 2 — the grinder gates on the CURRENT assembled packet: a fat prior-turn
// READ log triggers the fold on the next turn — plurnk measures packet.tokens.
test("budget: overflow is judged on the current assembled packet, not a prior-turn baseline", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
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
// turn's log items"). The 413 diagnoses the recovered overflow without becoming
// the turn's terminal disposition.
test("budget: folding reclaims room, surfaces a nonterminal 413 Problem, and the turn delivers", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t2.status, 200, "the turn delivers after the grinder folds prior-turn logs to fit");
        assert.equal(t2.budgetHardStop, false, "the overflow 413 is model-facing and nonterminal");
        const packet = (await packetOf(db, t2.turnId)).packet;
        assert.match(packetSection(packet, "errors"), /^\* 413 log:\/\/\/.+\/error$/m, "the recovered overflow is indexed as a 413");
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        const overflow = errors
            .map(({ rx }) => JSON.parse(rx) as { problem?: { type?: string; status?: number; detail?: string } })
            .find(({ problem }) => problem?.type === "https://problems.plurnk.dev/engine/context/token-budget-overflow")
            ?.problem;
        assert.equal(overflow?.status, 413);
        assert.equal(overflow?.detail, OVERFLOW_DETAIL);
        assert.match(packetSection(packet, "log"), /"status":413/, "the exact Problem is visible on its durable log row");
    } finally { await db.close(); }
});

// 4 — a DELIVERED packet is always ≤100% (owner: "the packet literally can't be over
// 100%"). The fold-to-fit turn's own readout never exceeds the ceiling.
test("budget: a delivered packet after fold-to-fit reads at or below 100%", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const { percent, free } = budgetHeadline((await packetOf(db, t2.turnId)).packet);
        assert.ok(percent <= 100, `delivered fold-to-fit packet reads ≤100% (got ${percent}%)`);
        assert.ok(free >= 0, "free never goes negative on a delivered packet");
    } finally { await db.close(); }
});

// 5 — folding drops the measured packet. The post-fold delivered packet is
// lighter than the expanded reference.
test("budget: folding a fat log strictly reduces the measured packet", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const delivered = (await packetOf(db, t2.turnId)).tokens;
        assert.ok(delivered < expanded, `delivered post-fold packet (${delivered}) lighter than the expanded reference (${expanded})`);
    } finally { await db.close(); }
});

// 6 — a hard-413 never reaches the model. The stored turn remains request-only.
test("budget: an un-foldable hard-413 short-circuits dispatch — the model is never called", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const provider = mockCeiling(TINY, [response([sendStmt(200, null, "must not run")])]);
        const t = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413, "the effective context envelope rejects immediately");
        assert.equal(t.budgetHardStop, true, "the hard-stop fired before generate()");
        assert.equal(provider.remaining, 1, "the provider was not called");
        const packet = await packetOf(db, t.turnId);
        assert.equal(packet.assistant, undefined, "no assistant is fabricated when dispatch short-circuits");
    } finally { await db.close(); }
});

// 7 — fold is render-only: stored log_entries.tokens (full body cost) is unchanged
// by a fold.
test("budget: folding changes the render, not the stored token cost of the entry", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
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

// 8 — the lever is the IMMEDIATELY-prior turn, not progressive shedding. The grinder
// folds MAX(turn < current) only; it does not walk back through history. Turn 2 folds
// turn 1, turn 3 folds turn 2, and turn 1 — already
// folded — stays folded, untouched.
test("budget: the grinder folds the immediately-prior turn each time, never older folded turns", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), [...fatReads(FAT, 2), ...okSends(2)]);
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const folded = (rows: Array<{ turn_seq: number; expanded: number; op: string; pathname: string | null }>, t: number): boolean =>
            rows.filter((r) => r.turn_seq === t && r.op !== "error" && !isPrompt(r)).every((r) => r.expanded === 0);
        assert.ok(folded(await logRows(db, workerId), 1), "turn 2 folded turn 1");
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 });
        const afterT3 = await logRows(db, workerId);
        assert.ok(folded(afterT3, 2), "turn 3 folded turn 2 — the immediately-prior turn");
        assert.ok(folded(afterT3, 1), "turn 1 stays folded — the grinder never reached back to re-touch it");
    } finally { await db.close(); }
});

// 8b — automatic folds remain model-legible through the same folksonomic tags
// used by explicit FOLD/OPEN/FIND operations.
test("the grinder stamps every automatically folded row with the overflow tag", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const t2 = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const foldedRows = (await logRows(db, workerId)).filter((row) => row.turn_seq === 1 && !isPrompt(row));
        assert.ok(foldedRows.length > 0 && foldedRows.every((row) => row.expanded === 0));
        assert.ok(foldedRows.every((row) => (JSON.parse(row.tags) as string[]).includes("overflow")), "every row selected by the atomic fold carries its cause");
        assert.match(packetSection((await packetOf(db, t2.turnId)).packet, "log"), /"tags":\["overflow"\]/, "ambient metadata materializes the tag");
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.ok(errors.some(({ rx }) => JSON.parse(rx).problem?.detail === OVERFLOW_DETAIL), "the automatic fold retains its 413 failure truth");
    } finally { await db.close(); }
});

// 10 — the un-foldable hard-413 record reports ruler pressure honestly even
// though that packet is retained only as failure evidence.
test("budget: the un-foldable hard-413 record reports a positive overshoot honestly", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const t = await engine.runTurn({ provider: mockCeiling(TINY, []), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413);
        const packet = (await packetOf(db, t.turnId)).packet;
        const { ceiling, usage, percent, free } = budgetHeadline(packet);
        assert.ok(usage > ceiling, `usage ${usage} exceeds ceiling ${ceiling} — a real overshoot`);
        assert.ok(percent > 100, `percent honestly past 100 in the failure record (got ${percent})`);
        assert.equal(free, ceiling - usage, "free reports the full negative ruler debt");
        assert.equal(packetSection(packet, "budget").match(/Context Token Budget Panic:/gu)?.length, 1);
    } finally { await db.close(); }
});

// 11 — the provider window governs the partition, minus the reserves (a real build).
test("budget: the provider window governs the partition — ceiling = window − reserves", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // {§tokenomics-window-partition}: mockCeiling(10) gives window 12 with the
        // 1+1 reserve floor → promptBudget 10.
        const t = await engine.runTurn({ provider: mockCeiling(10, okSends(1)), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const { ceiling } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.equal(ceiling, 10, "window 12 − 1 − 1 reserves → promptBudget 10");
    } finally { await db.close(); }
});

test("the model-facing budget is a single measured headline", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT, 1), ...okSends(1)] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const budget = packetSection((await packetOf(db, t2.turnId)).packet, "budget");
        assert.match(budget, /Token Ceiling \d+ · Token Usage\s+\d+ \(\s*(<1|\d+)%\) · Tokens Free\s+\d+/, "the ceiling/usage/free line stays");
        assert.equal(budget.split("\n").length, 1, "no packet-level composition or ranking follows the headline");
        assert.doesNotMatch(budget, /\{\{/, "no placeholder survives");
    } finally { await db.close(); }
});
