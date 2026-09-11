// {§tokenomics}: measured packet weight, pressure inventory and hard-capacity
// evidence. Output admission and preservation are exercised in output-admission.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, logEntries } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, dispositionStmt, } from "./_dsl.ts";

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const WINDOW = 100_000; // the provider's effective window — wide enough to hold a fat visible READ
const TINY = 2;         // absolute wall far below any packet → irreducible overflow
const FAT = 4000;       // chars of read-back body — renders into the log, the only lever
const heavy = (chars: number): string => "x".repeat(chars);
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([dispositionStmt("completed", "ok")]));
// A turn that writes a fat entry then READS it back (the read RESULT renders into
// the log — that is the budget pressure) then closes. The EDIT body is free; the
// READ render is not. Repeated n times for multi-turn accumulation.
// A heavy read turn — EDIT a fat entry then READ it back; the READ appears in the next turn's packet
// (that's what makes the next turn fat). It continues — the result is for the next turn
// and therefore cannot be observed in the emission that requested it.
const fatReads = (chars: number, n = 1): MockResponse[] =>
    Array.from({ length: n }, () => response([editStmt(urlPath("worker", "big"), heavy(chars)), readStmt(urlPath("worker", "big")), dispositionStmt("in_progress", "ok")]));

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
const budgetHeadline = (packet: object): { ceiling: number; usage: number; percent: number; free: number } => {
    const budget = packetSection(packet, "budget");
    const state = JSON.parse(budget.split("\n\n")[0]!) as { logTokensTotal: number; tokensActiveMax: number };
    const usage = state.logTokensTotal;
    const ceiling = state.tokensActiveMax;
    return { ceiling, usage, percent: (usage / ceiling) * 100, free: ceiling - usage };
};
// Two reference measurements on throwaway workers (deterministic FAT body), so the
// recovery ceilings track the real assembly and never magic numbers:
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

// 0 — the fattener actually fattens. If this fails every recovery story below is
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
        // A large EDIT with in-progress inventory fits under the wide ceiling.
        const fatDeliver = [response([editStmt(urlPath("worker", "big"), heavy(FAT)), dispositionStmt("in_progress", "ok")])];
        const t = await engine.runTurn({ provider: new Mock({ contextWindow: WINDOW, responses: fatDeliver }), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t.status, 102, "delivered");
        assert.equal(t.capacityHardStop, false, "no provider-capacity stop under a wide curation budget");
        const { percent } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(percent <= 100, `delivered packet reads ≤100% (got ${percent}%)`);
    } finally { await db.close(); }
});

// The hard-413 Problem owns exact pressure; no request or task is fabricated.
test("budget: the irreducible hard-413 Problem reports a positive overshoot honestly", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const t = await engine.runTurn({ provider: mockCeiling(TINY, []), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413);
        assert.equal(t.producer, "model", "admission failure does not manufacture a recovery producer");
        const problem = t.curationFailure?.problem as { usage?: number; ceiling?: number; deficit?: number } | undefined;
        assert.ok(problem !== undefined, "the terminal 413 carries its exact Problem");
        const { ceiling, usage, deficit } = problem;
        assert.ok(typeof usage === "number" && typeof ceiling === "number" && typeof deficit === "number");
        assert.ok(usage > ceiling, `usage ${usage} exceeds ceiling ${ceiling} — a real overshoot`);
        assert.equal(deficit, usage - ceiling, "Problem pressure closes exactly");
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
        assert.equal(t.producer, "model");
        const ceiling = (t.curationFailure?.problem as { ceiling?: number } | undefined)?.ceiling;
        assert.equal(ceiling, 10, "context 12 − total output budget 2 → input capacity 10");
        assert.equal(provider.remaining, 1, "curation overflow prevents provider I/O");
    } finally { await db.close(); }
});

test("the model-facing budget is one measured three-field state (#478)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT, 1), ...okSends(1)] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const budget = packetSection((await packetOf(db, t2.turnId)).packet, "budget");
        assert.deepEqual(Object.keys(JSON.parse(budget) as object), ["logTokensTotal", "tokensActiveMax", "tokensResponseMax"], "the active-total/maximum/response state stays, and only those three");
        assert.equal(budget.split("\n").length, 1, "one JSON line — no ranking or mandate follows the three fields");
        assert.doesNotMatch(budget, /\{\{/, "no placeholder survives");
    } finally { await db.close(); }
});

test("{§tokenomics-pressure-inventory}: a pressured composed packet points to its dominant visible log body", async () => {
    const db = await openMigrated();
    try {
        const { expanded } = await measure(db);
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        await engine.runTurn({
            provider: new Mock({ contextWindow: WINDOW, responses: fatReads(FAT) }),
            workspaceId, workerId, loopId, messages: MESSAGES,
        });
        const pressureCeiling = Math.ceil(expanded / 0.85);
        const pressured = await engine.runTurn({
            provider: mockCeiling(pressureCeiling, okSends(1)),
            workspaceId, workerId, loopId, messages: MESSAGES,
        });
        const stored = await packetOf(db, pressured.turnId);
        const budget = packetSection(stored.packet, "budget");
        const object = JSON.parse(budget.split("\n\n")[0]!) as { logTokensTotal: number; logTokensLargest: Array<{ path: string; logTokens: number }> };
        const inventory = object.logTokensLargest;
        assert.ok(inventory.length > 0, "the pressure inventory rides inside the JSON object");
        const [largest] = inventory;
        assert.match(largest.path, /^log:\/\/\/\d+\/\d+\/\d+\/[A-Z]+$/u);
        assert.equal(typeof largest.logTokens, "number");
        const advised = logEntries(stored.packet).find((row) => row.path === largest.path);
        assert.equal(largest.logTokens, advised?.logTokens, "inventory and receipt use the same complete-row charge");
        assert.equal(typeof advised?.body, "string", "the advised row is currently open in the same packet");
        assert.equal(object.logTokensTotal, stored.weight, "conditional advice participates in exact packet accounting");
    } finally { await db.close(); }
});
