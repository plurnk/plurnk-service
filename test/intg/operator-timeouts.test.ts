// §operator-config-rpc-timeout + §operator-config-loop-timeout — the two operator wall-clocks.
// The RPC deadline answers -32007 for a non-longRunning handler that never returns; the loop
// wall rules a legible 504 terminal instead of leaving a run to an outside kill.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import MethodRegistry from "../../src/server/MethodRegistry.ts";
import ClientConnection from "../../src/server/ClientConnection.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { PrepMethod, Db } from "../../src/core/Db.ts";
import type { DaemonSurface } from "../../src/server/MethodRegistry.ts";
import { sendStmt, editStmt, localPath } from "./_dsl.ts";

// A ws stand-in: EventEmitter for "message", captured sends. The registered
// handlers never touch ctx, so db/engine/daemon are inert casts.
const wireConnection = (registry: MethodRegistry): { emit: (req: object) => void; replies: object[] } => {
    const ws = Object.assign(new EventEmitter(), {
        readyState: 1,
        send(payload: string) { replies.push(JSON.parse(payload)); },
        terminate() {},
    });
    const replies: object[] = [];
    new ClientConnection({
        ws: ws as never, registry,
        db: {} as Db, engine: {} as Engine, provider: null,
        daemon: {} as DaemonSurface,
        broadcast: () => {},
    });
    return { emit: (req) => ws.emit("message", JSON.stringify(req)), replies };
};

const waitForReply = async (replies: object[]): Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }> => {
    for (let i = 0; i < 200 && replies.length === 0; i++) await delay(10);
    assert.ok(replies.length > 0, "the rpc answered");
    return replies[0] as never;
};

test("[§operator-config-rpc-timeout] a non-longRunning handler past the deadline answers -32007 Timeout", async () => {
    process.env.PLURNK_RPC_TIMEOUT = "60";
    try {
        const registry = new MethodRegistry();
        registry.registerMethod("test.hang", {
            handler: () => new Promise(() => {}), // never settles — the wedge the deadline exists for
            description: "never returns",
        });
        const { emit, replies } = wireConnection(registry);
        emit({ jsonrpc: "2.0", id: 1, method: "test.hang" });
        const reply = await waitForReply(replies);
        assert.equal(reply.error?.code, -32007, "the plurnk Timeout code (§errors)");
        assert.match(reply.error?.message ?? "", /timed out after 60ms/);
    } finally { delete process.env.PLURNK_RPC_TIMEOUT; }
});

test("[§operator-config-rpc-timeout] a longRunning handler outlives the deadline and still answers", async () => {
    process.env.PLURNK_RPC_TIMEOUT = "20";
    try {
        const registry = new MethodRegistry();
        registry.registerMethod("test.slow", {
            longRunning: true, // the proposal-pause exemption — §method-registration-register
            handler: async () => { await delay(80); return { ok: true }; },
            description: "slow but exempt",
        });
        const { emit, replies } = wireConnection(registry);
        emit({ jsonrpc: "2.0", id: 1, method: "test.slow" });
        const reply = await waitForReply(replies);
        assert.deepEqual(reply.result, { ok: true }, "exempt handlers answer past the deadline, no -32007");
    } finally { delete process.env.PLURNK_RPC_TIMEOUT; }
});

test("[§operator-config-loop-timeout] the wall rules a legible 504 loop_timeout terminal", async () => {
    process.env.PLURNK_LOOP_TIMEOUT = "1"; // expires before the first turn settles
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `loop-wall-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "walled");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // Continue turns forever — only the wall ends this loop.
        const provider = new Mock({ contextSize: 100000, responses: Array.from({ length: 50 }, (_, i) => ({ assistant: { content: "", reasoning: null, ops: [editStmt(localPath(`/w${i}`), "x"), sendStmt(102)] } })) });
        const result = await engine.runLoop({ provider, sessionId, runId, loopId, messages: [], maxTurns: 50 });
        assert.equal(result.finalStatus, 504, "the wall's terminal is 504, never an outside kill");
        assert.equal(result.reason, "loop_timeout");
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 504, "the loop row carries the wall terminal");
    } finally {
        delete process.env.PLURNK_LOOP_TIMEOUT;
        await db.close();
    }
});

test("[§operator-config-loop-timeout] the default wall never intrudes — a short loop concludes 200 untouched", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `loop-wall-off-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "quick");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } }] });
        const result = await engine.runLoop({ provider, sessionId, runId, loopId, messages: [] });
        assert.equal(result.finalStatus, 200, "the 24h default is invisible to a normal loop");
    } finally { await db.close(); }
});
