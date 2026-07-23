// Daemon-level drain + inject + cancel paradigm (rummy AgentLoop parallel).
// Engine-level inject mechanics are covered in Engine.inject.test.ts;
// this file exercises the RPC surface and lifecycle through real WS calls.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, flush, connect, withDaemon, makeMockResponse, subscribeNotifications, waitFor, waitForDb, runLoopToTerminal } from "./_rpc.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

const sendOnly = (dsl: string) => makeMockResponse(dsl);

test("loop.run: enqueues + drains + returns first loop's result", async () => {
    const dsl = "<<EDIT(worker:///x):hello:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: 16384, responses: [sendOnly(dsl)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "drain-basic" });
            // loop.run returns the accept (100 + action); the outcome rides loop/terminated.
            const result = await runLoopToTerminal(ws, 2, { prompt: "say hello" });
            assert.equal(result.accepted, 100, "loop.run accepts immediately");
            assert.equal(result.action, "enqueued_new_loop");
            assert.equal(result.finalStatus, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds?.length, 1);
        } finally { ws.close(); }
    });
});

test("loop.cancel terminates a backgrounded exec; the stream concludes 499", async () => {
    // A fire-and-forget exec outlives the loop that spawned it (SEND[102] keeps
    // turn 1 going, the loop ends on turn 2, the spawn runs on). loop.cancel
    // must ACTUALLY terminate it — proven by the exec stream concluding 499,
    // not merely cancelled=true. The wall clock used to hide a broken kill
    // behind a 30s leak (the original assertion never checked the kill).
    //
    // `sleep 30` is the long-running job; loop.cancel must process-group-kill
    // it (execs 0.4.0+ fixed the #4 grandchild leak) — proven by the 499
    // conclusion, not a 30s wall-clock leak.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "drain-cancel" });
            const workspaceId = (created.result as { id: number }).id;
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "start slow job", flags: { auto: true } });
            await flush();
            // Wait for the backgrounded exec's subscription to ACTUALLY open before
            // cancelling — a fixed sleep races the spawn (the scheme directory + materialized
            // docs push it past the old 250ms guess). The cancel must land on a live,
            // registered exec so it terminates deterministically and the stream concludes
            // 499; otherwise it fires into the spawn gap and asserts on a stream that never
            // opened (the flake this replaces — the kill path itself is sound).
            await waitForDb(
                async () => (await (db.test_count_open_subs_by_scheme as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );

            const cancelResp = await rpcCall(ws, 3, "loop.cancel", { reason: "redirected" });
            const cancelResult = cancelResp.result as { cancelled: boolean; reason: string };
            assert.equal(cancelResult.cancelled, true);
            assert.equal(cancelResult.reason, "redirected");

            // The kill actually happened — promptly, not 30s later.
            const conc = await waitFor(
                () => concluded() as Array<{ scheme: string; closeStatus: number }>,
                (cs) => cs.some((c) => c.scheme === "sh" && c.closeStatus === 499),
                { timeoutMs: 5000 },
            );
            assert.ok(conc.some((c) => c.scheme === "sh" && c.closeStatus === 499),
                "loop.cancel terminated the backgrounded exec (stream concluded 499)");

            // #204 — loop.run already returned its 100 accept; loop.cancel never makes it
            // reject. The cancelled loop's 499 terminal is observed via the stream conclusion
            // above (and loop/terminated), not loop.worker's return.
            const loopResp = await loopPromise;
            assert.equal(loopResp.error, undefined, "loop.run accepted and resolved; cancel never rejects it (#204)");
            assert.equal((loopResp.result as { finalStatus: number }).finalStatus, 100, "loop.run returned the 100 accept, not the terminal");
        } finally { ws.close(); }
    });
});

test("loop.cancel: no active drain → cancelled=false", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [sendOnly("<<SEND[200]:done:SEND")] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "drain-noop-cancel" });
            const resp = await rpcCall(ws, 2, "loop.cancel", {});
            const result = resp.result as { cancelled: boolean };
            assert.equal(result.cancelled, false);
        } finally { ws.close(); }
    });
});

test("loop.run: post-cancel, a fresh loop.run starts a new drain", async () => {
    // Generous response queue so neither loop exhausts Mock regardless
    // of how many turns each runs before cancel/termination.
    // 16384: the cancel-then-restart drain accumulates the exec entry across turns, cresting at the 8192 edge;
    // grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the drain restart, not a budget probe.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "drain-restart" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");

            const firstPromise = rpcCall(ws, 2, "loop.run", {
                prompt: "first", flags: { auto: true },
            });
            // Wait for the backgrounded exec to ACTUALLY spawn (its entry to exist) before
            // cancelling — a fixed sleep races the spawn (the scheme directory + materialized
            // docs push the spawn later than the old 250ms guess). The cancel must land on a
            // running exec, deterministically; otherwise it fires into the spawn gap and the
            // sleep leaks (the failure this replaces).
            await waitForDb(
                async () => (await (db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            const firstResp = await firstPromise;
            assert.equal((firstResp.result as { finalStatus: number }).finalStatus, 100,
                "loop.run accepted (100); the cancelled loop's terminal arrives via events");
            // Wait for the cancelled first loop to actually terminate (499 via loop/terminated)
            // so the worker is genuinely idle before the second loop.run.
            const firstLoop = (firstResp.result as { loopId: number }).loopId;
            await waitFor(() => terminated() as Array<{ loopId: number }>,
                (ts) => ts.some((t) => t.loopId === firstLoop), { timeoutMs: 5000 });

            // Post-cancel, a fresh loop.run starts a NEW drain (enqueued_new_loop) and completes.
            const second = await runLoopToTerminal(ws, 4, { prompt: "second" });
            assert.equal(second.action, "enqueued_new_loop");
            assert.equal(second.finalStatus, 200);
        } finally { ws.close(); }
    });
});

test("loop.run while a loop is live: second call injects into its next-turn slot (no parallel drain)", async () => {
    // Deterministic hold (no 50ms race): a non-auto EXEC proposal pauses
    // dispatch at status=202 BEFORE any subprocess spawns, so loop 1 is
    // provably live at status=102 when the second loop.run lands. We REJECT it
    // (no spawn → no stream → no wake side-effect); loop 1 then continues to
    // turn 2, whose prompt is the injected "follow-up", and ends. This pins the
    // single-drain invariant: a concurrent loop.run injects into the live loop,
    // it never spins up a parallel drain.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("<<EXEC[sh]:true:EXEC"),       // proposal → pause (no auto, no SEND → continue)
            sendOnly("<<SEND[200]:done:SEND"),      // turn 2 consumes the injected prompt, ends
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "drain-inject-active" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const terminated = subscribeNotifications(ws, "loop/terminated");

            const firstPromise = rpcCall(ws, 2, "loop.run", { prompt: "kick off" });
            // Loop 1 is provably paused at the proposal → status=102.
            const pending = await waitFor(
                () => proposals() as Array<{ logEntryId: number }>,
                (p) => p.length >= 1,
            );

            const r2 = await rpcCall(ws, 3, "loop.run", { prompt: "follow-up" });
            const result2 = r2.result as { action: string; turnSeq?: number };
            assert.equal(result2.action, "injected_next_turn",
                "a loop.run while a loop is live injects into its next turn — never a parallel drain");
            assert.ok(typeof result2.turnSeq === "number" && result2.turnSeq > 1,
                `injected into a turn slot >1; got ${result2.turnSeq}`);

            type EntryRow = { scheme: string; pathname: string };
            const entries = await (db as unknown as { test_list_entries_by_workspace_workspace_pathname: { all<T = unknown>(p?: object): Promise<T[]> } }).test_list_entries_by_workspace_workspace_pathname.all<EntryRow>({ workspace_id: 1 });
            const injected = entries.find((e) => e.scheme === "prompt" && /^\/\d+\/[2-9]\d*$/.test(e.pathname));
            assert.ok(injected, "injected prompt entry exists in a turn slot >1");

            // Reject the proposal (no spawn); loop 1 continues to turn 2, which
            // consumes the injected prompt and ends cleanly.
            await rpcCall(ws, 4, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
            await firstPromise;  // resolves at the 100 accept; loop 1 finishes async (turn 2 → SEND[200])

            // Exactly one loop ran for the worker: the second call injected, it did not spin up a
            // parallel drain. Wait for the single termination (loop.run no longer blocks to it).
            const ended = await waitFor(
                () => terminated() as Array<{ loopId: number; finalStatus: number }>,
                (t) => t.length >= 1, { timeoutMs: 5000 },
            );
            assert.equal(ended.length, 1, "exactly one loop terminated — no parallel drain");
            assert.equal(ended[0].finalStatus, 200, "loop 1 ends cleanly after consuming the injected prompt");
        } finally { ws.close(); }
    });
});

test("loop ends before consuming an injected prompt → reconciled into a fresh loop (no wake lost)", async () => {
    // Edge: a next-turn prompt injected into a loop that then terminates before
    // reaching that turn would be silently lost. Forced deterministically: hold
    // loop 1 at a proposal (status=102, turn 1), inject a turn-2 prompt, then
    // let turn 1 emit SEND[200] so loop 1 ends and turn 2 never runs. The drain
    // must promote the orphaned prompt to a fresh loop that surfaces it — so two
    // loops terminate for the worker, not one (it would be one if the wake were
    // lost; no other op here spawns a loop — the EXEC proposal is rejected).
    // 16384: the inject-then-reconcile path accumulates both loops' rows across turns, cresting at the 8192 edge;
    // grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the reconcile, not a budget probe.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            // The rejected EXEC is a same-turn failure — §send-200-failed-ops refuses a [200] over
            // it, so loop 1 ends turn 1 by ABANDON (499, never gated): the orphan premise holds.
            sendOnly("<<EXEC[sh]:true:EXEC\n<<SEND[499]:loop 1 abandons at turn 1:SEND"),  // pause, then end
            sendOnly("<<SEND[200]:reconciled loop ran:SEND"),                              // the promoted loop
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "reconcile-orphan" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const terminated = subscribeNotifications(ws, "loop/terminated");

            const firstPromise = rpcCall(ws, 2, "loop.run", { prompt: "kick off" });
            const pending = await waitFor(() => proposals() as Array<{ logEntryId: number }>, (p) => p.length >= 1);

            // Inject a turn-2 prompt while loop 1 is paused at turn 1.
            const r2 = await rpcCall(ws, 3, "loop.run", { prompt: "the orphaned follow-up" });
            assert.equal((r2.result as { action: string }).action, "injected_next_turn");

            // Release the proposal → turn 1 emits SEND[200] → loop 1 ends; the
            // injected turn 2 never runs (it's now orphaned).
            await rpcCall(ws, 4, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
            await firstPromise;

            // The orphaned prompt is reconciled into a second loop that runs.
            const ts = await waitFor(
                () => terminated() as Array<{ loopId: number; finalStatus: number }>,
                (t) => t.length >= 2,
                { timeoutMs: 5000 },
            );
            assert.equal(ts.length, 2, "the orphaned wake was reconciled into a second loop (would be 1 if lost)");
            const statuses = ts.map((t) => t.finalStatus).toSorted((a, b) => a - b);
            assert.deepEqual(statuses, [200, 499], "loop 1 abandoned (499, over the rejected EXEC); the reconciled loop concluded 200");
        } finally { ws.close(); }
    });
});

test("loop.cancel reaps the worker's open streams by the subscription registry (closed 499)", async () => {
    // A backgrounded sleep registers an OPEN exec subscription; loop.cancel must reap
    // it THROUGH the registry — the open row closes at 499 — not merely fire a
    // notification. Asserted against the registry directly: open→0 + close_status=499.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]<-1>:backgrounded:SEND"),
            sendOnly("<<SEND[200]:done:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "reap-registry" });
            const workspaceId = (created.result as { id: number }).id;

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "spawn then leave", flags: { auto: true } });
            // The exec is live + registered open.
            await waitForDb(
                async () => (await (db.test_count_open_subs_by_scheme as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n === 1,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            try { await loopPromise; } catch { /* cancelled */ }

            // The registry reap closed the subscription — open→0, deterministically.
            await waitForDb(
                async () => (await (db.test_count_open_subs_by_scheme as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n === 0,
            );
            const closeStatus = (await (db.test_exec_close_status_by_session as PrepMethod).get<{ close_status: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.close_status;
            assert.equal(closeStatus, 499, "the reaped exec subscription is closed at 499 in the registry");
        } finally { ws.close(); }
    });
});

test("a cancelled run is not revived by its straggler stream's conclusion", async () => {
    // After loop.cancel, the backgrounded exec's conclusion must NOT open a fresh loop
    // in the worker — the cancel was deliberate. Proven by the worker's loop count staying at
    // its single model loop after the conclusion lands (a resurrection would add a
    // wake-opened loop), plus the conclusion's wakeAction being a skip, not opened-loop.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]<-1>:backgrounded:SEND"),
            sendOnly("<<SEND[200]:should never run:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "no-resurrection" });
            const workspaceId = (created.result as { id: number }).id;
            const concluded = subscribeNotifications(ws, "stream/concluded");

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "spawn then leave", flags: { auto: true } });
            await waitForDb(
                async () => (await (db.test_count_open_subs_by_scheme as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n === 1,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            const loopResp = await loopPromise;
            const loopId = (loopResp.result as { loopId: number }).loopId;

            // The exec's conclusion lands — and is a SKIP, not an opened loop.
            const conc = await waitFor(
                () => concluded() as Array<{ scheme: string; wakeAction: string }>,
                (cs) => cs.some((c) => c.scheme === "sh"),
                { timeoutMs: 5000 },
            );
            const wake = conc.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.match(wake.wakeAction, /^skipped-/, `the daemon skipped opening a loop; got ${wake.wakeAction}`);

            // The worker was not resurrected: its only loop is the original model loop.
            const workerId = (await (db.test_get_worker_id_by_loop as PrepMethod).get<{ worker_id: number }>({ loop_id: loopId }))?.worker_id;
            const loopCount = (await (db.test_count_loops_by_run as PrepMethod).get<{ n: number }>({ worker_id: workerId }))?.n;
            assert.equal(loopCount, 1, "no wake loop was opened in the cancelled run");
        } finally { ws.close(); }
    });
});
