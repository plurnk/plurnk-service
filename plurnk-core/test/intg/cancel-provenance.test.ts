// {§loop-terminal-authorship}, {§methods-loop-cancel}: external cancellation is durable and explicit.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import { rpcCall, flush, connect, withDaemon, makeMockResponse, subscribeNotifications, waitFor, waitForDb } from "./_rpc.ts";
import { insertLoop, insertTurn, insertWorker } from "./_helpers.ts";

type LoopRow = { id: number; status: number; terminal_result: string | null; terminated_by: string | null };

const terminalResult = (row: LoopRow): {
    status: number;
    problem?: { detail?: string; reason?: string };
} => {
    assert.notEqual(row.terminal_result, null, "a terminal loop carries its exact result");
    return JSON.parse(row.terminal_result!) as {
        status: number;
        problem?: { detail?: string; reason?: string };
    };
};

test("{§loop-terminal-authorship}: cancelling a live loop records who and why", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```EXEC\nsleep 30\n```\n\n```TASK\n[{\"content\":\"running\",\"status\":\"in_progress\"}]\n```"),
        makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-live" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job", policy: { proposals: "accept" } });
            await flush();
            await waitForDb(
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );
            await rpcCall(ws, 3, "loop.cancel", { reason: "operator redirected the task" });
            // The ROW is the record: 499, provenanced, carrying the client's reason.
            const row = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.status === 499),
                (l) => l !== undefined,
            );
            assert.equal(row!.terminated_by, "cancel", "the external act is named on the terminal record");
            assert.equal(terminalResult(row!).problem?.reason, "operator redirected the task", "the client's reason remains in the exact cancellation Problem");
            // The broadcast carries the same why.
            const notes = await waitFor(
                () => terminated() as Array<{ result: { status: number; problem?: {
                    type?: string;
                    detail?: string;
                    reason?: string;
                    stage?: string;
                    retryable?: boolean;
                } } }>,
                (ns) => ns.some((n) => n.result.status === 499),
            );
            const cancelled = notes.find((n) => n.result.status === 499);
            assert.equal(cancelled?.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
            assert.equal(cancelled?.result.problem?.detail, "The worker scope was cancelled: operator redirected the task.");
            assert.equal(cancelled?.result.problem?.reason, "operator redirected the task");
            assert.equal(cancelled?.result.problem?.stage, "loop");
            assert.equal(cancelled?.result.problem?.retryable, false);
            const worker = await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: row!.id });
            assert.deepEqual(
                await db.test_error_rows_for_worker.all({ worker_id: worker!.worker_id }),
                [],
                "lifecycle cancellation never fabricates a provider failure",
            );
        } finally { ws.close(); }
    });
});

test("{§methods-loop-cancel}: cancelling a parked loop terminalizes it", async (t) => {
    // A worker parked on a live obligation has no active drain, so cancellation
    // terminalizes the durable 202 row directly.
    const previousSettlement = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (previousSettlement === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousSettlement;
    });
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```EXEC\nsleep 30\n```\n\n```TASK\n[{\"content\":\"awaiting the slow job\",\"status\":\"waiting\"}]\n```"),
        makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-parked" });
            const workspaceId = (created.result as { id: number }).id;
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job", policy: { proposals: "accept" } });
            await flush();
            // Parked: the loop row reaches 202 (the drain has exited by then).
            const parked = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.status === 202),
                (l) => l !== undefined,
            );
            await rpcCall(ws, 3, "loop.cancel", { reason: "shutting down the request" });
            const row = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.id === parked!.id),
                (l) => l !== undefined && l.status !== 202,
            );
            assert.equal(row!.status, 499, "the parked loop went terminal — never a zombie 202");
            assert.equal(row!.terminated_by, "cancel");
            assert.equal(terminalResult(row!).problem?.reason, "shutting down the request");
            const sh = await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" });
            assert.ok(sh !== undefined, "workspace still readable"); // the reap itself is pinned elsewhere ({§notifications-stream-concluded})
        } finally { ws.close(); }
    });
});

test("{§worker-lifecycle-total-reap}: external cancellation terminalizes the durable subtree and emits each loop's turns", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-tree" });
            const workspaceId = (created.result as { id: number }).id;
            const root = await insertWorker(db, workspaceId, null, "root");
            const rootLoop = await insertLoop(db, root, 1, "root");
            const rootTurn = await insertTurn(db, rootLoop, 1, 102);
            const child = await insertWorker(db, workspaceId, root, "child");
            const childLoop = await insertLoop(db, child, 1, "child");
            const childTurn = await insertTurn(db, childLoop, 1, 102);
            const grandchild = await insertWorker(db, workspaceId, child, "grandchild");
            const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild");
            const grandchildTurn = await insertTurn(db, grandchildLoop, 1, 102);
            const terminated = subscribeNotifications(ws, "loop/terminated");

            assert.equal(daemon.cancelDrain(root, "operator cancelled the scope"), false,
                "no process-local drain was active; durable cancellation still proceeds");

            const rows = await waitForDb(
                () => db.test_list_loops_all.all<LoopRow>({}),
                (loops) => [rootLoop, childLoop, grandchildLoop].every((id) =>
                    loops.some((loop) => loop.id === id && loop.status === 499)),
            );
            for (const loopId of [rootLoop, childLoop, grandchildLoop]) {
                const row = rows.find(({ id }) => id === loopId);
                assert.ok(row);
                assert.equal(row?.terminated_by, "cancel");
                assert.equal(terminalResult(row!).problem?.reason, "operator cancelled the scope");
            }

            const notes = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number }; turnIds: number[] }>,
                (events) => [rootLoop, childLoop, grandchildLoop].every((id) =>
                    events.some((event) => event.loopId === id && event.result.status === 499)),
            );
            assert.deepEqual(
                new Map(notes.map(({ loopId, turnIds }) => [loopId, turnIds])),
                new Map([
                    [rootLoop, [rootTurn]],
                    [childLoop, [childTurn]],
                    [grandchildLoop, [grandchildTurn]],
                ]),
                "each terminal event carries the turns belonging to that loop",
            );
        } finally { ws.close(); }
    });
});

for (const mode of ["immediate", "awaited"] as const) {
    test(`{§module-shutdown-order}: stop joins ${mode} cancellation before its final database read`, async (t) => {
        const collecting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const mock = new Mock({ contextWindow: 16384, responses: [] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-stop-${mode}` });
            const workerId = await insertWorker(db, workspaceId, null, "cancelled");
            const loopId = await insertLoop(db, workerId, 1, "cancel this task");
            const turnId = await insertTurn(db, loopId, 1, 102);
            const events: Array<{ loopId: number; result: { status: number }; turnIds: number[] }> = [];
            const order: string[] = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") {
                    events.push(params as typeof events[number]);
                    order.push("terminal event");
                }
            });
            const loopUsage = Engine.prototype.loopUsage;
            t.mock.method(Engine.prototype, "loopUsage", async function (this: Engine, id: number) {
                if (id === loopId) {
                    collecting.resolve();
                    await release.promise;
                    order.push("final database read");
                }
                return loopUsage.call(this, id);
            });
            const cancelWorkerTree = DrainSupervisor.prototype.cancelWorkerTree;
            let settlement: Promise<void> | undefined;
            t.mock.method(DrainSupervisor.prototype, "cancelWorkerTree", function (this: DrainSupervisor, id: number, reason: string) {
                const result = cancelWorkerTree.call(this, id, reason);
                if (id === workerId) settlement = result;
                return result;
            });
            const cancellation = mode === "awaited"
                ? daemon.cancelWorker({ workspaceId, workerId, reason: "operator cancelled" })
                : daemon.cancelDrain(workerId, "operator cancelled");
            if (mode === "immediate") assert.equal(cancellation, false, "no active drain does not mean no cancellation work");
            await collecting.promise;
            let stopped = false;
            const stopping = daemon.stop().then(() => { stopped = true; order.push("stopped"); });
            try {
                await flush();
                assert.equal(stopped, false, "stop cannot authorize database closure while cancellation still uses it");
            } finally {
                release.resolve();
                await cancellation;
                await settlement;
                await stopping;
            }
            assert.deepEqual(order, ["final database read", "terminal event", "stopped"]);
            assert.deepEqual(events.map(({ loopId: id, result, turnIds }) => ({ loopId: id, status: result.status, turnIds })), [
                { loopId, status: 499, turnIds: [turnId] },
            ], "the durable cancellation is published once before shutdown completes");
        });
    });
}
