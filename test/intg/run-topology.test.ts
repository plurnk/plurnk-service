// §run-lifecycle topology join — a child run finishing is a WAKE EDGE for a parent that parked
// (SEND[202]) awaiting it. Without it, a parent that spawns work and hibernates would dead-park.
// The proof: the parent concludes at all — a non-woken 202 would hang (runLoopToTerminal times out).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, subscribeNotifications, waitFor, flush } from "./_rpc.ts";

test("[§run-lifecycle-child-wake] a child run concluding wakes a parent parked at 202", async () => {
    // Response order is forced by causality: the parent can't resume until the child concludes,
    // and the child can't run until the parent spawns it — so the Mock queue is deterministic.
    const mock = new Mock({ contextSize: 8192, responses: [
        // Parent turn 1: spawn a child run, then hibernate awaiting it.
        makeMockResponse("<<EDIT(run://worker):compute the thing and finish:EDIT\n<<SEND[202]:spawned worker; waiting on it:SEND", 10),
        // Child turn 1: do its part and conclude → this is the wake edge for the parent.
        makeMockResponse("<<SEND[200]:worker done:SEND", 10),
        // Parent turn 2 (only reached if the child's conclusion woke it): conclude.
        makeMockResponse("<<SEND[200]:worker finished; all done:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "run-topology" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            // runLoopToTerminal awaits the PARENT's loop/terminated. If the child-wake doesn't fire,
            // the parent stays parked at 202 forever and this times out — so reaching 200 IS the proof.
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn a worker and wait for it", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "the parent resumed from 202 (woken by the child) and concluded");
            await flush();
            // Both runs concluded 200 — the worker's terminal and the parent's resumed terminal.
            const concluded = (terminated() as Array<{ finalStatus: number }>).filter((t) => t.finalStatus === 200);
            assert.ok(concluded.length >= 2, `parent + child both conclude 200; saw ${JSON.stringify((terminated() as Array<{ finalStatus: number }>).map((t) => t.finalStatus))}`);
        } finally { ws.close(); }
    });
});

test("[§run-lifecycle-child-wake] a child FAILING (499) also wakes the parent — any conclusion is a wake edge", async () => {
    // A child that abandons (SEND[499]) is still "done"; the parent must wake, not wait forever.
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<EDIT(run://flaky):try the risky thing:EDIT\n<<SEND[202]:waiting on flaky:SEND", 10),
        makeMockResponse("<<SEND[499]:flaky gave up:SEND", 10),
        makeMockResponse("<<SEND[200]:flaky is done (failed); concluding:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "child-fail" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn flaky, wait", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "the parent woke on the child's 499 and concluded — a failed child is still a wake edge");
        } finally { ws.close(); }
    });
});

test("[§run-lifecycle-child-wake] wake propagates UP a grandchild chain (parent→child→grandchild)", async () => {
    // Each level parks until the one below concludes — so the order is forced and the recursion shows:
    // grandchild concludes → wakes child → child concludes → wakes parent → parent concludes.
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<EDIT(run://child):do subwork:EDIT\n<<SEND[202]:awaiting child:SEND", 10),       // parent t1
        makeMockResponse("<<EDIT(run://grandchild):do leaf work:EDIT\n<<SEND[202]:awaiting grandchild:SEND", 10), // child t1
        makeMockResponse("<<SEND[200]:leaf done:SEND", 10),                                                   // grandchild
        makeMockResponse("<<SEND[200]:child done:SEND", 10),                                                  // child t2 (woken)
        makeMockResponse("<<SEND[200]:all done:SEND", 10),                                                    // parent t2 (woken)
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "grandchild" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn a 2-deep chain and wait", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "the wake propagated up two levels — the parent concluded only after the whole subtree did");
        } finally { ws.close(); }
    });
});

test("[§run-lifecycle-child-wake] a parent wakes across SEQUENTIAL children (multiple wakes)", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<EDIT(run://w1):first job:EDIT\n<<SEND[202]:awaiting w1:SEND", 10), // parent t1
        makeMockResponse("<<SEND[200]:w1 done:SEND", 10),                                       // w1
        makeMockResponse("<<EDIT(run://w2):second job:EDIT\n<<SEND[202]:awaiting w2:SEND", 10),// parent t2 (woken by w1)
        makeMockResponse("<<SEND[200]:w2 done:SEND", 10),                                       // w2
        makeMockResponse("<<SEND[200]:both done:SEND", 10),                                     // parent t3 (woken by w2)
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "sequential" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "two jobs in sequence", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "the parent parked, woke on w1, spawned+parked again, woke on w2, then concluded");
        } finally { ws.close(); }
    });
});

test("[§run-lifecycle-quiesced] a 202 with an idle subtree fires loop/quiesced — reawakable, not a terminal", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [
        // Park at 202 with nothing running under it — an idle subtree.
        makeMockResponse("<<SEND[202]:nothing running; parking idle:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "quiesce" });
            const quiesced = subscribeNotifications(ws, "loop/quiesced");
            const terminated = subscribeNotifications(ws, "loop/terminated");
            // loop.run returns immediately (100); the turn parks at 202 with no stream/child.
            await rpcCall(ws, 2, "loop.run", { prompt: "park with nothing to do", flags: { yolo: true } });
            const q = await waitFor(() => quiesced() as Array<{ runId: number; status: number }>, (items) => items.length > 0, { timeoutMs: 8000 });
            assert.equal(q.length, 1, "one quiesced signal for the idle-parked 202");
            assert.equal(q[0].status, 202, "quiesced carries 202 (parked, reawakable) — never a terminal code");
            await flush();
            // The honest distinction: idle ≠ concluded. The loop did NOT terminate — it's reawakable.
            assert.equal((terminated() as unknown[]).length, 0, "a quiesced 202 is NOT a terminal — no loop/terminated");
        } finally { ws.close(); }
    });
});
