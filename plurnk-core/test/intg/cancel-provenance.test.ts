// #380 (owner ruling) — an external loop.cancel is allowed but provenanced, never silent. The
// loop's terminal ROW is written (499; a dead loop must never read as live 102 — before this,
// the 499 existed only in the broadcast) with terminated_by='cancel' and the client's reason as
// the abandonment message; the loop/terminated broadcast carries the same message. A PARKED
// (202) loop has no drain to observe the abort, so the cancel terminalizes it directly.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, flush, connect, withDaemon, makeMockResponse, subscribeNotifications, waitFor, waitForDb } from "./_rpc.ts";
import { insertLoop, insertTurn, insertWorker } from "./_helpers.ts";

type LoopRow = { id: number; status: number; terminal_message: string | null; terminated_by: string | null };

test("cancelling a LIVE loop writes the provenanced 499 row — who/why on the record (#380)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND"),
        makeMockResponse("<<SEND[200]:done:SEND"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-live" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job", flags: { auto: true } });
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
            assert.equal(row!.terminal_message, "operator redirected the task", "the client's reason is the abandonment message");
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
            assert.equal(cancelled?.result.problem?.type, "https://problems.plurnk.dev/lifecycle/cancel/scope-cancelled");
            assert.equal(cancelled?.result.problem?.detail, "The worker scope was cancelled: operator redirected the task.");
            assert.equal(cancelled?.result.problem?.reason, "operator redirected the task");
            assert.equal(cancelled?.result.problem?.stage, "loop");
            assert.equal(cancelled?.result.problem?.retryable, false);
            const worker = await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: row!.id });
            assert.deepEqual(
                await db.test_error_rows_for_run.all({ worker_id: worker!.worker_id }),
                [],
                "lifecycle cancellation never fabricates a provider failure",
            );
        } finally { ws.close(); }
    });
});

test("cancelling a PARKED (202) loop terminalizes it — no dead-park at 202 forever (#380)", async () => {
    // A worker parked on a live obligation (a 30s exec + SEND[202]) has NO active drain — the
    // drain tears down on 202. Before #380 an external cancel left the row 202 forever (the
    // no-resurrection guard blocks wakes): a zombie neither live nor terminal.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[202]:awaiting the slow job:SEND"),
        makeMockResponse("<<SEND[200]:done:SEND"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-parked" });
            const workspaceId = (created.result as { id: number }).id;
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job", flags: { auto: true } });
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
            assert.equal(row!.terminal_message, "shutting down the request");
            const sh = await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" });
            assert.ok(sh !== undefined, "workspace still readable"); // the reap itself is pinned elsewhere (§notifications-stream-concluded)
        } finally { ws.close(); }
    });
});

test("external cancellation terminalizes the complete durable subtree and emits each loop's turns", async () => {
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
                assert.equal(row?.terminated_by, "cancel");
                assert.equal(row?.terminal_message, "operator cancelled the scope");
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
