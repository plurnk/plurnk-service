import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, PlurnkStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Mock from "../../src/providers/Mock.ts";
import type { MockResponse } from "../../src/providers/Mock.ts";
import { openMigrated, seedEnvelope, insertLoop, insertTurn } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const editStmt = (pathname: string, body: string, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags,
    path: urlPath("known", pathname),
    lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path: null, lineMarker: null,
    body: { raw: body, json: null }, position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[], content: string = ""): MockResponse => ({
    assistant: { tokens: 0, content, ops, reasoning: null },
});

const dispatchTurn = async (
    engine: Engine, provider: Mock, db: DatabaseSync,
    ctx: { sessionId: number; runId: number; loopId: number },
): Promise<{ turnId: number; statuses: number[] }> => {
    const { assistant } = await provider.generate({ prompt: "" });
    const seq = (db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = ?").get(ctx.loopId) as { next: number }).next;
    const sendOp = assistant.ops.find((o): o is SendStatement => o.op === "SEND");
    const turnStatus = sendOp?.signal ?? 200;
    const turnId = insertTurn(db, ctx.loopId, seq, turnStatus);
    const statuses: number[] = [];
    for (const [actionIndex, statement] of assistant.ops.entries()) {
        const result = await engine.dispatch({
            statement, sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId,
            turnId, actionIndex, origin: "model",
        });
        statuses.push(result.status);
    }
    return { turnId, statuses };
};

test("e2e: single-turn EDIT + SEND — entry created, log rows populated, statuses match", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelopeNoTurn(db, "ws-e2e-single");
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/france/capital", "Paris", ["france"]), sendStmt(200, "answered")])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await dispatchTurn(engine, provider, db, env);
        assert.deepEqual(result.statuses, [201, 400], "EDIT created → 201; SEND with null path → 400 for now (SEND-broadcast handling is future work)");

        const entry = db.prepare("SELECT pathname FROM entries WHERE scheme = 'known'").get() as { pathname: string };
        assert.equal(entry.pathname, "/france/capital");

        const logRows = db.prepare("SELECT op, action_index, status_rx, target_pathname FROM log_entries WHERE turn_id = ? ORDER BY action_index").all(result.turnId) as { op: string; action_index: number; status_rx: number; target_pathname: string | null }[];
        assert.equal(logRows.length, 2);
        assert.equal(logRows[0]?.op, "EDIT");
        assert.equal(logRows[0]?.action_index, 0);
        assert.equal(logRows[0]?.status_rx, 201);
        assert.equal(logRows[0]?.target_pathname, "/france/capital");
        assert.equal(logRows[1]?.op, "SEND");
        assert.equal(logRows[1]?.action_index, 1);
        assert.equal(logRows[1]?.status_rx, 400);
        assert.equal(logRows[1]?.target_pathname, null);
    } finally { db.close(); }
});

test("e2e: three EDITs in one turn — action_index 0/1/2, three entries written", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelopeNoTurn(db, "ws-e2e-three");
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([
                editStmt("/a", "1"), editStmt("/b", "2"), editStmt("/c", "3"),
                sendStmt(102, "more"),
            ])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await dispatchTurn(engine, provider, db, env);
        assert.deepEqual(result.statuses, [201, 201, 201, 400]);

        const entries = db.prepare("SELECT pathname FROM entries WHERE scheme = 'known' ORDER BY pathname").all() as { pathname: string }[];
        assert.deepEqual(entries.map((e) => e.pathname), ["/a", "/b", "/c"]);

        const indices = db.prepare("SELECT action_index FROM log_entries WHERE turn_id = ? ORDER BY action_index").all(result.turnId) as { action_index: number }[];
        assert.deepEqual(indices.map((r) => r.action_index), [0, 1, 2, 3]);
    } finally { db.close(); }
});

test("e2e: cross-turn state — turn 2 sees entry written in turn 1", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelopeNoTurn(db, "ws-e2e-multi");
        const readStmt = (pathname: string): PlurnkStatement => ({
            op: "READ", suffix: "", signal: null,
            path: urlPath("known", pathname),
            lineMarker: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                response([editStmt("/state", "from turn 1"), sendStmt(102, "continuing")]),
                response([readStmt("/state"), sendStmt(200, "done")]),
            ],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const turn1 = await dispatchTurn(engine, provider, db, env);
        const turn2 = await dispatchTurn(engine, provider, db, env);
        assert.notEqual(turn1.turnId, turn2.turnId);
        assert.deepEqual(turn1.statuses, [201, 400]);
        assert.deepEqual(turn2.statuses, [200, 400], "READ → 200; SEND with null path → 400 placeholder");

        const turn2Reads = db.prepare("SELECT action_index, status_rx, target_pathname FROM log_entries WHERE turn_id = ? AND op = 'READ'").all(turn2.turnId) as { action_index: number; status_rx: number; target_pathname: string }[];
        assert.equal(turn2Reads.length, 1);
        assert.equal(turn2Reads[0]?.action_index, 0, "action_index resets per turn");
        assert.equal(turn2Reads[0]?.status_rx, 200);
        assert.equal(turn2Reads[0]?.target_pathname, "/state");
    } finally { db.close(); }
});

test("e2e: Mock queue exhaustion throws after expected runs", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelopeNoTurn(db, "ws-e2e-exhaust");
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/only", "x"), sendStmt(200, "")])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await dispatchTurn(engine, provider, db, env);
        await assert.rejects(() => dispatchTurn(engine, provider, db, env), /Mock provider exhausted/);
    } finally { db.close(); }
});

test("e2e: visibility row from EDIT survives into subsequent reads", async () => {
    const db = await openMigrated();
    try {
        const env = seedEnvelopeNoTurn(db, "ws-e2e-vis");
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/vis", "v"), sendStmt(102, "")])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await dispatchTurn(engine, provider, db, env);
        const vis = db.prepare("SELECT indexed FROM visibility WHERE run_id = ? AND channel = 'body'").get(env.runId) as { indexed: number };
        assert.equal(vis.indexed, 1, "Known.edit's visibility row sets indexed=1 by default");
    } finally { db.close(); }
});

const seedEnvelopeNoTurn = (db: DatabaseSync, label: string): { sessionId: number; runId: number; loopId: number } => {
    const { sessionId, runId } = seedEnvelope(db, label);
    const loopId = insertLoop(db, runId, 2, "another loop");
    return { sessionId, runId, loopId };
};
