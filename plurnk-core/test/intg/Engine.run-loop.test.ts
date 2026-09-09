import { dispositionStmt } from "./_dsl.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, seedEntryWithChannel } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null,
    target: urlPath("worker", pathname),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

const contentResponse = (content: string): MockResponse => ({
    assistant: { content, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "test prompt");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, workspaceId, workerId, loopId };
};

test("Engine.runLoop: three-turn loop terminating on DONE", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/a", "1"), dispositionStmt("in_progress", "continuing")]),
                response([editStmt("/b", "2"), dispositionStmt("in_progress", "still going")]),
                response([editStmt("/c", "3"), dispositionStmt("completed", "done")]),
                // {§send-premature-terminate} — the third edit's receipt refuses that [200]; the observation turn concludes.
                response([dispositionStmt("completed", "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "do three steps" }],
        });
        assert.equal(result.turnIds.length, 5, "packetless initialization precedes three edit turns and the observation turn");
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);

        const entryCount = (await db.test_count_entries.get<{ n: number }>())?.n;
        // Three known entries, prompt:///<loop>/<N>, and the turn-0 prompt archive; no manifest entry exists.
        assert.equal(entryCount, 5, "the entries counted before, plus the turn-0 prompt archive");

        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200);
    } finally { await db.close(); }
});

test("Engine.runLoop: maxTurns hit — force-terminate with 429 and hitMaxTurns flag", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            // Each turn does real work (distinct EDIT) then continues — a bare NEXT is now an
            // idle-strike ({§send} the terminal contract); distinct paths keep the cycle rail quiet too.
            responses: Array.from({ length: 10 }, (_, i) => response([editStmt(`/t${i}`, "x"), dispositionStmt("in_progress", "more")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "never terminate" }],
        });
        assert.equal(result.turnIds.length, 4, "packetless initialization does not consume the three-model-turn ceiling");
        assert.equal(result.result.status, 429, "max_turns → 429 Too Many Requests");
        assert.equal(result.hitMaxTurns, true);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 429);
    } finally { await db.close(); }
});

test("maxTurns=-1 disables the turn terminator — loop ends on SEND, not a cap", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Four non-terminal turns then DONE. A positive cap of 3 would
        // force-terminate at turn 3 (429); -1 = no cap, so the loop runs all
        // five and ends gracefully on the model's SEND. (A naive `length >= -1`
        // terminator would also wrongly stop at turn 1 — this guards that too.)
        const provider = new Mock({
            contextWindow: 100000,
            // Non-terminal turns carry a work op (distinct EDIT) so they're real continues, not
            // idle-strikes ({§send} the terminal contract); the final turn terminates on DONE.
            responses: [
                response([editStmt("/1", "x"), dispositionStmt("in_progress", "1")]),
                response([editStmt("/2", "x"), dispositionStmt("in_progress", "2")]),
                response([editStmt("/3", "x"), dispositionStmt("in_progress", "3")]),
                response([editStmt("/4", "x"), dispositionStmt("in_progress", "4")]),
                response([dispositionStmt("completed", "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: -1,
            messages: [{ role: "user", content: "run until I say done" }],
        });
        assert.equal(result.turnIds.length, 6, "initialization plus all five model turns — no turn cap");
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: repeated identical TASK-only turns remain subject to the cycle rail", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // {§engine-cycle-evidence}
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, () => contentResponse(
                "\n```TASK\n[{\"content\":\"idling\",\"status\":\"in_progress\"}]\n```",
            )),
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 508, "identical inventory repetition is a cycle, not an idle-operation violation");
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.equal(result.reason, "strike_threshold");
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.deepEqual(errors, [], "the cycle rail does not invent an idle-operation error");
    } finally { await db.close(); }
});

test("Engine.runLoop: premature terminate (200 over a live stream) downgrades to a continue + steers", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Seed a live stream the worker holds: an open subscription (closed_at NULL) against a real entry.
        const entryId = await seedEntryWithChannel(db, { workspaceId, ownerId: workerId, pathname: "/live-stream" });
        await db.open_subscription.get<{ id: number }>({ worker_id: workerId, entry_id: entryId, scheme: "exec", handle: "live-1" });
        const provider = new Mock({ contextWindow: 100000, responses: [
            response([dispositionStmt("completed", "all done")]),   // turn 1: a live stream makes this premature → downgraded to 102 + steer
            response([dispositionStmt("failed", "abandoning")]),  // turn 2: 499 is the model-decided exit the contract allows over a live stream
        ] });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.turnIds.length, 3, "initialization plus two model turns prove the premature 200 was not honored");
        assert.equal(result.result.status, 499, "the loop ended on the model's 499, never the premature 200");
        // The premature steer is a terse op='error' log row (409 Premature Termination); its derived
        // LogCoordinate pointer reaches the model on the next packet — the guidance lives in the packet.
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds[2] });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.match(packetSection(packet, "errors"), /"status":409,"path":"log:\/\/\/[^"]+\/TASK"/, "the premature SEND failure surfaced as a terse log-coordinate pointer");
    } finally { await db.close(); }
});

test("Engine.runLoop: terminates immediately if loop.status is already non-102", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        await new LoopLifecycle(db).finish(loopId, { status: 200 });
        const provider = new Mock({ contextWindow: 100000, responses: [response([dispositionStmt("completed", "")])] });
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

test("Engine.runLoop: a durable 202 park outranks a later abort observation", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        await db.test_set_loop_status.run({
            id: loopId,
            status: 202,
            terminal_result: null,
        });
        const controller = new AbortController();
        controller.abort("daemon_stopping");
        const provider = new Mock({ contextWindow: 100000, responses: [] });

        const result = await engine.runLoop({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [],
            signal: controller.signal,
        });

        assert.equal(result.result.status, 202);
        assert.equal(result.reason, "external");
        assert.deepEqual(result.turnIds, []);
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
            202,
            "shutdown cannot launder a committed park into cancellation",
        );
    } finally { await db.close(); }
});

test("Engine.runLoop: 499 model-emitted termination", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([dispositionStmt("in_progress", "thinking")]), response([dispositionStmt("failed", "giving up")])],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "may abort" }],
        });
        assert.equal(result.turnIds.length, 3, "packetless initialization precedes both model turns");
        assert.equal(result.result.status, 499);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: cross-turn state — turn 2 sees what turn 1 wrote", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const readStmt = (pathname: string) => ({
            metadata: null,
            op: "READ" as const, annotation: null,
            target: urlPath("worker", pathname),
            lineMarker: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/state", "from turn 1"), dispositionStmt("in_progress", "stored")]),
                // READ continues (NEXT); its result enters turn 3, where it can be observed.
                response([readStmt("/state"), dispositionStmt("in_progress", "reading")]),
                response([dispositionStmt("completed", "retrieved")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "store then retrieve" }],
        });
        assert.equal(result.turnIds.length, 4, "packetless initialization precedes three model turns");
        const readLog = await db.test_read_log_entries_for_turn_by_op.get<{ status_rx: number }>({ turn_id: result.turnIds[2], op: "READ" });
        assert.equal(readLog?.status_rx, 200, "READ in turn 2 found the entry written in turn 1");
    } finally { await db.close(); }
});

test("Engine.runLoop: signal abort between turns throws AbortError", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const controller = new AbortController();
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([dispositionStmt("in_progress", "1")]), response([dispositionStmt("in_progress", "2")]), response([dispositionStmt("completed", "3")])],
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
                response([dispositionStmt("in_progress", "1")]),
                response([dispositionStmt("in_progress", "2")]),
                response([dispositionStmt("completed", "3")]),
            ],
        });
        await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        const seqs = await db.test_list_turns_in_loop.all<{ sequence: number }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3, 4]);
    } finally { await db.close(); }
});

test("a strike-threshold abandonment names itself in its exact terminal Problem", async () => {
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    try {
        const workspaceId = await insertWorkspace(db, `ws-strike-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "strike out");
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 5 }, (_, i) => contentResponse(
            `\`\`\`EDIT (worker:///note-${i})\nx\n\`\`\``,
        )) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 500, "struck out to the engine's 500");

        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.equal(result.result.problem?.turns, 2);
        assert.equal(result.result.problem?.retryable, false);
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
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 4 }, () => response([dispositionStmt("in_progress", "working")])) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 2, maxStrikes: 99, messages: [] });
        assert.equal(result.result.status, 429);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/max-turns");
        assert.match(result.result.problem?.detail ?? "", /turn ceiling/i);
        assert.equal(result.result.problem?.instance, `loop:///${loopId}`);
    } finally { await db.close(); }
});
