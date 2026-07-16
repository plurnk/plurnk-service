// the retired rpc-timeout contract + §operator-config-loop-timeout — the two operator wall-clocks.
// The RPC deadline answers -32007 for a non-longRunning handler that never returns; the loop
// wall rules a legible 504 terminal instead of leaving a run to an outside kill.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { PrepMethod, Db } from "../../src/core/Db.ts";
import { sendStmt, editStmt, localPath } from "./_dsl.ts";

// A ws stand-in: EventEmitter for "message", captured sends. The registered
// handlers never touch ctx, so db/engine/daemon are inert casts.
const waitForReply = async (replies: object[]): Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }> => {
    for (let i = 0; i < 200 && replies.length === 0; i++) await delay(10);
    assert.ok(replies.length > 0, "the rpc answered");
    return replies[0] as never;
};

test("[§operator-config-loop-timeout] the wall rules a legible 504 loop_timeout terminal", async () => {
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "1"; // expires before the first turn settles
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `loop-wall-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "walled");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // Continue turns forever — only the wall ends this loop.
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 50 }, (_, i) => ({ assistant: { content: "", reasoning: null, ops: [editStmt(localPath(`/w${i}`), "x"), sendStmt(102)] } })) });
        const result = await engine.runLoop({ provider, sessionId, runId, loopId, messages: [], maxTurns: 50 });
        assert.equal(result.finalStatus, 504, "the wall's terminal is 504, never an outside kill");
        assert.equal(result.reason, "loop_timeout");
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 504, "the loop row carries the wall terminal");
    } finally {
        delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
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
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } }] });
        const result = await engine.runLoop({ provider, sessionId, runId, loopId, messages: [] });
        assert.equal(result.finalStatus, 200, "the 24h default is invisible to a normal loop");
    } finally { await db.close(); }
});
