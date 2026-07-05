// §run-lifecycle topology join — a child run finishing is a WAKE EDGE for a parent that parked
// (SEND[202]) awaiting it. Without it, a parent that spawns work and hibernates would dead-park.
// The proof: the parent concludes at all — a non-woken 202 would hang (runLoopToTerminal times out).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, subscribeNotifications, waitFor, waitForDb, flush } from "./_rpc.ts";

test("[§run-lifecycle-child-wake] a child run concluding wakes a parent parked at 202", async () => {
    // Response order is forced by causality: the parent can't resume until the child concludes,
    // and the child can't run until the parent spawns it — so the Mock queue is deterministic.
    const mock = new Mock({ contextSize: 8192, responses: [
        // Parent turn 1: spawn a child run, then hibernate awaiting it.
        makeMockResponse("<<WORK(run://worker):compute the thing and finish:WORK\n<<SEND[102]<-1>:spawned worker; waiting on it:SEND", 10),
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
        makeMockResponse("<<WORK(run://flaky):try the risky thing:WORK\n<<SEND[102]<-1>:waiting on flaky:SEND", 10),
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
        makeMockResponse("<<WORK(run://child):do subwork:WORK\n<<SEND[102]<-1>:awaiting child:SEND", 10),       // parent t1
        makeMockResponse("<<WORK(run://grandchild):do leaf work:WORK\n<<SEND[102]<-1>:awaiting grandchild:SEND", 10), // child t1
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
        makeMockResponse("<<WORK(run://w1):first job:WORK\n<<SEND[102]<-1>:awaiting w1:SEND", 10), // parent t1
        makeMockResponse("<<SEND[200]:w1 done:SEND", 10),                                       // w1
        makeMockResponse("<<WORK(run://w2):second job:WORK\n<<SEND[102]<-1>:awaiting w2:SEND", 10),// parent t2 (woken by w1)
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

test("[§actor-boundary-passive-wake] an irc (SEND run://name) wakes a sibling parked at 202 — the voice door", async () => {
    // FORENSIC: does an irc to a PARKED run resume its slept loop IN PLACE (like a stream/child wake),
    // or start a fresh loop? Driver spawns 'butler' (parks awaiting a message); we wait until it's
    // actually parked, then irc it as a client. Assert butler's run reaches a terminal (it woke).
    // Paradigm note (grammar 0.75.0): a parent can no longer WORK + [200] in one breath — the fresh
    // child is PENDING at the terminal's dispatch (the unreapable-parent rule, working as designed).
    // The correct shape: spawn, PARK ([102]<-1>), and let the child's conclusion wake you.
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<WORK(run://butler):await the entry code, then confirm it:WORK\n<<SEND[102]<-1>:spawned butler; standing by:SEND", 10),
        makeMockResponse("<<SEND[102]<-1>:awaiting the entry code:SEND", 10),   // butler t1 — parks
        makeMockResponse("<<SEND[200]:received and confirmed:SEND", 10),     // butler — woken by the irc
        makeMockResponse("<<SEND[200]:butler done; concluding:SEND", 10),    // parent — woken by the child's conclusion
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionId = ((await rpcCall(ws, 1, "session.create", { name: "irc-wake" })).result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            // No terminal wait — the parent PARKS after spawning (it terminates only after the
            // butler concludes, at the very end of this test's causal chain).
            await rpcCall(ws, 2, "loop.run", { prompt: "spawn the butler", flags: { yolo: true } });
            const butler = (await waitForDb(() => (db.envelope_get_run_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "butler" }), (r) => r !== undefined))!;
            const slept = (await waitForDb(() => (db.drain_find_slept_loop as PrepMethod).get<{ id: number }>({ run_id: butler.id }), (r) => r !== undefined))!;
            // The voice door: a client ircs butler.
            await rpcCall(ws, 3, "op.send", { status: 200, recipient: "run://butler", body: "the entry code is 4815" });
            // #55 — RESUME IN PLACE, not a fresh loop: the SLEPT loop ITSELF carries the wake to its
            // terminal (202 → 200). A fresh-loop orphan would leave slept stuck at 202 forever.
            const sleptStatus = (await waitForDb(
                () => (db.engine_loop_status as PrepMethod).get<{ status: number }>({ loop_id: slept.id }),
                (s) => s?.status === 200,
                { timeoutMs: 8000 },
            ))?.status;
            assert.equal(sleptStatus, 200, "the irc resumed butler's slept loop IN PLACE (202→200), not a fresh loop orphaning it");
        } finally { ws.close(); }
    });
});

test("[§run-lifecycle-quiesced] a 202 with an idle subtree fires loop/quiesced — reawakable, not a terminal", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [
        // Park at 202 with nothing running under it — an idle subtree.
        makeMockResponse("<<SEND[102]<-1>:nothing running; parking idle:SEND", 10),
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

test("[§run-delegation-inherits-flags] spawn and fork carry the delegating loop's flags — a YOLO parent's child EDITs without proposing", async () => {
    // The four-sweep fan-out wedge: injectRun dropped flags, so a delegated child's every
    // side-effecting op proposed into a resolver-less void (300s auto-cancel per attempt).
    // Proof is behavioral AND through the real dispatch path: the child's EDIT must land
    // state='resolved' (YOLO auto-accept inherited), never state='proposed'/'cancelled'.
    // 16Ki (not the 8Ki the sibling tests use): a topology packet carries the child-orientation
    // section for the spawned + forked runs on top of the base system prompt, so it sits well above a
    // single-run packet. At 8Ki it rode the budget edge (a ~50% 413/200 flake) and grammar 0.74.55's
    // larger delegation teaching tipped it consistently over — the headroom is the fix, not a race.
    const mock = new Mock({ contextSize: 16384, responses: [
        // Parent turn 1: spawn a worker AND fork self, then park awaiting them.
        makeMockResponse("<<WORK(run://worker):edit something and finish:WORK\n<<FORK(run://mirror):edit something and finish:FORK\n<<SEND[102]<-1>:delegated; waiting:SEND", 10),
        // Worker turn 1: a SIDE-EFFECTING op (proposes unless YOLO), then conclude.
        makeMockResponse("<<EDIT(known://from-worker):payload:EDIT\n<<SEND[200]:worker done:SEND", 10),
        // Fork turn 1: same shape.
        makeMockResponse("<<EDIT(known://from-fork):payload:EDIT\n<<SEND[200]:fork done:SEND", 10),
        // Parent resumes twice (one wake per child conclusion).
        makeMockResponse("<<SEND[102]<-1>:one down:SEND", 10),
        makeMockResponse("<<SEND[200]:all done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "delegation-flags" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "delegate everything", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "the whole topology concluded — no child stalled in a proposal void");
            // The delegated loops' persisted flags carry the parent's yolo.
            const loops = await (db.test_all_loops as PrepMethod).all<{ id: number; run_id: number; flags: string }>({});
            const childLive = loops.filter((l) => JSON.parse(l.flags).yolo === true);
            assert.ok(childLive.length >= 3, `parent + both delegated live loops carry yolo; got ${JSON.stringify(loops)}`);
            // And the children's EDITs resolved — never proposed into the void.
            const edits = await (db.test_edit_states as PrepMethod).all<{ pathname: string; state: string }>({});
            for (const e of edits.filter((x) => /from-(worker|fork)/.test(x.pathname))) {
                assert.equal(e.state, "resolved", `child EDIT ${e.pathname} auto-accepted under inherited YOLO`);
            }
        } finally { ws.close(); }
    });
});

test("[§run-lifecycle-wake-requeue-not-terminal] a wake re-queue (100) mid-drain is re-claimed and continued — never returned as a terminal", async () => {
    // Deterministic reproduction of the delegation-flags flake: simulate the conclusion-wake
    // landing between the parent's turn-end and its own drain's next status check by flipping
    // the loop to 100 (+ next prompt) from INSIDE turn 1's generate. Pre-fix, runLoop read the
    // 100 as an external terminal and the drain broadcast a queued loop as terminated.
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<SEND[102]<-1>:parking:SEND", 10),
        makeMockResponse("<<SEND[200]:woke and finished:SEND", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "wake-requeue" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "go", flags: { yolo: true } });
            const loopId = (accept.result as { loopId: number }).loopId;
            // The loop parks at 202 (SEND[202]). Simulate the wake: prompt + re-queue to 100.
            await waitForDb(
                async () => (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status,
                (status) => status === 202,
            );
            await daemon.inject({
                sessionId: 1, runId: (accept.result as { modelRunId?: number }).modelRunId ?? 2,
                prompt: "the child concluded", provider: mock, systemPrompt: "SD",
            });
            const seen = await waitFor(
                () => terminated() as Array<{ loopId: number; finalStatus: number }>,
                (ts) => ts.some((t) => t.loopId === loopId),
            );
            const finals = seen.filter((t) => t.loopId === loopId).map((t) => t.finalStatus);
            assert.deepEqual(finals, [200], `exactly one terminal broadcast, 200 — never a queued 100; got ${JSON.stringify(finals)}`);
        } finally { ws.close(); }
    });
});

test("[§fold-open-meta-operations] a successful FOLD leaves no log row — the render is the receipt; a failed one keeps its row", async () => {
    // Curation receipts that rent log space made curation self-defeating (fold a row, pay a
    // permanent FOLD row) — and the grinder's mechanical folds were already rowless. One rule.
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<EDIT(known://note):some content worth folding:EDIT\n<<SEND[102]:wrote:SEND", 10),
        makeMockResponse("<<FOLD(log:///1/2/1)::FOLD\n<<FOLD(log:///9/9/9)::FOLD\n<<SEND[200]:curated:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "meta-ops" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "curate", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "a curation turn is work, never idleness — the loop concluded");
            const rows = await (db.test_ops_by_loop as PrepMethod).all<{ op: string; status_rx: number }>({});
            const folds = rows.filter((r) => r.op === "FOLD");
            // The successful FOLD (real coordinate) left NO row; the failed one (phantom
            // coordinate) kept its ordinary op row with its status — errors are signals.
            assert.equal(folds.length, 1, `exactly one FOLD row — the failure; got ${JSON.stringify(folds)}`);
            assert.ok(folds[0].status_rx >= 400, "the surviving row is the failed FOLD's, carrying its status");
        } finally { ws.close(); }
    });
});
