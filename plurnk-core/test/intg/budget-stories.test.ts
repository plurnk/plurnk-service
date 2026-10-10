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
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { completeStmt, urlPath, editStmt, readStmt, noteStmt } from "./_dsl.ts";

const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];
const WINDOW = 100_000; // the provider's effective window — wide enough to hold a fat visible READ
const TINY = 2;         // absolute wall far below any packet → irreducible overflow
const FAT = 4000;       // chars of read-back body — renders into the log, the only lever
const heavy = (chars: number): string => "x".repeat(chars);
const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});
const okSends = (n: number): MockResponse[] => Array.from({ length: n }, () => response([completeStmt("ok")]));
// A turn that writes a fat entry then READS it back (the read RESULT renders into
// the log — that is the budget pressure) then closes. The EDIT body is free; the
// READ render is not. Repeated n times for multi-turn accumulation.
// A heavy read turn — EDIT a fat entry then READ it back; the READ appears in the next turn's packet
// (that's what makes the next turn fat). It continues — the result is for the next turn
// and therefore cannot be observed in the emission that requested it.
const fatReads = (chars: number, n = 1): MockResponse[] =>
    Array.from({ length: n }, () => response([editStmt(urlPath("worker", "big"), heavy(chars)), readStmt(urlPath("worker", "big")), noteStmt("ok")]));

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
    const state = JSON.parse(budget.split("\n\n")[0]!) as { tokens: number; budget: number };
    const usage = state.tokens;
    const ceiling = state.budget;
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
// vacuous, so it is pinned first.
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
        const fatDeliver = [response([editStmt(urlPath("worker", "big"), heavy(FAT)), noteStmt("ok")])];
        const t = await engine.runTurn({ provider: new Mock({ contextWindow: WINDOW, responses: fatDeliver }), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(t.status, 102, "delivered");
        assert.equal(t.capacityHardStop, false, "no provider-capacity stop under a wide curation budget");
        const { percent } = budgetHeadline((await packetOf(db, t.turnId)).packet);
        assert.ok(percent <= 100, `delivered packet reads ≤100% (got ${percent}%)`);
    } finally { await db.close(); }
});

// The wall's Problem owns exact evidence; no request or task is fabricated.
test("{§context-wall} the irreducible window overflow reports a positive overshoot honestly", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const t = await engine.runTurn({ provider: mockCeiling(TINY, []), workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        assert.equal(t.status, 413);
        assert.equal(t.producer, "model", "admission failure does not manufacture a recovery producer");
        const problem = t.curationFailure?.problem as { tokens?: number; wall?: number; excess?: number } | undefined;
        assert.ok(problem !== undefined, "the terminal 413 carries its exact Problem");
        const { tokens, wall, excess } = problem;
        assert.ok(typeof tokens === "number" && typeof wall === "number" && typeof excess === "number");
        assert.ok(tokens > wall, `tokens ${tokens} exceed the wall ${wall} — a real overshoot`);
        assert.equal(excess, tokens - wall, "the Problem's arithmetic closes exactly ({§context-wall})");
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
        const budget = (t.curationFailure?.problem as { budget?: number } | undefined)?.budget;
        assert.equal(budget, 10, "context 12 − total output budget 2 → input capacity 10 ({§context-budget})");
        assert.equal(provider.remaining, 1, "curation overflow prevents provider I/O");
    } finally { await db.close(); }
});

test("{§context-gauge} below pressure the model-facing gauge omits its largest inventory (#478)", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, workerId, loopId } = await envelope(db);
        const engine = engineAt(db);
        const provider = new Mock({ contextWindow: WINDOW, responses: [...fatReads(FAT, 1), ...okSends(1)] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES });
        const budget = packetSection((await packetOf(db, t2.turnId)).packet, "budget");
        const gauge = JSON.parse(budget) as { tokens: number; budget: number };
        assert.ok(gauge.tokens < gauge.budget * 0.8, "this composed packet remains below pressure");
        assert.deepEqual(Object.keys(gauge), ["tokens", "budget"], "no curation inventory is needed below pressure");
        assert.equal(budget.split("\n").length, 1, "one JSON line — no warning or mandate follows the object");
        assert.doesNotMatch(budget, /\{\{/, "no placeholder survives");
        assert.doesNotMatch(packetSection((await packetOf(db, t2.turnId)).packet, "notices"), /budget_pressure/u,
            "{§context-pressure-notice}: no notice below pressure");
    } finally { await db.close(); }
});

test("{§context-gauge}: a composed packet's largest inventory points to its dominant visible log body", async () => {
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
        const object = JSON.parse(budget.split("\n\n")[0]!) as { tokens: number; budget: number; largest: Array<{ path: string; tokens: number }> };
        const inventory = object.largest;
        assert.ok(inventory.length > 0, "the pressure inventory rides inside the JSON object");
        const [largest] = inventory;
        assert.match(largest.path, /^log:\/\/\/\d+\/\d+\/\d+\/[A-Z]+$/u);
        assert.equal(typeof largest.tokens, "number");
        const advised = logEntries(stored.packet).find((row) => row.logPath === largest.path);
        assert.equal(largest.tokens, advised?.tokens, "inventory and receipt use the same complete-row charge");
        assert.equal(typeof advised?.body, "string", "the advised row is currently open in the same packet");
        assert.equal(object.tokens, stored.weight, "conditional advice participates in exact packet accounting");
        const share = /^> YOU MUST NOT exceed budget\. Context is at (\d+)% of budget\. \[budget_pressure\]$/mu
            .exec(packetSection(stored.packet, "notices"))?.[1];
        assert.equal(Number(share), Math.floor(object.tokens * 100 / object.budget),
            "{§context-pressure-notice} {§pinned-wording-core}: the pressured packet states the gauge's own share");
    } finally { await db.close(); }
});
