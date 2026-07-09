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
    // 16384: the static packet (tools sheet + docs) grew with execs-search 0.3.0's ten category
    // tags — the same teaching-growth budget-edge the delegation test hit at the FORK/WORK adopt.
    const mock = new Mock({ contextSize: 16384, responses: [
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

test("[§actor-boundary-passive-wake] an irc (SEND run://name) wakes a CONCLUDED sibling — the voice door mints a fresh loop", async () => {
    // Under §run-lifecycle-idle-is-concluded, an actor with nothing to wait on CONCLUDES — it does not
    // park awaiting voice. So the voice door (a sibling's irc) reawakens it as a NEW loop carrying the
    // message as its prompt (the same wake `loop.inject` proves for the operator voice), never a
    // resume-in-place of a slept loop — there is no slept loop to resume.
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<SEND[200]:standing by for the entry code:SEND", 10),        // loop 1 — idle actor concludes
        makeMockResponse("<<SEND[200]:received the entry code and confirmed:SEND", 10), // loop 2 — woken by the irc
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "irc-wake" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const run = await rpcCall(ws, 2, "loop.run", { prompt: "be a butler; await the entry code", flags: { yolo: true } });
            const modelRunId = (run.result as { modelRunId: number }).modelRunId;
            const loopId = (run.result as { loopId: number }).loopId;
            // The actor concludes its first (idle) loop — nothing to wait on.
            await waitFor(() => terminated() as Array<{ loopId: number }>, (ts) => ts.some((t) => t.loopId === loopId), { timeoutMs: 8000 });
            const before = (await (db.test_count_loops_by_run as PrepMethod).get<{ n: number }>({ run_id: modelRunId }))!.n;
            // Address the concluded actor by name, then irc it — the voice door.
            const runs = ((await rpcCall(ws, 3, "session.runs", {})).result as { runs: Array<{ name: string; origin: string }> }).runs;
            const actor = runs.find((r) => r.origin === "model")!;
            await rpcCall(ws, 4, "op.send", { status: 200, recipient: `run://${actor.name}`, body: "the entry code is 4815" });
            // A FRESH loop is minted (there was no slept loop to resume).
            const after = await waitForDb(() => (db.test_count_loops_by_run as PrepMethod).get<{ n: number }>({ run_id: modelRunId }), (r) => (r?.n ?? 0) > before, { timeoutMs: 8000 });
            assert.ok((after?.n ?? 0) > before, "the irc reawakened the concluded actor as a FRESH loop — the voice door mints a new loop, never resumes a park");
        } finally { ws.close(); }
    });
});

test("[§run-lifecycle-idle-is-concluded] an idle run's wait concludes (loop/terminated 200) — it never parks or quiesces", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [
        // A wait with nothing running under it — an idle subtree. A wait on zero obligations concludes.
        makeMockResponse("<<SEND[202]:nothing running; done for now:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "idle-concludes" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 2, "loop.run", { prompt: "nothing to do", flags: { yolo: true } });
            const t = await waitFor(() => terminated() as Array<{ finalStatus: number }>, (items) => items.length > 0, { timeoutMs: 8000 });
            assert.equal(t.length, 1, "the idle run concluded — one loop/terminated, no held-open 202");
            assert.equal(t[0].finalStatus, 200, "a wait on zero obligations resolves to 200 (§wait-obligation-matrix)");
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
    // The delegation-flags flake: a conclusion-wake re-queues a parent's loop (202→100) between its
    // turn-end and its drain's next status check; pre-fix, runLoop read the queued 100 as an external
    // terminal and broadcast a QUEUED loop as loop/terminated{100}.
    // Under §wait-obligation-matrix a loop blocks at 202 only on a live obligation, so the wake is a
    // REAL child-wake: the parent blocks on a spawned child, the child's conclusion re-queues the parent
    // (202→100) and the drain re-claims it (100→102). Exactly one terminal must fire for the parent, 200.
    const mock = new Mock({ contextSize: 100000, responses: [
        makeMockResponse("<<WORK(run://helper):do a quick thing:WORK\n<<SEND[202]:awaiting helper:SEND", 10), // parent — blocks on its child
        makeMockResponse("<<SEND[200]:helper done:SEND", 10),                    // helper — concludes, waking the parent
        makeMockResponse("<<SEND[200]:helper delivered; concluding:SEND", 10),   // parent — re-queued by the wake, concludes
        makeMockResponse("<<SEND[200]:done:SEND", 10),                           // buffer
        makeMockResponse("<<SEND[200]:done:SEND", 10),                           // buffer
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "wake-requeue" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "spawn a helper and await it", flags: { yolo: true } });
            const loopId = (accept.result as { loopId: number }).loopId;
            // The parent's loop is re-queued in place by the child-wake, then continues to its own terminal.
            const seen = await waitFor(
                () => terminated() as Array<{ loopId: number; finalStatus: number }>,
                (ts) => ts.some((t) => t.loopId === loopId),
                { timeoutMs: 8000 },
            );
            const finals = seen.filter((t) => t.loopId === loopId).map((t) => t.finalStatus);
            assert.deepEqual(finals, [200], `exactly one terminal broadcast for the parent, 200 — never a queued 100; got ${JSON.stringify(finals)}`);
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
