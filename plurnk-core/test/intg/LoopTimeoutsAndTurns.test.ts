import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Turn from "../../src/core/Turn.ts";
import Daemon from "../../src/server/Daemon.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";
import { LOOP_TIMEOUT_REASON } from "../../src/core/TurnRunner.ts";
import { type Db } from "../../src/core/Db.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, holdChild } from "./_db.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse } from "./_mock.ts";
import { withDaemon } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";
import { completeStmt } from "./_dsl.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

describe("Daemon.execution-budget", () => {
for (const wake of ["message", "same-drain", "restart"] as const) {
    test(`{§session-wait-timing}: ${wake} wake retains the task's remaining execution allowance`, async (t) => {
        // The wait parks on live work the fixture holds; a restart wakes it through recovery.
        const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "60000";
        t.after(() => {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
            else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        });
        const provider = new Mock({ contextWindow: 65536, responses: [
            makeMockResponse("````WAIT\nResume the same task later.\n````"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            let activeDaemon = daemon;
            const { workspaceId } = await daemon.createWorkspace({ name: `execution-${wake}` });
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            await holdChild(db, workspaceId, sessionId);
            const parked = Promise.withResolvers<void>();
            const resumed = Promise.withResolvers<AbortSignal>();
            const completed = Promise.withResolvers<number>();
            const schedule = DrainSupervisor.prototype.scheduleWakes;
            const park = LoopLifecycle.prototype.park;
            const finish = LoopLifecycle.prototype.finish;
            let loopId: number | undefined;
            t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
                await schedule.apply(this, args);
                if (args[1] === sessionId) parked.resolve();
            });
            if (wake === "same-drain") {
                t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, ...args: Parameters<typeof park>) {
                    const result = await park.apply(this, args);
                    if (result && args[0] === loopId) {
                        assert.equal(await this.wake(args[0]), true, "the wake crosses the current driver's park boundary");
                    }
                    return result;
                });
            }
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
                const result = await finish.apply(this, args);
                if (args[0] === loopId && result !== null) completed.resolve(result.status);
                return result;
            });
            const generate = provider.generate.bind(provider);
            let calls = 0;
            t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
                if (calls++ === 0) {
                    t.mock.timers.tick(40_000);
                    return generate(args);
                }
                const signal = args.signal;
                assert.ok(signal !== undefined, "the provider receives the execution cancellation scope");
                signal.throwIfAborted();
                resumed.resolve(signal);
                return await new Promise<never>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
            t.mock.method(performance, "now", () => Date.now());
            try {
                loopId = (await daemon.runLoop({ workspaceId, sessionId, prompt: "Wait and finish this assignment." })).loopId;
                if (wake !== "same-drain") {
                    await parked.promise;
                    if (wake === "restart") {
                        await daemon.stop();
                        activeDaemon = new Daemon({ db, provider });
                        await activeDaemon.start();
                    } else {
                        t.mock.timers.tick(30_000);
                        const delivered = await daemon.runLoop({ workspaceId, sessionId, prompt: "Continue now." });
                        assert.equal(delivered.loopId, loopId);
                    }
                }
                const signal = await resumed.promise;
                t.mock.timers.tick(19_999);
                assert.equal(signal.aborted, false);
                t.mock.timers.tick(1);
                assert.equal(signal.aborted, true, "one shared lifecycle owner retained the execution time before waiting");
                assert.equal(await completed.promise, 504);
                assert.equal((await new LoopLifecycle(db).result(loopId))?.problem?.type,
                    "https://problems.plurnk.xyz/engine/rails/loop-timeout");
            } finally {
                await activeDaemon.cancelSession({ workspaceId, sessionId });
                t.mock.timers.reset();
                if (activeDaemon !== daemon) await activeDaemon.stop();
            }
        });
    });
}
});

describe("operator-timeouts", () => {
// {§operator-config-workspace-settings}

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

test("{§operator-config-workspace-settings} execution exhaustion rules a legible 504 loop_timeout terminal", async (t) => {
    const loopTimeoutMs = 60_000;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    // Restored, never deleted: the panel's value is what every later test in this file runs under,
    // and no code-side default papers over a knob this test removed.
    const panelTimeout = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = String(loopTimeoutMs);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-wall-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "walled");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 50 });
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
            await db.test_error_rows_for_session.all({ session_id: sessionId }),
            [],
            "the lifecycle timeout never fabricates a provider failure",
        );
    } finally {
        process.env.PLURNK_SERVICE_LOOP_TIMEOUT = panelTimeout;
        await db.close();
    }
});

test("{§operator-config-workspace-settings}: waiting preserves one execution allowance across engine reconstruction", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const originalTimeout = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "60000";
    const db = await openMigrated();
    let resumed: ReturnType<Engine["runLoop"]> | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "cumulative-execution");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Wait, then finish the same assignment.");
        const childId = await insertSession(db, workspaceId, sessionId, "child");
        await insertLoop(db, childId, 1, "Live child work the wait joins.");
        const first = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse("````WAIT\nWait before continuing.\n````"),
        ] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
            t.mock.timers.tick(40_000);
            return generate(...args);
        });
        const parked = await first.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
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
        resumed = second.runLoop({ provider: blocked, workspaceId, sessionId, loopId, messages: [] });
        await blocked.entered.promise;
        t.mock.timers.tick(19_999);
        assert.equal(blocked.signal?.aborted, false, "the remaining allowance is available to useful work");
        t.mock.timers.tick(1);
        assert.equal(blocked.signal?.aborted, true, "40s before waiting plus 20s after resumption exhaust the original 60s allowance");
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

test("{§operator-config-workspace-settings} the panel's wall never intrudes — a short loop concludes 200 untouched", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-wall-off-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "quick");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("done")] } }] });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(result.result.status, 200, "the panel's execution allowance is invisible to a normal loop");
    } finally { await db.close(); }
});

test("{§session-wait-timing}: exhaustion while acquiring the workspace settles without inference or a leaked gate", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "1000";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "execution-lock-timeout");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Wait for the workspace.");
        const gate = new WorkspaceGate(async () => false);
        const exclusive = gate.requestExclusive(workspaceId);
        await exclusive.acquired;
        const waiting = Promise.withResolvers<void>();
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            withWorkspaceTurn: (workspace, session, run, signal) => {
                const request = gate.withTurn(workspace, session, run, signal);
                waiting.resolve();
                return request;
            },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        try {
            await waiting.promise;
            t.mock.timers.tick(1000);
            const result = await running;
            assert.equal(result.result.status, 504, "the timeout settles while another owner still holds the workspace");
            assert.equal(result.reason, "loop_timeout");
            assert.equal(provider.received.length, 0, "the cancelled admission never reaches the provider");
        } finally { exclusive.release(); }
        (await gate.acquireTurn(workspaceId, sessionId))();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        await db.close();
    }
});

test("{§session-wait-timing}: an exceptional exit saves consumption and releases the execution scope", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "exceptional-execution");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const failure = new Error("workspace admission failed");
        let executionSignal: AbortSignal | undefined;
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            withWorkspaceTurn: async (_workspace, _session, _run, signal) => {
                executionSignal = signal;
                t.mock.timers.tick(40000);
                throw failure;
            },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        await assert.rejects(engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] }),
            (error: unknown) => error === failure);
        assert.equal(executionSignal?.aborted, true, "failed execution cannot leave its effect scope alive");
        assert.equal((await db.test_get_loop_execution.get({ id: loopId }))?.execution_elapsed_ms, 40000);
        t.mock.timers.tick(86_400_000);
        assert.equal(executionSignal?.reason, "loop_execution_failed", "no retained timeout overwrites the original failure");
    } finally { await db.close(); }
});

test("{§session-loop-lifecycle}: a cancellation committed before timeout settlement keeps its exact result", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "1000";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "cancel-timeout-race");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const lifecycle = new LoopLifecycle(db);
        const finish = lifecycle.finish.bind(lifecycle);
        t.mock.method(lifecycle, "finish", async (...args: Parameters<typeof finish>) => {
            if (args[1].status === 504) await lifecycle.cancelTree(sessionId, "cancel won", true);
            return finish(...args);
        });
        const engine = new Engine({ db, lifecycle, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
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
});

describe("turn-preparation", () => {
for (const mode of ["cancel", "cancel-wrapped", "cancel-context", "deadline", "deadline-wrapped", "internal", "internal-after-cancel", "foreign-abort-after-cancel", "aggregate-after-cancel"] as const) {
    test(`{§turn-record}: ${mode} during preparation retains its cause and performs no inference`, async (t) => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `preparation-${mode}`);
            const sessionId = await insertSession(db, workspaceId, null, "subject");
            const loopId = await insertLoop(db, sessionId, 1, "prepare");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const controller = new AbortController();
            const deadline = mode.startsWith("deadline");
            const cancelled = deadline || mode.startsWith("cancel");
            const reason = deadline ? LOOP_TIMEOUT_REASON : new Error("owner cancelled preparation");
            let thrown: unknown;
            // {§tokenomics} — initialization measures its own rows through the same builder; the failure under
            // test belongs to the inference turn's preparation, after initialization completed.
            const build = PacketBuilder.prototype.buildRequestPacket;
            t.mock.method(PacketBuilder.prototype, "buildRequestPacket", async function (this: PacketBuilder, args: Parameters<PacketBuilder["buildRequestPacket"]>[0]) {
                if (args.currentTurnSeq === 1) return build.call(this, args);
                if (mode !== "internal") controller.abort(reason);
                if (mode.endsWith("wrapped") || mode === "cancel-context") {
                    try {
                        await delay(1, undefined, { signal: controller.signal });
                    } catch (cause) {
                        thrown = mode === "cancel-context" ? new Error("preparation dependency failed", { cause }) : cause;
                        throw thrown;
                    }
                }
                thrown = cancelled ? reason : new Error("packet construction failed");
                if (mode === "foreign-abort-after-cancel") thrown = new DOMException("unrelated abort", "AbortError");
                if (mode === "aggregate-after-cancel") thrown = new AggregateError([reason, thrown], "preparation and cleanup failed", { cause: reason });
                throw thrown;
            });
            const provider = new Mock({ contextWindow: 100_000, responses: [] });
            const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], signal: controller.signal });
            if (deadline) {
                const result = await running;
                assert.equal(result.result.status, 504);
                assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/loop-timeout");
            } else {
                await assert.rejects(running, (cause) => cause === thrown, "the original preparation cause remains intact");
            }
            const turns = await db.test_list_turns_in_loop.all<{
                status: number; completed_at: string | null; packet: string | null;
            }>({ loop_id: loopId });
            assert.deepEqual(turns.map(({ status }) => status), [200, deadline ? 504 : cancelled ? 499 : 500], "completed initialization is unchanged; only the open inference turn is settled");
            assert.ok(turns.every(({ completed_at }) => completed_at !== null));
            assert.equal(turns.at(-1)?.packet, null, "failed preparation does not fabricate a request packet");
            assert.equal(provider.received.length, 0);
            assert.deepEqual(await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }), [], "preparation failure is not a provider call");
            assert.deepEqual(await db.test_error_rows_for_session.all({ session_id: sessionId }), [], "no provider problem is fabricated");
        } finally { await db.close(); }
    });
}
});

describe("turns", () => {
// {§packet} — the stored bag carries no sections; they are rows.
const MIN_PACKET = JSON.stringify({
    weight: 0,
    attributions: [],
    assistant: { content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

const seedLoop = async (db: Db): Promise<number> => {
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return insertLoop(db, sessionId, 1);
};

const setup = async () => {
    const db = await openMigrated();
    const loopId = await seedLoop(db);
    return { db, loopId };
};

test("{§packet} turns: table is STRICT", async () => {
    const { db } = await setup();
    try {
        const row = await db.test_turns_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("{§packet} turns: insert with required fields — defaults populate", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        const row = await db.test_turns_get_full.get<{
            id: number; version: number; loop_id: number; sequence: number; timestamp: string;
            producer: string; kind: string; status: number; completed_at: string | null;
            usage_curation_budget: number | null; packet: string;
        }>({ loop_id: loopId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.sequence, 1);
        assert.equal(row?.producer, "model");
        assert.equal(row?.kind, "inference");
        assert.match(row?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.match(row?.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.status, 200);
        assert.equal(row?.usage_curation_budget, null);
        // {§packet} — read back through turn_packets, the bag carries its (empty) sections.
        assert.deepEqual(JSON.parse(row?.packet ?? "null"), { ...JSON.parse(MIN_PACKET), sections: [] });
    } finally { await db.close(); }
});

test("{§packet} turns: status range CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const [seq, status] of [[1, 100], [2, 200], [3, 499], [4, 599]] as const) {
            await db.test_turns_insert.run({ loop_id: loopId, sequence: seq, status, packet: MIN_PACKET });
        }
        for (const bad of [99, 600, 0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: 99, status: bad, packet: MIN_PACKET }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§packet} turns: sequence < 1 rejected by CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const bad of [0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: bad, status: 200, packet: MIN_PACKET }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§packet} turns: (loop_id, sequence) UNIQUE", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet} turns: sequence resets per loop", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-turns-crossloop");
        const sessionId = await insertSession(db, workspaceId);
        const loopA = await insertLoop(db, sessionId, 1);
        const loopB = await insertLoop(db, sessionId, 2);
        await db.test_turns_insert.run({ loop_id: loopA, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopB, sequence: 1, status: 200, packet: MIN_PACKET });
        const count = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("{§packet} turns: loop_id NOT NULL", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_loop_id.run({ sequence: 1, status: 200, packet: MIN_PACKET }),
            /NOT NULL constraint failed: turns\.loop_id/,
        );
    } finally { await db.close(); }
});

test("{§packet} turns: status NOT NULL", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_status.run({ loop_id: loopId, sequence: 1, packet: MIN_PACKET }),
            /NOT NULL constraint failed: turns\.status/,
        );
    } finally { await db.close(); }
});

test("{§packet} turns: NULL packet means no model request was assembled", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert_missing_packet.run({ loop_id: loopId, sequence: 1, status: 200 });
        const row = await db.test_turns_get_full.get<{ packet: string | null }>({ loop_id: loopId });
        assert.equal(row?.packet, null);
    } finally { await db.close(); }
});

test("{§packet} turns: packet CHECK enforces the request/admitted-response root algebra", async () => {
    const { db, loopId } = await setup();
    try {
        const invalid = [
            "{}",
            "[]",
            "null",
            JSON.stringify({ tokens: 0 }),
            JSON.stringify({ tokens: 0, sections: [], assistant: { content: "", ops: [], reasoning: null } }),
            JSON.stringify({ tokens: 0, sections: [], assistantRaw: null }),
            // {§packet} — sections never ride in the bag
            JSON.stringify({ weight: 0, sections: [], attributions: [] }),
        ];
        for (const [index, packet] of invalid.entries()) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: index + 1, status: 200, packet }),
                /CHECK constraint failed/,
                `invalid packet ${packet}`,
            );
        }
    } finally { await db.close(); }
});

test("{§packet} Turn: every non-model producer uses the same operation-turn lifecycle", async () => {
    const { db, loopId } = await setup();
    try {
        for (const [index, producer] of (["client", "_plurnk"] as const).entries()) {
            const turn = await Turn.open(db, { loopId, producer, kind: "operation" });
            const open = await db.test_get_turn.get<{
                producer: string; kind: string; status: number; completed_at: string | null; packet: string | null;
            }>({ id: turn.id });
            assert.deepEqual(open, {
                id: turn.id,
                loop_id: loopId,
                sequence: index + 1,
                producer,
                kind: "operation",
                status: 102,
                completed_at: null,
                finish_reason: null,
                model: null,
                packet: null,
            });
            await Turn.complete(db, turn.id, 204);
            const completed = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turn.id });
            assert.equal(completed?.status, 204);
            assert.match(completed?.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
    } finally { await db.close(); }
});

test("{§packet} turns: producer and kind are required and reject incoherent identities", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_producer.run({ loop_id: loopId, sequence: 1 }),
            /NOT NULL constraint failed: turns\.producer/,
        );
        await assert.rejects(
            () => db.test_turns_insert_missing_kind.run({ loop_id: loopId, sequence: 1 }),
            /NOT NULL constraint failed: turns\.kind/,
        );
        for (const [sequence, producer, kind, packet] of [
            [1, "nobody", "operation", null],
            [2, "client", "mystery", null],
            [3, "client", "inference", MIN_PACKET],
            [4, "model", "operation", null],
            [5, "client", "initialization", null],
            [6, "client", "operation", MIN_PACKET],
        ] as const) {
            await assert.rejects(
                () => db.test_turns_insert_identity.run({
                    loop_id: loopId, sequence, producer, kind, status: 200, packet,
                }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§packet} Turn: producer is immutable and model calls require inference", async () => {
    const { db, loopId } = await setup();
    try {
        const operation = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        await assert.rejects(
            () => db.engine_open_model_call.get({
                turn_id: operation.id,
                kind: "emission",
                attributions: "[]",
                model: "mock/model",
            }),
            /inference call requires a valid owning workspace and causal context/,
        );
        await assert.rejects(
            () => db.test_turns_update_identity.run({
                id: operation.id,
                producer: "_plurnk",
                kind: "operation",
            }),
            /turn producer and kind are immutable/,
        );
        await assert.rejects(
            () => Turn.recordInference(db, operation.id, {
                packet: MIN_PACKET,
                sections: "[]",
                usageCurationBudget: null,
                finishReason: null,
                model: "mock/model",
                meta: "{}",
            }),
            /not an open model inference turn/,
        );

        const inference = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await assert.rejects(
            () => db.test_turns_update_identity.run({ id: inference.id, producer: "_plurnk", kind: "operation" }),
            /turn producer and kind are immutable/,
        );
    } finally { await db.close(); }
});

test("{§turn-record} inference history prevents changing the turn producer", async () => {
    const { db, loopId } = await setup();
    try {
        const emitted = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await db.engine_open_model_call.get({ turn_id: emitted.id, kind: "emission", attributions: "[]", model: "mock/model" });
        await assert.rejects(() => db.test_turns_update_identity.run({ id: emitted.id, producer: "_plurnk", kind: "operation" }), /turn producer and kind are immutable/, "a model emission is history; the producer cannot change beneath it");
    } finally { await db.close(); }
});

test("{§packet} turns: malformed JSON in packet rejected", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: "{not json" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet} turns: loop_id FK", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: 99999, sequence: 1, status: 200, packet: MIN_PACKET }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet} turns: ON DELETE CASCADE via loop", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 2, status: 200, packet: MIN_PACKET });
        await db.test_turns_loops_delete.run({ id: loopId });
        const remaining = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§packet} turns: CASCADE chain workspace→sessions→loops→turns", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-turns-fullchain");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§packet} turns: curation budget is a positive optional gauge denominator", async () => {
    const { db, loopId } = await setup();
    try {
        for (const curationBudget of [0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert_with_curation_budget.run({
                    loop_id: loopId,
                    sequence: 1,
                    status: 200,
                    packet: MIN_PACKET,
                    curation_budget: curationBudget,
                }),
                /CHECK constraint failed/,
            );
        }
        await db.test_turns_insert_with_curation_budget.run({
            loop_id: loopId,
            sequence: 1,
            status: 200,
            packet: MIN_PACKET,
            curation_budget: 200_000,
        });
        const row = await db.test_turns_get_curation_budget.get<{
            usage_curation_budget: number;
        }>({ loop_id: loopId });
        assert.equal(row?.usage_curation_budget, 200_000);
    } finally { await db.close(); }
});

test("{§packet} turns: negative version rejected", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_with_version.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET, version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet} turns: unique index turns_loop_id_sequence exists", async () => {
    const { db } = await setup();
    try {
        const row = await db.test_turns_index_meta.get<{ name: string; sql: string }>({ name: "turns_loop_id_sequence" });
        assert.equal(row?.name, "turns_loop_id_sequence");
        assert.match(row?.sql ?? "", /UNIQUE/);
    } finally { await db.close(); }
});

test("{§packet} turns: id auto-assigns on insert", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 2, status: 200, packet: MIN_PACKET });
        const rows = await db.test_turns_list_ids.all<{ id: number }>({ loop_id: loopId });
        assert.equal(rows[1].id, rows[0].id + 1);
    } finally { await db.close(); }
});
});
