import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
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
    path: urlPath("known", pathname),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[], content: string = "", tokens: number = 0): MockResponse => ({
    assistant: { tokens, content, ops, reasoning: null },
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

        const logCount = (await (db.test_count_log_entries_by_turn as PrepMethod).get<{ n: number }>({ turn_id: result.turnId }))?.n;
        assert.equal(logCount, 2);

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

test("Engine.runTurn: multi-op turn action_indexes 0..N-1", async () => {
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
        const indices = await (db.test_log_entries_by_turn as PrepMethod).all<{ action_index: number }>({ turn_id: result.turnId });
        assert.deepEqual(indices.map((r) => r.action_index), [0, 1, 2, 3]);
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
        const provider = new Mock({
            contextSize: 100000,
            responses: Array.from({ length: 6 }, () => response([sendStmt(102, "go")])),
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
                assistant: { tokens: 0, content: "", ops: [sendStmt(200, "")], reasoning: null },
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

test("Engine.runTurn: packet.system.log is empty on the first turn (no prior actions)", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")])],
        });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { system: { log: object[] } };
        assert.deepEqual(packet.system.log, [], "first turn: packet snapshot taken pre-dispatch, no prior log_entries");
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
            system: { log: Array<{ coordinate: string; op: string; status: number; target: { scheme: string | null; pathname: string | null } }> };
        };
        assert.equal(packet.system.log.length, 2, "turn 2 packet snapshots turn 1's 2 actions");
        assert.equal(packet.system.log[0].coordinate, "1/1/0");
        assert.equal(packet.system.log[0].op, "EDIT");
        assert.equal(packet.system.log[0].status, 201);
        assert.equal(packet.system.log[0].target.scheme, "known");
        assert.equal(packet.system.log[0].target.pathname, "/a");
        assert.equal(packet.system.log[1].coordinate, "1/1/1");
        assert.equal(packet.system.log[1].op, "SEND");
        assert.equal(packet.system.log[1].status, 102);
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
        const packet = JSON.parse(row?.packet ?? "{}") as { system: { log: Array<{ rx: { status: number; entryId?: number } }> } };
        assert.equal(packet.system.log[0].rx.status, 201);
        assert.ok(typeof packet.system.log[0].rx.entryId === "number", "entryId hydrated from parsed JSON rx");
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
            path: urlPath("log", "/illegal"),
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
        assert.equal(err.coordinate, "1/1/0");
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
            path: urlPath("log", "/a"),
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
