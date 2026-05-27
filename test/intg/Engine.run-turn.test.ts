import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, ReadStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Mock from "../../src/providers/Mock.ts";
import type { MockResponse } from "../../src/providers/Mock.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: urlPath("known", pathname),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[], content: string = "", completion: number = 0): MockResponse => ({
    assistant: {
        content, ops, reasoning: null,
        usage: { prompt: 0, completion, cached: 0, total: completion },
    },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "test prompt");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, sessionId, runId, loopId };
};

test("Engine.runTurn: EDIT + SEND turn writes entry, log rows, turn row with status from SEND", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")], "content", 42)],
        });
        const result = await engine.runTurn({
            provider, sessionId, runId, loopId,
            messages: [
                { role: "system", content: "You are an agent." },
                { role: "user", content: "Do the thing." },
            ],
        });
        assert.equal(result.status, 200, "turn status from terminal SEND");
        assert.deepEqual(result.statuses, [201, 200], "EDIT created → 201; SEND broadcast → 200");

        const turn = await (db.test_get_turn as PrepMethod).get<{ loop_id: number; sequence: number; status: number; usage_completion: number }>({ id: result.turnId });
        if (turn === undefined) throw new Error("turn not found");
        assert.equal(turn.loop_id, loopId);
        assert.equal(turn.sequence, 1);
        assert.equal(turn.status, 200);
        assert.equal(turn.usage_completion, 42);

        // 3 log_entries: 1 client-origin SEND[200] for the prompt at
        // sequence=0 (written when the turn opens) + 2 model ops
        // (EDIT at 1, SEND at 2). Turn-as-container model — pre-model
        // writes share the turn's sequence counter.
        const logCount = (await (db.test_count_log_entries_by_turn as PrepMethod).get<{ n: number }>({ turn_id: result.turnId }))?.n;
        assert.equal(logCount, 3);

        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200, "terminal SEND propagated to loop.status");
    } finally { await db.close(); }
});

test("Engine.runTurn: packet stores system + user content from messages", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({ contextSize: 100000, responses: [response([sendStmt(102, "ok")])] });
        const result = await engine.runTurn({
            provider, sessionId, runId, loopId,
            messages: [
                { role: "system", content: "system prompt body" },
                { role: "user", content: "first user msg" },
                { role: "user", content: "second user msg" },
            ],
        });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { system: { system_definition: string }; user: { prompt: string }; assistant: unknown };
        assert.equal(packet.system.system_definition, "system prompt body");
        assert.equal(packet.user.prompt, "first user msg\n\nsecond user msg");
        assert.ok(packet.assistant !== null);
    } finally { await db.close(); }
});

test("Engine.runTurn: multi-op turn — prompt at 1, model ops at 2..N", async () => {
    // Turn-as-container model, 1-based. Turn 1 opens with sequence=1
    // reserved for the prompt (system-origin EDIT against
    // plurnk://prompt/<loop_id>). The 4 model ops dispatch at 2, 3, 4, 5 —
    // continuing the turn's running counter.
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([
                editStmt("/a", "1"), editStmt("/b", "2"), editStmt("/c", "3"),
                sendStmt(200, "done"),
            ])],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        assert.deepEqual(result.statuses, [201, 201, 201, 200]);
        const indices = await (db.test_log_entries_by_turn as PrepMethod).all<{ sequence: number; op: string }>({ turn_id: result.turnId });
        assert.deepEqual(
            indices.map((r) => ({ idx: r.sequence, op: r.op })),
            [
                { idx: 1, op: "EDIT" }, // the prompt (plurnk://prompt/<loop_id>)
                { idx: 2, op: "EDIT" },
                { idx: 3, op: "EDIT" },
                { idx: 4, op: "EDIT" },
                { idx: 5, op: "SEND" },
            ],
        );
    } finally { await db.close(); }
});

// Rail #41 (revised): per-turn requirement is "emit at least one op."
// SEND is just one of nine grammar ops; any op satisfies the rule.
// Empty op list is the only strike condition.

test("Engine.runTurn: ops-without-SEND turn completes at status 102 (implicit continue)", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/x", "y")])],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        assert.equal(result.status, 102, "EDIT-only turn is implicitly 'still going'");
        assert.deepEqual(result.statuses, [201]);
        const turnCount = (await (db.test_count_turns as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(turnCount, 1);
    } finally { await db.close(); }
});

test("Engine.runTurn: zero-ops turn completes at status 422; failure is recorded", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([])],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        assert.equal(result.status, 422);
        assert.deepEqual(result.statuses, []);
        const turnCount = (await (db.test_count_turns as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(turnCount, 1, "turn row inserted at 422; failure is logged, not hidden");
    } finally { await db.close(); }
});

test("Engine.runTurn: no_ops failure surfaces in NEXT packet's user.telemetry.errors[]", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([]),                                          // turn 1: empty ops
                response([editStmt("/b", "2"), sendStmt(200, "ok")]),  // turn 2: clean
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as {
            user: { telemetry: { errors: Array<{ kind: string; message: string }> } };
        };
        const noOpsErrors = packet.user.telemetry.errors.filter((e) => e.kind === "no_ops");
        assert.equal(noOpsErrors.length, 1, "turn 1's empty-ops surfaces in turn 2's telemetry");
        assert.match(noOpsErrors[0].message, /at least one operation/);
    } finally { await db.close(); }
});

// Rail #40: sudden-death soft warning fires in the last maxStrikes-sized
// window before maxTurns. Soft: no strike, no loop-status change.

test("Engine.runLoop: sudden_death fires inside the window, not before", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // maxTurns=5, maxStrikes=2 → threshold=3. Warnings on turns 3, 4.
        // After turn 5 the maxTurns guard cancels.
        // Vary per-turn fingerprint (different EDIT path each turn) so rail
        // #39 cycle detection stays orthogonal.
        const provider = new Mock({
            contextSize: 100000,
            responses: Array.from({ length: 6 }, (_, i) => response([editStmt(`/var-${i}`, "v"), sendStmt(102, "go")])),
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 5, maxStrikes: 2,
        });
        assert.equal(result.hitMaxTurns, true);
        assert.equal(result.turnIds.length, 5);

        // Inspect each turn's packet to see when sudden_death first appeared.
        const turnPackets = await Promise.all(result.turnIds.map(async (id) => {
            const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id });
            const packet = JSON.parse(row?.packet ?? "{}") as {
                user: { telemetry: { errors: Array<{ kind: string }> } };
            };
            return packet.user.telemetry.errors.some((e) => e.kind === "sudden_death");
        }));
        // Sudden-death pushed AFTER turn 3 → surfaces in turn 4's packet.
        // Pushed AFTER turn 4 → surfaces in turn 5's packet.
        assert.deepEqual(turnPackets, [false, false, false, true, true]);
    } finally { await db.close(); }
});

// Rail #38: strike system. Hard outcomes accumulate consecutive strikes;
// soft outcomes (404, 501) and clean turns reset the streak.

test("Engine.runLoop: three consecutive hard failures abandon at 499 with strike_threshold reason", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // EDIT log:// → 403 (writableBy denial = hard). SEND[102] keeps loop going.
        const denied = (): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("log", "/x"),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextSize: 100000,
            responses: Array.from({ length: 5 }, () => response([denied(), sendStmt(102, "going")])),
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 10, maxStrikes: 3,
        });
        assert.equal(result.finalStatus, 499);
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.hitMaxTurns, false);
        assert.equal(result.turnIds.length, 3, "abandoned on the 3rd consecutive struck turn");
    } finally { await db.close(); }
});

test("Engine.runLoop: soft failures (404) do NOT accumulate strikes", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // READ a missing unknown:// path → 404 (soft). With maxStrikes=2 and
        // 4 consecutive soft turns, no abandon should fire.
        // Vary path each turn to keep rail #39 cycle detection orthogonal
        // (per rummy's same-pattern test).
        const readMissing = (suffix: string): ReadStatement => ({
            op: "READ", suffix: "", signal: null,
            target: urlPath("unknown", `/not-there-${suffix}`),
            lineMarker: null, body: null, position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([readMissing("a"), sendStmt(102, "1")]),
                response([readMissing("b"), sendStmt(102, "2")]),
                response([readMissing("c"), sendStmt(102, "3")]),
                response([readMissing("d"), sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.finalStatus, 200);
        assert.equal(result.reason, "external");
        assert.equal(result.turnIds.length, 4);
    } finally { await db.close(); }
});

test("Engine.runLoop: clean turn between hard failures resets the streak", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("log", "/x"),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        const goodEdit = (p: string): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("known", p),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        // maxStrikes=2. Pattern: hard, clean, hard, hard, done.
        // After turn 1: streak=1. After turn 2: streak=0 (reset). After
        // turn 3: streak=1. After turn 4: streak=2 → abandon.
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([denied(), sendStmt(102, "1")]),
                response([goodEdit("/ok"), sendStmt(102, "2")]),
                response([denied(), sendStmt(102, "3")]),
                response([denied(), sendStmt(102, "4")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.finalStatus, 499);
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 4, "clean turn 2 reset streak; abandon fired on turn 4");
    } finally { await db.close(); }
});

test("Engine.runLoop: no_ops turn counts as a hard strike", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // Two empty-ops turns in a row with maxStrikes=2 → abandon on turn 2.
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([]), response([])],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.finalStatus, 499);
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 2);
    } finally { await db.close(); }
});

test("Engine.runLoop: strike telemetry surfaces in next packet with streak count", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("log", "/x"),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([denied(), sendStmt(102, "1")]),
                response([denied(), sendStmt(102, "2")]),
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 10, maxStrikes: 5,
        });
        assert.equal(result.finalStatus, 200);
        // Turn 2's packet should show strike#1 (from turn 1).
        // Turn 3's packet should show strike#2 (from turn 2).
        const t2 = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnIds[1] });
        const t3 = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnIds[2] });
        type StrikeErr = { kind: string; streak: number; maxStrikes: number; reason: string; message: string };
        const t2packet = JSON.parse(t2?.packet ?? "{}") as { user: { telemetry: { errors: StrikeErr[] } } };
        const t3packet = JSON.parse(t3?.packet ?? "{}") as { user: { telemetry: { errors: StrikeErr[] } } };
        const t2strike = t2packet.user.telemetry.errors.find((e) => e.kind === "strike");
        const t3strike = t3packet.user.telemetry.errors.find((e) => e.kind === "strike");
        assert.equal(t2strike?.streak, 1);
        assert.equal(t3strike?.streak, 2);
        // §15.1 contract: every telemetry kind carries a human-readable
        // `message` the model can act on without parsing kind-specific fields.
        assert.match(t2strike?.message ?? "", /strike 1\/5/, "strike message names the streak");
        assert.match(t2strike?.message ?? "", /before abandonment/i, "strike message names the abandonment threshold");
    } finally { await db.close(); }
});

// Rail #39: cycle detection. Identical-fingerprint turns repeated MIN_CYCLES
// times trip the detector, bumping turnErrors (which the strike system reads).

test("Engine.runLoop: 3 identical period-1 turns trip cycle → strikes accumulate", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // Same fingerprint each turn: EDIT known:///fixed + SEND[102].
        // detectCycle fires on turn 3 (period 1, MIN_CYCLES=3) → turnErrors++
        // → strike. After turn 3: streak=1. After 4 + 5: streak=3 → ABANDON.
        const provider = new Mock({
            contextSize: 100000,
            responses: Array.from({ length: 8 }, () => response([editStmt("/fixed", "v"), sendStmt(102, "go")])),
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 20, maxStrikes: 3, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.finalStatus, 499);
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 5, "cycle fires on turn 3; 3 consecutive cycle strikes (3, 4, 5) abandon");
    } finally { await db.close(); }
});

test("Engine.runLoop: varied per-turn fingerprints don't trip cycle detection", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // Vary EDIT path each turn → distinct fingerprints → no cycle.
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([editStmt("/a", "1"), sendStmt(102, "1")]),
                response([editStmt("/b", "2"), sendStmt(102, "2")]),
                response([editStmt("/c", "3"), sendStmt(102, "3")]),
                response([editStmt("/d", "4"), sendStmt(102, "4")]),
                response([editStmt("/e", "5"), sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 10, maxStrikes: 2, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.finalStatus, 200);
        assert.equal(result.turnIds.length, 5);
    } finally { await db.close(); }
});

test("Engine.runLoop: period-2 alternating cycle detected after 6 turns", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // Pattern: A, B, A, B, A, B, A, B... detectCycle k=2 needs 6 turns.
        // After turn 6: cycle detected → strike streak=1. maxStrikes=2 →
        // turn 7 still cycles → streak=2 → ABANDON.
        const A = (): EditStatement => editStmt("/A", "v");
        const B = (): EditStatement => editStmt("/B", "v");
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([A(), sendStmt(102, "1")]),
                response([B(), sendStmt(102, "2")]),
                response([A(), sendStmt(102, "3")]),
                response([B(), sendStmt(102, "4")]),
                response([A(), sendStmt(102, "5")]),
                response([B(), sendStmt(102, "6")]),
                response([A(), sendStmt(102, "7")]),
                response([B(), sendStmt(102, "8")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 20, maxStrikes: 2, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.finalStatus, 499);
        assert.equal(result.reason, "strike_threshold");
        assert.ok(result.turnIds.length >= 6 && result.turnIds.length <= 8, `period-2 cycle abandons in the 7th-8th turn (got ${result.turnIds.length})`);
    } finally { await db.close(); }
});

test("Engine.runLoop: cycle telemetry surfaces with period and pattern", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // Plenty of responses so Mock doesn't exhaust before abandon.
        const provider = new Mock({
            contextSize: 100000,
            responses: Array.from({ length: 20 }, () => response([editStmt("/x", "v"), sendStmt(102, "go")])),
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 20, maxStrikes: 10, minCycles: 3, maxCyclePeriod: 4,
        });
        // Turn 4's packet is built BEFORE turn 4 dispatch; it drains telemetry
        // pushed during turn 3 (when cycle fired).
        const t4 = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnIds[3] });
        const packet = JSON.parse(t4?.packet ?? "{}") as {
            user: { telemetry: { errors: Array<{ kind: string; period?: number; cycles?: number }> } };
        };
        const cycleEntry = packet.user.telemetry.errors.find((e) => e.kind === "cycle");
        assert.ok(cycleEntry, "turn 4's packet has cycle telemetry from turn 3 detection");
        assert.equal(cycleEntry?.period, 1);
        assert.equal(cycleEntry?.cycles, 3);
    } finally { await db.close(); }
});

test("Engine.runLoop: sudden_death silent when loop terminates cleanly inside the window", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // maxTurns=5, maxStrikes=2 → threshold=3. Model emits SEND[200] on
        // turn 3, so the warning is buffered but the loop terminates before
        // any turn-4 packet build drains it. No leak; buffer just gets gc'd.
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([sendStmt(102, "1")]),
                response([sendStmt(102, "2")]),
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, messages: [], maxTurns: 5, maxStrikes: 2,
        });
        assert.equal(result.hitMaxTurns, false);
        assert.equal(result.finalStatus, 200);
        // None of turns 1-3 should have seen sudden_death in their packet.
        for (const id of result.turnIds) {
            const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id });
            const packet = JSON.parse(row?.packet ?? "{}") as {
                user: { telemetry: { errors: Array<{ kind: string }> } };
            };
            const sd = packet.user.telemetry.errors.filter((e) => e.kind === "sudden_death");
            assert.equal(sd.length, 0, `turn ${id} should not see sudden_death`);
        }
    } finally { await db.close(); }
});

test("Engine.runTurn: telemetry buffer drains — failure shows once, then clears", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([]),                                          // turn 1: empty ops
                response([editStmt("/b", "2"), sendStmt(102, "go")]),  // turn 2: clean (drains buffer)
                response([editStmt("/c", "3"), sendStmt(200, "ok")]),  // turn 3: clean
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t3.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as {
            user: { telemetry: { errors: Array<{ kind: string }> } };
        };
        const noOpsErrors = packet.user.telemetry.errors.filter((e) => e.kind === "no_ops");
        assert.equal(noOpsErrors.length, 0, "no_ops drained at turn 2; turn 3 doesn't replay it");
    } finally { await db.close(); }
});

test("Engine.runTurn: assistantRaw passes through into turn.packet.assistantRaw", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const raw = { vendor: "anthropic", id: "msg_xyz" };
        const provider = new Mock({
            contextSize: 100000,
            responses: [{
                assistant: { content: "", ops: [sendStmt(200, "")], reasoning: null },
                assistantRaw: raw,
            }],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { assistantRaw: { vendor: string; id: string } };
        assert.deepEqual(packet.assistantRaw, raw);
    } finally { await db.close(); }
});

test("Engine.runTurn: sequence increments across multiple turn calls in the same loop", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([sendStmt(102, "1")]),
                response([sendStmt(102, "2")]),
                response([sendStmt(200, "3")]),
            ],
        });
        const t1 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const seqs = await (db.test_list_turns_in_loop as PrepMethod).all<{ id: number; sequence: number }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3]);
        assert.deepEqual([t1.turnId, t2.turnId, t3.turnId], seqs.map((s) => s.id));
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200, "loop terminal after final SEND[200]");
    } finally { await db.close(); }
});

test("Engine.runTurn: multi-SEND turn — last SEND wins on turn.status", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([sendStmt(102, "first"), sendStmt(200, "last")])],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        assert.equal(result.status, 200);
        const turnStatus = (await (db.test_get_turn_status as PrepMethod).get<{ status: number }>({ id: result.turnId }))?.status;
        assert.equal(turnStatus, 200);
    } finally { await db.close(); }
});

// SPEC §15 packet.system.log — chronological action-entries for the loop.
// Task #44.

test("Engine.runTurn: packet.system.log on first turn contains the prompt entry", async () => {
    // Turn-as-container: turn 1 opens with the prompt written as a real
    // system-origin EDIT against plurnk://prompt/<loop_id> at
    // sequence=1 (1-based). When #buildLog snapshots the log for
    // THIS turn's packet, the prompt is already there. The 2 model ops
    // dispatch AFTER the packet builds, so they don't appear in this
    // turn's snapshot — they'll surface in turn 2's snapshot.
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")])],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { system: { log: Array<{ coordinate: string; op: string; origin: string; target?: { scheme: string | null; pathname: string | null } }> } };
        assert.equal(packet.system.log.length, 1);
        assert.equal(packet.system.log[0].coordinate, "1/1/1");
        assert.equal(packet.system.log[0].op, "EDIT");
        assert.equal(packet.system.log[0].origin, "system");
        assert.equal(packet.system.log[0].target?.scheme, "plurnk");
        assert.equal(packet.system.log[0].target?.pathname, `prompt/${loopId}`);
    } finally { await db.close(); }
});

test("Engine.runTurn: packet.system.log captures prior turn's actions on second turn", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([editStmt("/a", "1"), sendStmt(102, "keep going")]),
                response([editStmt("/b", "2"), sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as {
            system: { log: Array<{ coordinate: string; op: string; status: number; target: { scheme: string | null; pathname: string | null }; origin: string }> };
        };
        // Turn 2 packet sees: prompt at 1/1/1 (plurnk://) + 2 model ops at 1/1/2 + 1/1/3
        assert.equal(packet.system.log.length, 3);
        assert.equal(packet.system.log[0].coordinate, "1/1/1");
        assert.equal(packet.system.log[0].op, "EDIT");
        assert.equal(packet.system.log[0].origin, "system");
        assert.equal(packet.system.log[0].target.scheme, "plurnk");
        assert.equal(packet.system.log[1].coordinate, "1/1/2");
        assert.equal(packet.system.log[1].op, "EDIT");
        assert.equal(packet.system.log[1].status, 201);
        assert.equal(packet.system.log[1].target.scheme, "known");
        assert.equal(packet.system.log[1].target.pathname, "/a");
        assert.equal(packet.system.log[2].coordinate, "1/1/3");
        assert.equal(packet.system.log[2].op, "SEND");
        assert.equal(packet.system.log[2].status, 102);
    } finally { await db.close(); }
});

test("Engine.runTurn: packet.system.log JSON rx body is parsed (mimetype_rx=application/json)", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([editStmt("/x", "v"), sendStmt(102, "more")]),
                response([sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { system: { log: Array<{ op: string; rx: { status?: number; entryId?: number } | string }> } };
        // index 0 = prompt EDIT (plurnk://); index 1 = first model EDIT
        const firstEdit = packet.system.log[1];
        assert.equal(firstEdit.op, "EDIT");
        const rx = firstEdit.rx as { status: number; entryId?: number };
        assert.equal(rx.status, 201);
        assert.ok(typeof rx.entryId === "number", "entryId hydrated from parsed JSON rx");
    } finally { await db.close(); }
});

// SPEC §15.1 — action-bound failures mirror into next packet's telemetry.errors[].
// Task #49.

test("Engine.runTurn: telemetry.errors empty on first turn", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")])],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { user: { telemetry: { errors: object[] } } };
        assert.deepEqual(packet.user.telemetry.errors, []);
    } finally { await db.close(); }
});

test("Engine.runTurn: previous-turn 403 (writableBy denial) surfaces in next packet's telemetry.errors[]", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // Model attempts to EDIT log:// — denied 403 (Log.writableBy=['system']).
        const denied: EditStatement = {
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("log", "/illegal"),
            lineMarker: null, body: "x", position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([denied, sendStmt(102, "keep going")]),
                response([sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as {
            user: { telemetry: { errors: Array<{ kind: string; coordinate: string; op: string; target: string; status: number; message: string }> } };
        };
        assert.equal(packet.user.telemetry.errors.length, 1, "1 failure mirrored from turn 1");
        const [err] = packet.user.telemetry.errors;
        assert.equal(err.kind, "action_failure");
        // Turn-as-container, 1-based: prompt at 1/1/1; model's EDIT shifts to 1/1/2.
        assert.equal(err.coordinate, "1/1/2");
        assert.equal(err.op, "EDIT");
        assert.equal(err.target, "log:///illegal");
        assert.equal(err.status, 403);
        assert.match(err.message, /writer 'model'.*'log'/);
    } finally { await db.close(); }
});

test("Engine.runTurn: telemetry.errors only includes IMMEDIATELY previous turn (not older)", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const denied: EditStatement = {
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("log", "/a"),
            lineMarker: null, body: "x", position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([denied, sendStmt(102, "t1 had a failure")]),
                response([editStmt("/ok", "v"), sendStmt(102, "t2 was clean")]),
                response([sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });   // t1: 1 failure
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });   // t2: clean
        const t3 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t3.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { user: { telemetry: { errors: object[] } } };
        assert.deepEqual(packet.user.telemetry.errors, [], "t3 mirrors t2 only (clean); t1's failure stays in log://, off-screen");
    } finally { await db.close(); }
});
