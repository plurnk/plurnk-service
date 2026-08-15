// the retired rpc-timeout contract + {§operator-config-loop-timeout} — the two operator wall-clocks.
// The RPC deadline answers -32007 for a non-longRunning handler that never returns; the loop
// wall rules a legible 504 terminal instead of leaving a worker to an outside kill.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

class AbortBlockingMock extends Mock {
    readonly entered = Promise.withResolvers<void>();

    override async generate(args: Parameters<Mock["generate"]>[0]): Promise<never> {
        args.signal?.throwIfAborted();
        if (args.signal === undefined) throw new Error("AbortBlockingMock requires the engine's loop signal");
        this.entered.resolve();
        return await new Promise<never>((_resolve, reject) => {
            args.signal?.addEventListener("abort", () => reject(args.signal?.reason), { once: true });
        });
    }
}

test("the wall rules a legible 504 loop_timeout terminal", async (t) => {
    const loopTimeoutMs = 60_000;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = String(loopTimeoutMs);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-wall-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "walled");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 50 });
        await provider.entered.promise;
        t.mock.timers.tick(loopTimeoutMs);
        const result = await running;
        assert.equal(result.result.status, 504, "the wall's terminal is 504, never an outside kill");
        assert.equal(result.reason, "loop_timeout");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 504, "the loop row carries the wall terminal");
        const turns = await db.test_list_turns_in_loop.all<{ status: number; packet: string }>({ loop_id: loopId });
        const attempted = turns.at(-1);
        assert.equal(attempted?.status, 504, "an interrupted provider attempt closes with the wall's exact status");
        const packet = JSON.parse(attempted?.packet ?? "{}") as { sections?: unknown; assistant?: unknown };
        assert.ok(Array.isArray(packet.sections), "the interrupted attempt retains its exact request packet");
        assert.equal(packet.assistant, undefined, "the timeout never fabricates an assistant response");
        assert.deepEqual(
            await db.test_error_rows_for_worker.all({ worker_id: workerId }),
            [],
            "the lifecycle timeout never fabricates a provider failure",
        );
    } finally {
        delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        await db.close();
    }
});

test("the default wall never intrudes — a short loop concludes 200 untouched", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-wall-off-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "quick");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] } }] });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.result.status, 200, "the 24h default is invisible to a normal loop");
    } finally { await db.close(); }
});
