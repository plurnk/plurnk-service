// {§operator-config-loop-timeout}

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { makeMockResponse } from "./_rpc.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";

class AbortBlockingMock extends Mock {
    readonly entered = Promise.withResolvers<void>();
    signal: AbortSignal | undefined;

    override async generate(args: Parameters<Mock["generate"]>[0]): Promise<never> {
        args.signal?.throwIfAborted();
        if (args.signal === undefined) throw new Error("AbortBlockingMock requires the engine's loop signal");
        this.signal = args.signal;
        this.entered.resolve();
        return await new Promise<never>((_resolve, reject) => {
            args.signal?.addEventListener("abort", () => reject(args.signal?.reason), { once: true });
        });
    }
}

test("execution exhaustion rules a legible 504 loop_timeout terminal", async (t) => {
    const loopTimeoutMs = 60_000;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
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

test("{§operator-config-loop-timeout}: WAIT preserves one execution allowance across engine reconstruction", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const originalTimeout = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "60000";
    const db = await openMigrated();
    let resumed: ReturnType<Engine["runLoop"]> | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "cumulative-execution");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Wait, then finish the same assignment.");
        const first = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse("### SEND_ (WAIT) <60>\nWait before continuing."),
        ] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
            t.mock.timers.tick(40_000);
            return generate(...args);
        });
        const parked = await first.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(parked.result.status, 202);
        t.mock.timers.tick(86_400_000);
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.status(loopId), 202, "deliberate waiting cannot spend execution time or time out the task");
        assert.equal(await lifecycle.wake(loopId), true);
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        // A later process/configuration cannot renew an already-started task's allowance.
        process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "120000";
        const second = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const blocked = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        resumed = second.runLoop({ provider: blocked, workspaceId, workerId, loopId, messages: [] });
        await blocked.entered.promise;
        t.mock.timers.tick(19_999);
        assert.equal(blocked.signal?.aborted, false, "the remaining allowance is available to useful work");
        t.mock.timers.tick(1);
        assert.equal(blocked.signal?.aborted, true, "40s before WAIT plus 20s after WAIT exhaust the original 60s allowance");
        const result = await resumed;
        assert.equal(result.reason, "loop_timeout");
        assert.equal(result.result.status, 504);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/loop-timeout");
        assert.equal(await lifecycle.status(loopId), 504);
        assert.equal(await lifecycle.wake(loopId), false, "a deadline never makes a finished task runnable");
    } finally {
        t.mock.timers.tick(120_000);
        await resumed;
        if (originalTimeout === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = originalTimeout;
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

test("{§loop-execution-allowance}: exhaustion while acquiring the workspace settles without inference or a leaked gate", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "1000";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "execution-lock-timeout");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Wait for the workspace.");
        const gate = new WorkspaceGate(async () => false);
        const exclusive = gate.requestExclusive(workspaceId);
        await exclusive.acquired;
        const waiting = Promise.withResolvers<void>();
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            acquireWorkspaceTurn: (workspace, worker, signal) => {
                const request = gate.acquireTurn(workspace, worker, signal);
                waiting.resolve();
                return request;
            },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        try {
            await waiting.promise;
            t.mock.timers.tick(1000);
            const result = await running;
            assert.equal(result.result.status, 504, "the timeout settles while another owner still holds the workspace");
            assert.equal(result.reason, "loop_timeout");
            assert.equal(provider.received.length, 0, "the cancelled admission never reaches the provider");
        } finally { exclusive.release(); }
        (await gate.acquireTurn(workspaceId, workerId))();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        await db.close();
    }
});

test("{§loop-execution-allowance}: an exceptional exit saves consumption and releases the execution scope", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "exceptional-execution");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const failure = new Error("workspace admission failed");
        let executionSignal: AbortSignal | undefined;
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            acquireWorkspaceTurn: async (_workspace, _worker, signal) => {
                executionSignal = signal;
                t.mock.timers.tick(40000);
                throw failure;
            },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        await assert.rejects(engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] }),
            (error: unknown) => error === failure);
        assert.equal(executionSignal?.aborted, true, "failed execution cannot leave its effect scope alive");
        assert.equal((await db.test_get_loop_execution.get({ id: loopId }))?.execution_elapsed_ms, 40000);
        t.mock.timers.tick(86_400_000);
        assert.equal(executionSignal?.reason, "loop_execution_failed", "no retained timeout overwrites the original failure");
    } finally { await db.close(); }
});

test("{§worker-lifecycle-state-machine}: a cancellation committed before timeout settlement keeps its exact result", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "1000";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "cancel-timeout-race");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const lifecycle = new LoopLifecycle(db);
        const finish = lifecycle.finish.bind(lifecycle);
        t.mock.method(lifecycle, "finish", async (...args: Parameters<typeof finish>) => {
            if (args[1].status === 504) await lifecycle.cancelTree(workerId, "cancel won", true);
            return finish(...args);
        });
        const engine = new Engine({ db, lifecycle, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        await provider.entered.promise;
        t.mock.timers.tick(1000);
        const result = await running;
        assert.equal(result.reason, "external");
        assert.equal(result.result.status, 499);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
        assert.deepEqual(await lifecycle.result(loopId), result.result);
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        await db.close();
    }
});
