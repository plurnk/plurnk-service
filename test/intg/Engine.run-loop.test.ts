import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
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

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "test prompt");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, sessionId, runId, loopId };
};

test("Engine.runLoop: three-turn loop terminating on SEND[200]", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([editStmt("/a", "1"), sendStmt(102, "continuing")]),
                response([editStmt("/b", "2"), sendStmt(102, "still going")]),
                response([editStmt("/c", "3"), sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId,
            messages: [{ role: "user", content: "do three steps" }],
        });
        assert.equal(result.turnIds.length, 3);
        assert.equal(result.finalStatus, 200);
        assert.equal(result.hitMaxTurns, false);

        const entryCount = (await (db.test_count_entries as PrepMethod).get<{ n: number }>())?.n;
        // 3 known entries + plurnk://prompt/<loop_id> + plurnk://manifest.json
        assert.equal(entryCount, 5);

        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200);
    } finally { await db.close(); }
});

test("Engine.runLoop: maxTurns hit — force-terminate with 499 and hitMaxTurns flag", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: Array.from({ length: 10 }, () => response([sendStmt(102, "more")])),
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "never terminate" }],
        });
        assert.equal(result.turnIds.length, 3);
        assert.equal(result.finalStatus, 499);
        assert.equal(result.hitMaxTurns, true);
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 499);
    } finally { await db.close(); }
});

test("[§12-max-turns-ceiling] maxTurns=-1 disables the turn terminator — loop ends on SEND, not a cap", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        // Four non-terminal turns then SEND[200]. A positive cap of 3 would
        // force-terminate at turn 3 (499); -1 = no cap, so the loop runs all
        // five and ends gracefully on the model's SEND. (A naive `length >= -1`
        // terminator would also wrongly stop at turn 1 — this guards that too.)
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([sendStmt(102, "1")]),
                response([sendStmt(102, "2")]),
                response([sendStmt(102, "3")]),
                response([sendStmt(102, "4")]),
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: -1,
            messages: [{ role: "user", content: "run until I say done" }],
        });
        assert.equal(result.turnIds.length, 5, "ran all five turns — no turn cap");
        assert.equal(result.finalStatus, 200);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: terminates immediately if loop.status is already non-102", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        await (db.test_set_loop_status as PrepMethod).run({ status: 200, id: loopId });
        const provider = new Mock({ contextSize: 100000, responses: [response([sendStmt(200, "")])] });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId,
            messages: [],
        });
        assert.deepEqual(result.turnIds, []);
        assert.equal(result.finalStatus, 200);
        assert.equal(result.hitMaxTurns, false);
        assert.equal(provider.remaining, 1, "provider untouched");
    } finally { await db.close(); }
});

test("Engine.runLoop: 499 model-emitted termination", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([sendStmt(102, "thinking")]), response([sendStmt(499, "giving up")])],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId,
            messages: [{ role: "user", content: "may abort" }],
        });
        assert.equal(result.turnIds.length, 2);
        assert.equal(result.finalStatus, 499);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: cross-turn state — turn 2 sees what turn 1 wrote", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const readStmt = (pathname: string) => ({
            op: "READ" as const, suffix: "", signal: null,
            target: urlPath("known", pathname),
            lineMarker: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([editStmt("/state", "from turn 1"), sendStmt(102, "stored")]),
                response([readStmt("/state"), sendStmt(200, "retrieved")]),
            ],
        });
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId,
            messages: [{ role: "user", content: "store then retrieve" }],
        });
        assert.equal(result.turnIds.length, 2);
        const readLog = await (db.test_read_log_entries_for_turn_by_op as PrepMethod).get<{ status_rx: number }>({ turn_id: result.turnIds[1], op: "READ" });
        assert.equal(readLog?.status_rx, 200, "READ in turn 2 found the entry written in turn 1");
    } finally { await db.close(); }
});

test("[§2.2-signal-wired] Engine.runLoop: signal abort between turns throws AbortError", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const controller = new AbortController();
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([sendStmt(102, "1")]), response([sendStmt(102, "2")]), response([sendStmt(200, "3")])],
        });
        controller.abort();
        await assert.rejects(
            () => engine.runLoop({ provider, sessionId, runId, loopId, messages: [], signal: controller.signal }),
            { name: "AbortError" },
        );
    } finally { await db.close(); }
});

test("Engine.runLoop: turn sequence numbers monotonic", async () => {
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
        await engine.runLoop({ provider, sessionId, runId, loopId, messages: [] });
        const seqs = await (db.test_list_turns_in_loop as PrepMethod).all<{ sequence: number }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3]);
    } finally { await db.close(); }
});
