import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath, SendStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const sendStmt = (status: SendStatement["status"], body: string, target: ParsedPath | null = null): SendStatement => ({
    metadata: null,
    op: "SEND", annotation: null, delimiter: "", status, target,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, env, engine };
};

const loopStatus = async (db: Db, loopId: number): Promise<number> => {
    const row = await db.test_get_loop_status.get<{ status: number }>({ id: loopId });
    if (row === undefined) throw new Error("loop not found");
    return row.status;
};

test("## SEND0 (TERM)\ndone (null path, terminal success) → loop.status = 200", async () => {
    const { db, env, engine } = await setup();
    try {
        assert.equal(await loopStatus(db, env.loopId), 102, "starts at 102 (continuing)");
        const result = await engine.dispatch({
            statement: sendStmt(200, "done"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(await loopStatus(db, env.loopId), 200);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 200);
    } finally { await db.close(); }
});

test("## SEND0 (FAIL)\ncancelled → loop.status = 499", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(499, "cancelled"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 499);
        assert.equal(await loopStatus(db, env.loopId), 499);
    } finally { await db.close(); }
});

test("## SEND0 (NEXT)\ncontinuing → loop.status unchanged (still 102, non-terminal)", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(102, "continuing"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 102);
        assert.equal(await loopStatus(db, env.loopId), 102, "non-terminal status leaves loop continuing");
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 102);
    } finally { await db.close(); }
});
test("a recipient SEND routes to the scheme handler and never touches loop.status", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(null, "message", urlPath("wss", "feed/x")),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501, "wss scheme not registered; falls through to scheme dispatch");
        assert.equal(await loopStatus(db, env.loopId), 102, "directed SEND doesn't update loop.status");
    } finally { await db.close(); }
});

test("a targetless SEND without a label is a message to the user: 200, loop unchanged", async () => {
    const { db, env, engine } = await setup();
    try {
        const result = await engine.dispatch({
            statement: sendStmt(null, "no status"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(await loopStatus(db, env.loopId), 102, "a user message never changes the loop");
    } finally { await db.close(); }
});

test("multiple SENDs in one turn: the first terminal concludes the loop", async () => {
    const { db, env, engine } = await setup();
    try {
        await engine.dispatch({
            statement: sendStmt(102, "first"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(await loopStatus(db, env.loopId), 102);
        await engine.dispatch({
            statement: sendStmt(200, "second-terminal"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(await loopStatus(db, env.loopId), 200, "second SEND was terminal; loop now 200");
    } finally { await db.close(); }
});

test("successive terminal SENDs preserve and report the first terminal winner", async () => {
    const { db, env, engine } = await setup();
    try {
        await engine.dispatch({
            statement: sendStmt(200, "done"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(await loopStatus(db, env.loopId), 200);
        const late = await engine.dispatch({
            statement: sendStmt(499, "actually cancel"),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(late.status, 200, "the losing transition reports durable state, not its requested status");
        assert.equal(await loopStatus(db, env.loopId), 200, "terminal state is immutable");
    } finally { await db.close(); }
});
