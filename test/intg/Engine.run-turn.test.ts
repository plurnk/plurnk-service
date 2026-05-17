import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Mock from "../../src/providers/Mock.ts";
import type { MockResponse } from "../../src/providers/Mock.ts";
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
    const sessionId = insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = insertRun(db, sessionId);
    const loopId = insertLoop(db, runId, 1, "test prompt");
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

        const turn = db.prepare("SELECT loop_id, sequence, status, usage_completion FROM turns WHERE id = ?").get(result.turnId) as { loop_id: number; sequence: number; status: number; usage_completion: number };
        assert.equal(turn.loop_id, loopId);
        assert.equal(turn.sequence, 1);
        assert.equal(turn.status, 200);
        assert.equal(turn.usage_completion, 42);

        const logCount = (db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE turn_id = ?").get(result.turnId) as { n: number }).n;
        assert.equal(logCount, 2);

        const loopStatus = (db.prepare("SELECT status FROM loops WHERE id = ?").get(loopId) as { status: number }).status;
        assert.equal(loopStatus, 200, "terminal SEND propagated to loop.status");
    } finally { db.close(); }
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
        const packetRaw = (db.prepare("SELECT packet FROM turns WHERE id = ?").get(result.turnId) as { packet: string }).packet;
        const packet = JSON.parse(packetRaw) as { system: { system_definition: string }; user: { prompt: string }; assistant: unknown };
        assert.equal(packet.system.system_definition, "system prompt body");
        assert.equal(packet.user.prompt, "first user msg\n\nsecond user msg");
        assert.ok(packet.assistant !== null);
    } finally { db.close(); }
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
        const indices = db.prepare("SELECT action_index FROM log_entries WHERE turn_id = ? ORDER BY action_index").all(result.turnId) as { action_index: number }[];
        assert.deepEqual(indices.map((r) => r.action_index), [0, 1, 2, 3]);
    } finally { db.close(); }
});

test("Engine.runTurn: throws if assistant.ops has no SEND with numeric status", async () => {
    const { db, engine, sessionId, runId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextSize: 100000,
            responses: [response([editStmt("/x", "y")])],
        });
        await assert.rejects(
            () => engine.runTurn({ provider, sessionId, runId, loopId, messages: [] }),
            /assistant ops contain no SEND/,
        );
        const turnCount = (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
        assert.equal(turnCount, 0, "no turn row should be inserted on malformed assistant");
    } finally { db.close(); }
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
        const packet = JSON.parse((db.prepare("SELECT packet FROM turns WHERE id = ?").get(result.turnId) as { packet: string }).packet) as { assistantRaw: { vendor: string; id: string } };
        assert.deepEqual(packet.assistantRaw, raw);
    } finally { db.close(); }
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
        const seqs = db.prepare("SELECT id, sequence FROM turns WHERE loop_id = ? ORDER BY sequence").all(loopId) as { id: number; sequence: number }[];
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3]);
        assert.deepEqual([t1.turnId, t2.turnId, t3.turnId], seqs.map((s) => s.id));
        assert.equal((db.prepare("SELECT status FROM loops WHERE id = ?").get(loopId) as { status: number }).status, 200, "loop terminal after final SEND[200]");
    } finally { db.close(); }
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
        const turnStatus = (db.prepare("SELECT status FROM turns WHERE id = ?").get(result.turnId) as { status: number }).status;
        assert.equal(turnStatus, 200);
    } finally { db.close(); }
});
