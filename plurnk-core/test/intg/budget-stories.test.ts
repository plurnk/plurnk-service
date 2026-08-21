// Budget stories — the overflow recovery under real pressure. The specimens exercise
// PLURNK's own packet architecture:
//
//   * Entries are FREE. An EDIT's body lands in the catalog entry, which does not
//     render — so a "fat entry" adds nothing to the packet. The only thing that
//     renders (and therefore creates budget pressure) is the LOG: a READ result
//     renders the content it pulled.
//   * The overflow recovery runs PRE-LLM. An over-ceiling would-be model turn becomes
//     a packetless `_plurnk` recovery turn; the next model turn receives the recovered
//     state and one ephemeral notice. A model turn's stored request packet is what was
//     sent before the model spoke, so its own fat log weighs on the next candidate.
//   * The lever is the immediately-prior turn only
//     (the immediately preceding model turn plus the current pre-model boundary).
//
// Machinery anchors (overflow-only, layer1-rollback, context-envelope admission,
// and negative-pressure telemetry) live in Engine.budget-enforce. These behavioral
// stories prove that the recovery gates on the current candidate, ordinary FOLD
// reclaims room, and a failed hard admission never reaches the model.

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

const engineAt = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });
const ENVELOPE_KEYS = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
const mockCeiling = (ceiling: number, responses: MockResponse[]): Mock => {
    const prev = ENVELOPE_KEYS.map((key) => process.env[key]);
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
    delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    const m = new Mock({ contextWindow: ceiling + 2, responses });
    ENVELOPE_KEYS.forEach((key, index) => {
        if (prev[index] === undefined) delete process.env[key];
        else process.env[key] = prev[index];
    });
    return m;
};
const envelope = async (db: Db): Promise<{ workspaceId: number; workerId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, `bs-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    return { workspaceId, workerId, loopId };
};
const packetOf = async (db: Db, turnId: number): Promise<{ weight: number; assistant?: { ops: unknown[] }; packet: object }> => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row!.packet) as { weight: number; assistant?: { ops: unknown[] } };
    return { ...packet, packet };
};
const overflowPlan = async (db: Db, turnId: number): Promise<string> => {
    const turn = await db.test_get_turn.get<{ producer: string; kind: string }>({ id: turnId });
    assert.deepEqual(
        { producer: turn?.producer, kind: turn?.kind },
        { producer: "_plurnk", kind: "overflow" },
        "the recovery has an explicit producer and purpose",
    );
    const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: turnId });
    const plan = rows.find((row) => row.op === "PLAN" && row.origin === "_plurnk");
    assert.ok(plan, "the packetless recovery turn contains its actual PLAN operation");
    return (JSON.parse(plan.tx) as { body: string }).body;
};
const pressureOf = (plan: string): { usage: number; ceiling: number; deficit: number } => {
    const match = /Token Usage (\d+) exceeded Token Ceiling (\d+) by (\d+)\./.exec(plan);
    assert.ok(match, `overflow PLAN carries measured pressure; got: ${plan}`);
    return { usage: Number(match[1]), ceiling: Number(match[2]), deficit: Number(match[3]) };
};
const budgetHeadline = (packet: object): { ceiling: number; usage: number; percent: number; free: number } => {
    const budget = packetSection(packet, "budget");
    // percent renders `<1` for sub-1% usage (be85626 — never a bare 0%); accept it, mapping to 0.5.
    const m = budget.match(/Token Ceiling (\d+) · Token Usage\s+(\d+) \(\s*(<1|\d+)%\) · Tokens Free\s+(-?\d+)/);
    assert.ok(m, `budget headline present; got: ${budget}`);
    return { ceiling: Number(m![1]), usage: Number(m![2]), percent: m![3] === "<1" ? 0.5 : Number(m![3]), free: Number(m![4]) };
};
const logRows = async (db: Db, workerId: number): Promise<Array<{ turn_seq: number; folded: string; weight: number; op: string; pathname: string | null; tags: string }>> =>
    db.engine_render_log.all<{ turn_seq: number; folded: string; weight: number; op: string; pathname: string | null; tags: string }>({ worker_id: workerId });
// The prompt frame is overflow recovery-exempt. {§overflow-turn-exemptions}
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
    return { floor: (await packetOf(db, t1.turnId)).weight, expanded: (await packetOf(db, t2.turnId)).weight };
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

// 1 — cascade ok: comfortably under budget the overflow recovery is inert, delivered ≤100%.
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
        assert.equal(t.capacityHardStop, false, "no provider-capacity stop under a wide curation budget");
        const { percent } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(percent <= 100, `delivered packet reads ≤100% (got ${percent}%)`);
    } finally { await db.close(); }
});

// 2 — the overflow recovery gates on the CURRENT assembled packet: a fat prior-turn
// READ log triggers the fold on the next turn — plurnk measures packet.weight.
test("budget: overflow is judged on the current assembled packet, not a prior-turn baseline", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 }); // fat READ log, expanded
        // Ceiling sits ABOVE the floor but BELOW floor+fat: the only thing over the
        // wall is the fat prior-turn log, which the overflow recovery must measure NOW and fold.
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const recovery = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(recovery.producer, "_plurnk", "the over-ceiling candidate becomes a recovery turn");
        assert.equal((await db.test_get_turn.get<{ packet: string | null }>({ id: recovery.turnId }))?.packet, null);
        assert.equal(tightP.remaining, 1, "provider I/O is unreachable on the recovery turn");
        const priorModelLog = (await logRows(db, workerId)).filter((r) => r.turn_seq === 2 && r.weight > 0 && !isPrompt(r));
        assert.ok(priorModelLog.length > 0 && priorModelLog.every((r) => r.folded === "[[1,-1]]"),
            "the fat prior model turn was folded because the current candidate overflowed");
    } finally { await db.close(); }
});

// 3 — recovery is its own turn. The successor model packet carries one ephemeral
// 413 notice and can deliver normally without a synthetic durable Problem row.
test("budget: folding reclaims room, records a recovery turn, and the successor model turn delivers", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const recovery = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(recovery.producer, "_plurnk");
        assert.match(await overflowPlan(db, recovery.turnId), /^\* Token Budget Overflow:/);
        const delivered = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(delivered.status, 200, "the successor model turn delivers after recovery");
        assert.equal(delivered.producer, "model");
        const packet = (await packetOf(db, delivered.turnId)).packet;
        assert.equal(packetSection(packet, "errors"), "", "recovered overflow is not fabricated as a durable operation failure");
        assert.equal(packetSection(packet, "notices").match(/Token Budget Overflow:/gu)?.length, 1,
            "the successor receives exactly one ephemeral overflow notice");
        assert.match(packetSection(packet, "notices"), new RegExp(OVERFLOW_DETAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.equal(errors.some(({ rx }) => JSON.parse(rx).problem?.type === "https://problems.plurnk.dev/engine/context/token-budget-overflow"), false,
            "durable recovery operations and ephemeral notice do not duplicate themselves as a synthetic Problem");
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
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const delivered = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const { percent, free } = budgetHeadline((await packetOf(db, delivered.turnId)).packet);
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
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const modelTurn = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const delivered = (await packetOf(db, modelTurn.turnId)).weight;
        assert.ok(delivered < expanded, `delivered post-fold packet (${delivered}) lighter than the expanded reference (${expanded})`);
    } finally { await db.close(); }
});

// 6 — a hard-413 never reaches the model. The recovery turn remains packetless.
test("budget: an un-foldable hard-413 short-circuits dispatch — the model is never called", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const provider = mockCeiling(TINY, [response([sendStmt(200, null, "must not run")])]);
        const t = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413, "the effective context envelope rejects immediately");
        assert.equal(t.producer, "_plurnk");
        assert.equal(t.capacityHardStop, false, "curation recovery fails before the provider capacity boundary");
        assert.equal(provider.remaining, 1, "the provider was not called");
        assert.equal((await db.test_get_turn.get<{ packet: string | null }>({ id: t.turnId }))?.packet, null,
            "no request or assistant is fabricated when recovery fails");
        assert.ok((await overflowPlan(db, t.turnId)).includes("Token Budget Overflow"));
    } finally { await db.close(); }
});

// 7 — fold is render-only: stored log_entries.weight is unchanged
// by a fold.
test("budget: folding changes the render, not the stored curation weight of the entry", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT), ...okSends(1)] });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const before = (await logRows(db, workerId)).filter((r) => r.turn_seq === 2).reduce((s, r) => s + r.weight, 0);
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const modelTurnAfter = (await logRows(db, workerId)).filter((r) => r.turn_seq === 2);
        assert.ok(modelTurnAfter.filter((r) => r.weight > 0 && !isPrompt(r)).every((r) => r.folded === "[[1,-1]]"),
            "the first model turn's bodies folded while its exempt prompt stayed open");
        assert.equal(modelTurnAfter.reduce((s, r) => s + r.weight, 0), before,
            "stored weight is unchanged across the fold — only the render collapsed");
    } finally { await db.close(); }
});

// 8 — the lever is the IMMEDIATELY-prior turn, not progressive shedding. The overflow recovery
// selects the previous packet-bearing turn only; it does not walk backward
// through packetless chronology or progressively shed older history.
test("budget: the overflow recovery folds the immediately-prior turn each time, never older folded turns", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), [...fatReads(FAT, 1), ...okSends(1)]);
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 }); // recovery, raw turn 3
        const folded = (rows: Array<{ turn_seq: number; folded: string; weight: number; op: string; pathname: string | null }>, t: number): boolean =>
            rows.filter((r) => r.turn_seq === t && r.weight > 0 && r.op !== "error" && !isPrompt(r)).every((r) => r.folded === "[[1,-1]]");
        assert.ok(folded(await logRows(db, workerId), 2), "the first recovery folded model turn 2");
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 }); // fat model turn, raw turn 4
        await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 3 }); // recovery, raw turn 5
        const afterSecondRecovery = await logRows(db, workerId);
        assert.ok(folded(afterSecondRecovery, 4), "the second recovery folded immediately-prior model turn 4");
        assert.ok(folded(afterSecondRecovery, 2), "older model turn 2 stays folded without being selected again");
    } finally { await db.close(); }
});

// 8b — automatic folds remain model-legible through the same folksonomic tags
// used by explicit FOLD/OPEN/FIND operations.
test("the overflow recovery stamps every automatically folded row with the overflow tag", async () => {
    const db = await openMigrated();
    try {
        const { floor, expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const wide = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) });
        await wide.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const tightP = mockCeiling(Math.floor((floor + expanded) / 2), okSends(1));
        const recovery = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const foldedRows = (await logRows(db, workerId)).filter((row) => row.turn_seq === 2 && row.weight > 0 && !isPrompt(row));
        assert.ok(foldedRows.length > 0 && foldedRows.every((row) => row.folded === "[[1,-1]]"));
        assert.ok(foldedRows.every((row) => {
            const tags = JSON.parse(row.tags) as string[];
            return tags.includes("_plurnk") && tags.includes("overflow");
        }), "every row selected by recovery carries its internal producer and cause");
        const delivered = await wide.runTurn({ provider: tightP, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const rendered = packetSection((await packetOf(db, delivered.turnId)).packet, "log");
        assert.match(rendered, /"tags":\["_plurnk","overflow"\]/, "the successor packet materializes both classifications");
        const recoveryRows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string }>({ turn_id: recovery.turnId });
        assert.ok(
            recoveryRows.some((row) => row.op === "FOLD" && row.origin === "_plurnk"),
            "the recovery records its exact ordinary FOLD operations",
        );
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.equal(errors.some(({ rx }) => JSON.parse(rx).problem?.detail === OVERFLOW_DETAIL), false,
            "successful recovery is a turn and notice, not a durable synthetic error");
    } finally { await db.close(); }
});

// 10 — the un-foldable hard-413 PLAN reports ruler pressure honestly while
// the rejected candidate remains unstored.
test("budget: the un-foldable hard-413 recovery PLAN reports a positive overshoot honestly", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const t = await engine.runTurn({ provider: mockCeiling(TINY, []), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413);
        const { ceiling, usage, deficit } = pressureOf(await overflowPlan(db, t.turnId));
        assert.ok(usage > ceiling, `usage ${usage} exceeds ceiling ${ceiling} — a real overshoot`);
        assert.equal(deficit, usage - ceiling, "PLAN pressure closes exactly");
        assert.equal((await db.test_get_turn.get<{ packet: string | null }>({ id: t.turnId }))?.packet, null);
    } finally { await db.close(); }
});

// 11 — provider-derived input capacity governs curation (a real build).
test("budget: the provider-derived input capacity is the curation ceiling", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // {§tokenomics-window-partition}: mockCeiling(10) gives context 12 with
        // a total output budget of 2, deriving input capacity 10. The ordinary
        // curation rail reports that exact derived ceiling before provider I/O.
        const provider = mockCeiling(10, okSends(1));
        const t = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const { ceiling } = pressureOf(await overflowPlan(db, t.turnId));
        assert.equal(ceiling, 10, "context 12 − total output budget 2 → input capacity 10");
        assert.equal(provider.remaining, 1, "curation overflow prevents provider I/O");
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
