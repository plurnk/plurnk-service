import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, seedEntryWithChannel } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: urlPath("worker", pathname),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "test prompt");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, workspaceId, workerId, loopId };
};

test("Engine.runLoop: three-turn loop terminating on SEND[200]", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/a", "1"), sendStmt(102, "continuing")]),
                response([editStmt("/b", "2"), sendStmt(102, "still going")]),
                response([editStmt("/c", "3"), sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "do three steps" }],
        });
        assert.equal(result.turnIds.length, 3);
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);

        const entryCount = (await db.test_count_entries.get<{ n: number }>())?.n;
        // 3 known entries + plurnk://prompt/<run>/<loop>/<N> (no manifest.json entry — the catalog is FIND-served)
        assert.equal(entryCount, 4);

        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200);
    } finally { await db.close(); }
});

test("Engine.runLoop: maxTurns hit — force-terminate with 429 and hitMaxTurns flag", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            // Each turn does real work (distinct EDIT) then continues — a bare SEND[102] is now an
            // idle-strike (§send the terminal contract); distinct paths keep the cycle rail quiet too.
            responses: Array.from({ length: 10 }, (_, i) => response([editStmt(`/t${i}`, "x"), sendStmt(102, "more")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "never terminate" }],
        });
        assert.equal(result.turnIds.length, 3);
        assert.equal(result.result.status, 429, "max_turns → 429 Too Many Requests");
        assert.equal(result.hitMaxTurns, true);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 429);
    } finally { await db.close(); }
});

test("maxTurns=-1 disables the turn terminator — loop ends on SEND, not a cap", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Four non-terminal turns then SEND[200]. A positive cap of 3 would
        // force-terminate at turn 3 (429); -1 = no cap, so the loop runs all
        // five and ends gracefully on the model's SEND. (A naive `length >= -1`
        // terminator would also wrongly stop at turn 1 — this guards that too.)
        const provider = new Mock({
            contextWindow: 100000,
            // Non-terminal turns carry a work op (distinct EDIT) so they're real continues, not
            // idle-strikes (§send the terminal contract); the final turn terminates on SEND[200].
            responses: [
                response([editStmt("/1", "x"), sendStmt(102, "1")]),
                response([editStmt("/2", "x"), sendStmt(102, "2")]),
                response([editStmt("/3", "x"), sendStmt(102, "3")]),
                response([editStmt("/4", "x"), sendStmt(102, "4")]),
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: -1,
            messages: [{ role: "user", content: "run until I say done" }],
        });
        assert.equal(result.turnIds.length, 5, "ran all five turns — no turn cap");
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: idle turn (102, no work op) steers and strikes — spins out to the engine's 500", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // A bare SEND[102] is a continue that did no work — an idle turn (§send the terminal contract).
        // It steers the model (a hint) and strikes (silently); a model that keeps idling spins out to
        // the engine's 500, never its own 499.
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 5 }, () => response([sendStmt(102, "idling")])) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 500, "idle spin-out is the engine ruling failure, not the model's 499");
        assert.equal(result.turnIds.length, 2, "struck out at maxStrikes:2, well before maxTurns:10");
        // The idle steer is a terse op='error' log row (409 Idle Turn) — its derived LogCoordinate
        // pointer reaches the model; the guidance lives in the packet, not the row.
        let steered = false;
        for (const id of result.turnIds) {
            const row = await db.test_get_packet.get<{ packet: string }>({ id });
            const packet = JSON.parse(row?.packet ?? "{}");
            if (/^\* 409 log:\/\/\/.+\/error$/m.test(packetSection(packet, "errors"))) steered = true;
        }
        assert.ok(steered, "the idle steer surfaced as a terse 409 log-coordinate error pointer");
    } finally { await db.close(); }
});

test("Engine.runLoop: premature terminate (200 over a live stream) downgrades to a continue + steers", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Seed a live stream the worker holds: an open subscription (closed_at NULL) against a real entry.
        const entryId = await seedEntryWithChannel(db, { workspaceId, pathname: "/live-stream" });
        await db.open_subscription.get<{ id: number }>({ worker_id: workerId, entry_id: entryId, scheme: "exec", handle: "live-1" });
        const provider = new Mock({ contextWindow: 100000, responses: [
            response([sendStmt(200, "all done")]),   // turn 1: a live stream makes this premature → downgraded to 102 + steer
            response([sendStmt(499, "abandoning")]),  // turn 2: 499 is the model-decided exit the contract allows over a live stream
        ] });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.turnIds.length, 2, "the premature 200 was downgraded, not honored — the loop ran on");
        assert.equal(result.result.status, 499, "the loop ended on the model's 499, never the premature 200");
        // The premature steer is a terse op='error' log row (409 Premature Termination); its derived
        // LogCoordinate pointer reaches the model on the next packet — the guidance lives in the packet.
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds[1] });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.match(packetSection(packet, "errors"), /^\* 409 log:\/\/\/.+\/SEND$/m, "the premature SEND failure surfaced as a terse log-coordinate pointer");
    } finally { await db.close(); }
});

test("Engine.runLoop: terminates immediately if loop.status is already non-102", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        await new LoopLifecycle(db).finish(loopId, { status: 200 });
        const provider = new Mock({ contextWindow: 100000, responses: [response([sendStmt(200, "")])] });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [],
        });
        assert.deepEqual(result.turnIds, []);
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);
        assert.equal(provider.remaining, 1, "provider untouched");
    } finally { await db.close(); }
});

test("Engine.runLoop: 499 model-emitted termination", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([sendStmt(102, "thinking")]), response([sendStmt(499, "giving up")])],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "may abort" }],
        });
        assert.equal(result.turnIds.length, 2);
        assert.equal(result.result.status, 499);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: cross-turn state — turn 2 sees what turn 1 wrote", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const readStmt = (pathname: string) => ({
            op: "READ" as const, suffix: "", signal: null,
            target: urlPath("worker", pathname),
            lineMarker: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/state", "from turn 1"), sendStmt(102, "stored")]),
                // READ continues (SEND[102]) — its result folds into turn 3, then delivered. (A same-turn
                // READ + SEND[200] is a parser-rejected shape, grammar#51 — no longer an engine gate.)
                response([readStmt("/state"), sendStmt(102, "reading")]),
                response([sendStmt(200, "retrieved")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "store then retrieve" }],
        });
        assert.equal(result.turnIds.length, 3);
        const readLog = await db.test_read_log_entries_for_turn_by_op.get<{ status_rx: number }>({ turn_id: result.turnIds[1], op: "READ" });
        assert.equal(readLog?.status_rx, 200, "READ in turn 2 found the entry written in turn 1");
    } finally { await db.close(); }
});

test("Engine.runLoop: signal abort between turns throws AbortError", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const controller = new AbortController();
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([sendStmt(102, "1")]), response([sendStmt(102, "2")]), response([sendStmt(200, "3")])],
        });
        controller.abort();
        await assert.rejects(
            () => engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], signal: controller.signal }),
            { name: "AbortError" },
        );
    } finally { await db.close(); }
});

test("Engine.runLoop: turn sequence numbers monotonic", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([sendStmt(102, "1")]),
                response([sendStmt(102, "2")]),
                response([sendStmt(200, "3")]),
            ],
        });
        await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        const seqs = await db.test_list_turns_in_loop.all<{ sequence: number }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3]);
    } finally { await db.close(); }
});

test("a strike-threshold abandonment names itself in its exact terminal Problem", async () => {
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    try {
        const workspaceId = await insertWorkspace(db, `ws-strike-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "strike out");
        // Idle turns strike out to the engine's 500 (the run60 shape: repeated failed/no-op turns).
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 5 }, () => response([sendStmt(102, "idling")])) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 500, "struck out to the engine's 500");

        assert.equal(result.result.problem?.type, "https://problems.plurnk.dev/engine/rails/strike-threshold");
        assert.match(result.result.problem?.detail ?? "", /strike threshold was crossed/i);
        assert.equal(result.result.problem?.instance, `loop:///${loopId}`);
    } finally { await db.close(); }
});

test("the full terminal enumeration names itself — max_turns included", async () => {
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    try {
        const workspaceId = await insertWorkspace(db, `ws-terminals-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "run to the ceiling");
        // A model that works forever (non-terminal SENDs) runs into the configured ceiling.
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 4 }, () => response([sendStmt(102, "working")])) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 2, maxStrikes: 99, messages: [] });
        assert.equal(result.result.status, 429);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.dev/engine/rails/max-turns");
        assert.match(result.result.problem?.detail ?? "", /turn ceiling/i);
        assert.equal(result.result.problem?.instance, `loop:///${loopId}`);
    } finally { await db.close(); }
});
