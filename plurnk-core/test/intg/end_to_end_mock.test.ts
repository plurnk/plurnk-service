import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, SendStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const editStmt = (pathname: string, body: string, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags,
    target: urlPath("worker", pathname),
    lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null, lineMarker: null,
    body: { raw: body, json: null }, position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[], content: string = ""): MockResponse => ({
    assistant: { content, ops, reasoning: null },
});

const seedEnvelopeNoTurn = async (db: Db, label: string): Promise<{ workspaceId: number; workerId: number; loopId: number }> => {
    const workspaceId = await insertWorkspace(db, label);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "main");
    return { workspaceId, workerId, loopId };
};

const dispatchTurn = async (
    engine: Engine, provider: Mock, db: Db,
    ctx: { workspaceId: number; workerId: number; loopId: number },
): Promise<{ turnId: number; statuses: number[] }> => {
    const { assistant } = await provider.generate({ messages: [] });
    const seqRow = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: ctx.loopId });
    if (seqRow === undefined) throw new Error("seq query returned no row");
    const ops = (assistant.ops ?? []) as PlurnkStatement[];
    const sendOp = ops.find((o): o is SendStatement => o.op === "SEND");
    const turnStatus = sendOp?.signal ?? 200;
    const turnId = await insertTurn(db, ctx.loopId, seqRow.next, turnStatus);
    const statuses: number[] = [];
    for (const [i, statement] of ops.entries()) {
        const result = await engine.dispatch({
            statement, workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId,
            turnId, sequence: i + 1, origin: "model",
        });
        statuses.push(result.status);
    }
    return { turnId, statuses };
};

test("e2e: single-turn EDIT + SEND — entry created, log rows populated, statuses match", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-single");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/france/capital", "Paris", ["+france"]), sendStmt(200, "answered")])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await dispatchTurn(engine, provider, db, env);
        assert.deepEqual(result.statuses, [201, 200], "EDIT created → 201; SEND[200] broadcast terminal → 200");

        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: env.workspaceId, scheme: "worker", pathname: "/france/capital",
        });
        assert.ok(entry !== undefined);

        const logRows = await db.test_log_entries_by_turn.all<{ op: string; sequence: number; status_rx: number; pathname: string | null }>({ turn_id: result.turnId });
        assert.equal(logRows.length, 2);
        assert.equal(logRows[0]?.op, "EDIT");
        assert.equal(logRows[0]?.sequence, 1);
        assert.equal(logRows[0]?.status_rx, 201);
        assert.equal(logRows[0]?.pathname, "/france/capital");
        assert.equal(logRows[1]?.op, "SEND");
        assert.equal(logRows[1]?.sequence, 2);
        assert.equal(logRows[1]?.status_rx, 200);
        assert.equal(logRows[1]?.pathname, null);
    } finally { await db.close(); }
});

test("e2e: three EDITs in one turn — sequence 1/2/3, three entries written", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-three");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([
                editStmt("/a", "1"), editStmt("/b", "2"), editStmt("/c", "3"),
                sendStmt(102, "more"),
            ])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await dispatchTurn(engine, provider, db, env);
        assert.deepEqual(result.statuses, [201, 201, 201, 102]);

        const count = (await db.test_count_entries_by_workspace.get<{ n: number }>({ workspace_id: env.workspaceId }))?.n;
        assert.equal(count, 3);

        const indices = await db.test_log_entries_by_turn.all<{ sequence: number }>({ turn_id: result.turnId });
        assert.deepEqual(indices.map((r) => r.sequence), [1, 2, 3, 4]);
    } finally { await db.close(); }
});

test("e2e: cross-turn state — turn 2 sees entry written in turn 1", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-multi");
        const readStmt = (pathname: string): PlurnkStatement => ({
            op: "READ", suffix: "", signal: null,
            target: urlPath("worker", pathname),
            lineMarker: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/state", "from turn 1"), sendStmt(102, "continuing")]),
                // The pending set ({§send-premature-terminate}) forbids READ + [200] in one turn —
                // the retrieval's result folds back next packet. Read, continue, THEN conclude.
                response([readStmt("/state"), sendStmt(102, "reading")]),
                response([sendStmt(200, "done")]),
            ],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const turn1 = await dispatchTurn(engine, provider, db, env);
        const turn2 = await dispatchTurn(engine, provider, db, env);
        const turn3 = await dispatchTurn(engine, provider, db, env);
        assert.notEqual(turn1.turnId, turn2.turnId);
        assert.deepEqual(turn1.statuses, [201, 102]);
        assert.deepEqual(turn2.statuses, [200, 102], "READ → 200; the continue receives the result next turn");
        assert.deepEqual(turn3.statuses, [200], "the conclusion lands clean — nothing pending");

        const turn2Reads = (await db.test_log_entries_by_turn.all<{ sequence: number; status_rx: number; pathname: string; op: string }>({ turn_id: turn2.turnId }))
            .filter((r) => r.op === "READ");
        assert.equal(turn2Reads.length, 1);
        assert.equal(turn2Reads[0]?.sequence, 1, "sequence resets per turn (1-based)");
        assert.equal(turn2Reads[0]?.status_rx, 200);
        assert.equal(turn2Reads[0]?.pathname, "/state");
    } finally { await db.close(); }
});

test("e2e: Mock queue exhaustion throws after the expected provider call", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelopeNoTurn(db, "ws-e2e-exhaust");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/only", "x"), sendStmt(200, "")])],
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await dispatchTurn(engine, provider, db, env);
        await assert.rejects(() => dispatchTurn(engine, provider, db, env), /Mock provider exhausted/);
    } finally { await db.close(); }
});

// (e2e visibility test removed — entries carry no visibility)
