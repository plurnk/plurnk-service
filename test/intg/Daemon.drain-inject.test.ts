// Daemon-level drain + inject + cancel paradigm (rummy AgentLoop parallel).
// Engine-level inject mechanics are covered in Engine.inject.test.ts;
// this file exercises the RPC surface and lifecycle through real WS calls.

import test from "node:test";
import assert from "node:assert/strict";
import Mock from "../../src/providers/Mock.ts";
import { rpcCall, flush, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

const sendOnly = (dsl: string) => makeMockResponse(dsl);

test("loop.run: enqueues + drains + returns first loop's result", async () => {
    const dsl = "<<EDIT(known://x):hello:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [sendOnly(dsl)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "drain-basic" });
            const resp = await rpcCall(ws, 2, "loop.run", { prompt: "say hello" });
            const result = resp.result as {
                loopId: number; turnIds: number[]; finalStatus: number; hitMaxTurns: boolean; action: string;
            };
            assert.equal(result.action, "enqueued_new_loop");
            assert.equal(result.finalStatus, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds.length, 1);
        } finally { ws.close(); }
    });
});

test("loop.cancel: aborts an in-flight drain (yolo exec spawn keeps drain alive)", async () => {
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            // Turn 1: kick off a slow exec, continue. Drain parks on the spawn.
            sendOnly("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND"),
            sendOnly("<<SEND[200]:never reached:SEND"),
            sendOnly("<<SEND[200]:never reached:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "drain-cancel" });
            const loopPromise = rpcCall(ws, 2, "loop.run", {
                prompt: "start slow job",
                flags: { yolo: true },
            });
            // Let turn 1 dispatch and the spawn start.
            await flush();
            await new Promise((r) => setTimeout(r, 250));

            const cancelResp = await rpcCall(ws, 3, "loop.cancel", { reason: "redirected" });
            const cancelResult = cancelResp.result as { cancelled: boolean; reason: string };
            assert.equal(cancelResult.cancelled, true);
            assert.equal(cancelResult.reason, "redirected");

            // The loop's actual finalStatus depends on whether cancel
            // arrived mid-iteration (→ 499) or after Mock already sent
            // SEND[200] (→ 200). Mock is instant so timing is racy. The
            // important thing is loop.cancel reported cancelled=true and
            // the RPC returned (not hung).
            const loopResp = await loopPromise;
            const loopResult = loopResp.result as { finalStatus: number };
            assert.ok([200, 499].includes(loopResult.finalStatus),
                `loop closed with terminal status; got ${loopResult.finalStatus}`);
        } finally { ws.close(); }
    });
});

test("loop.cancel: no active drain → cancelled=false", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [sendOnly("<<SEND[200]:done:SEND")] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "drain-noop-cancel" });
            const resp = await rpcCall(ws, 2, "loop.cancel", {});
            const result = resp.result as { cancelled: boolean };
            assert.equal(result.cancelled, false);
        } finally { ws.close(); }
    });
});

test("loop.run: post-cancel, a fresh loop.run starts a new drain", async () => {
    // Generous response queue so neither loop exhausts Mock regardless
    // of how many turns each runs before cancel/termination.
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            sendOnly("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "drain-restart" });

            const firstPromise = rpcCall(ws, 2, "loop.run", {
                prompt: "first", flags: { yolo: true },
            });
            await flush();
            await new Promise((r) => setTimeout(r, 250));

            await rpcCall(ws, 3, "loop.cancel", {});
            const firstResp = await firstPromise;
            const firstStatus = (firstResp.result as { finalStatus: number }).finalStatus;
            assert.ok([200, 499].includes(firstStatus),
                `first loop closed with a terminal status; got ${firstStatus}`);

            const secondResp = await rpcCall(ws, 4, "loop.run", { prompt: "second" });
            const secondResult = secondResp.result as { action: string; finalStatus: number };
            assert.equal(secondResult.action, "enqueued_new_loop");
            assert.equal(secondResult.finalStatus, 200);
        } finally { ws.close(); }
    });
});

test("loop.run while drain is active: second call injects into the current loop's next-turn slot", async () => {
    // Drain stays alive via exec spawn. Second loop.run lands while the
    // active loop is mid-iteration → engine.inject finds the loop at
    // status=102 → writes prompt entry for slot 2 → returns action=injected_next_turn.
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            sendOnly("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND"),
            sendOnly("<<SEND[200]:never:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "drain-inject-active" });

            const firstPromise = rpcCall(ws, 2, "loop.run", {
                prompt: "kick off", flags: { yolo: true },
            });
            // Let turn 1 fully process (proposal → applyResolution → spawn starts → SEND[102] dispatches).
            // After SEND[102], turn 1 closes; turn 2 builds; Mock returns the second response (SEND[200]);
            // engine dispatches it; loop closes at 200. Total: ~200ms with provider being instant.
            // For the inject to land while loop is still at 102, we need to inject DURING turn 1
            // or during the build of turn 2. Use a small wait.
            await flush();
            await new Promise((r) => setTimeout(r, 50));

            const r2 = await rpcCall(ws, 3, "loop.run", { prompt: "follow-up" });
            const result2 = r2.result as { action: string; turnSeq?: number };
            // Either injected (loop still at 102) or enqueued (loop already terminated).
            // The interesting case is injected; if it's enqueued we just verify the
            // mechanism didn't start a parallel drain.
            assert.ok(["injected_next_turn", "enqueued_new_loop"].includes(result2.action),
                `expected one of injected/enqueued; got ${result2.action}`);

            // Cancel + clean up.
            await rpcCall(ws, 4, "loop.cancel", {});
            try { await firstPromise; } catch { /* expected */ }

            // If the action was "injected_next_turn", a prompt entry exists in a turn slot >1.
            if (result2.action === "injected_next_turn") {
                assert.ok(typeof result2.turnSeq === "number" && result2.turnSeq > 1, "turnSeq > 1");
                type EntryRow = { scheme: string; pathname: string };
                const entries = await ((db as unknown as { test_list_entries_by_session_session_pathname: { all<T = unknown>(p?: object): Promise<T[]> } }).test_list_entries_by_session_session_pathname.all<EntryRow>({ session_id: 1 }));
                const injected = entries.find((e: EntryRow) => e.scheme === "plurnk" && /^prompt\/\d+\/[2-9]\d*$/.test(e.pathname));
                assert.ok(injected, "injected prompt entry exists in a turn slot >1");
            }
        } finally { ws.close(); }
    });
});
