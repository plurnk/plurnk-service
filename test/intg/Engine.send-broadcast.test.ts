import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const sendStmt = (status: number | null, body: string, path: ParsedPath | null = null): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, env, engine };
};

const loopStatus = async (db: Db, loopId: number): Promise<number> => {
    const row = await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId });
    if (row === undefined) throw new Error("loop not found");
    return row.status;
};

test("SEND[200]:done:SEND (null path, terminal success) → loop.status = 200", async () => {
    const { db, env, engine } = await setup();
    try {
        assert.equal(await loopStatus(db, env.loopId), 102, "starts at 102 (continuing)");
        const result = await engine.dispatch({
            statement: sendStmt(200, "done"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(await loopStatus(db, env.loopId), 200);
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ status_rx: number }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 200);
    } finally { await db.close(); }
});

test("SEND[499]:cancelled:SEND → loop.status = 499", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(499, "cancelled"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 499);
        assert.equal(await loopStatus(db, env.loopId), 499);
    } finally { await db.close(); }
});

test("SEND[102]:continuing:SEND → loop.status unchanged (still 102, non-terminal)", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(102, "continuing"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 102);
        assert.equal(await loopStatus(db, env.loopId), 102, "non-terminal status leaves loop continuing");
        const log = await (db.test_first_log_entry_for_turn as PrepMethod).get<{ status_rx: number }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 102);
    } finally { await db.close(); }
});

test("SEND[404]:not found:SEND (non-terminal client error) → loop.status unchanged", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(404, "not found"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 404);
        assert.equal(await loopStatus(db, env.loopId), 102, "404 isn't terminal; loop stays continuing");
    } finally { await db.close(); }
});

test("SEND[200](recipient-path) → still routes to scheme handler (preserves recipient-directed behavior)", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(200, "message", urlPath("wss", "feed/x")),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 501, "wss scheme not registered; falls through to scheme dispatch");
        assert.equal(await loopStatus(db, env.loopId), 102, "directed SEND doesn't update loop.status");
    } finally { await db.close(); }
});

test("SEND with null signal → 400 (no status to apply)", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(null, "no status"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(await loopStatus(db, env.loopId), 102, "no status to bubble; loop unchanged");
    } finally { await db.close(); }
});

test("Multiple SENDs in one turn: last terminal status wins", async () => {
    const { db, env, engine } = await setup();
    try {
        await engine.dispatch({
            statement: sendStmt(102, "first"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(await loopStatus(db, env.loopId), 102);
        await engine.dispatch({
            statement: sendStmt(200, "second-terminal"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        assert.equal(await loopStatus(db, env.loopId), 200, "second SEND was terminal; loop now 200");
    } finally { await db.close(); }
});

test("Successive terminal SENDs: later wins (UPDATE overwrites)", async () => {
    const { db, env, engine } = await setup();
    try {
        await engine.dispatch({
            statement: sendStmt(200, "done"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 0, origin: "model",
        });
        assert.equal(await loopStatus(db, env.loopId), 200);
        await engine.dispatch({
            statement: sendStmt(499, "actually cancel"),
            sessionId: env.sessionId, runId: env.runId, loopId: env.loopId, turnId: env.turnId,
            actionIndex: 1, origin: "model",
        });
        assert.equal(await loopStatus(db, env.loopId), 499, "later 499 overrides earlier 200");
    } finally { await db.close(); }
});
