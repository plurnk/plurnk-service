// Daemon-level drain + inject + cancel contract ({§actor-boundary-passive-wake}).
// Engine-level inject mechanics are covered in Engine.inject.test.ts;
// this file exercises the RPC surface and lifecycle through real WS calls.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { rpcCall, flush, connect, withDaemon, makeMockResponse, subscribeNotifications, waitFor, waitForDb, runLoopToTerminal } from "./_rpc.ts";

const sendOnly = (dsl: string) => makeMockResponse(dsl);

test("loop.run: enqueues + drains + returns first loop's result", async () => {
    const dsl = "## EDIT0 (worker:///x)\nhello\n\n## SEND0 [200]\ndone";
    const mock = new Mock({ contextWindow: 16384, responses: [sendOnly(dsl)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "drain-basic" });
            // loop.run returns the accept (100 + action); the outcome rides loop/terminated.
            const result = await runLoopToTerminal(ws, 2, { prompt: "say hello" });
            assert.equal(result.accepted, 100, "loop.run accepts immediately");
            assert.equal(result.action, "enqueued_new_loop");
            assert.equal(result.result.status, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds?.length, 1);
        } finally { ws.close(); }
    });
});

test("{§worker-lifecycle-single-drain}: concurrent idle injections claim distinct ordered loops", async () => {
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("## SEND0 [200]\nfirst concurrent loop"),
            sendOnly("## SEND0 [200]\nsecond concurrent loop"),
        ],
    });

    await withDaemon(mock, async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: "concurrent-loop-allocation" });
        const workerId = await daemon.ensureModelWorker(workspace.workspaceId);
        const providerSpec = { alias: "mocktest", provider: "openai", model: "mocktest" } as const;
        const accepted = await Promise.all([
            daemon.inject({
                workspaceId: workspace.workspaceId,
                workerId,
                prompt: "concurrent prompt one",
                providerSpec,
                systemPrompt: "test system",
            }),
            daemon.inject({
                workspaceId: workspace.workspaceId,
                workerId,
                prompt: "concurrent prompt two",
                providerSpec,
                systemPrompt: "test system",
            }),
        ]);

        assert.deepEqual(accepted.map(({ action }) => action), ["enqueued_new_loop", "enqueued_new_loop"]);
        assert.equal(new Set(accepted.map(({ loopId }) => loopId)).size, 2, "both accepted prompts own a loop");
        assert.equal(accepted.filter(({ drainPromise }) => drainPromise !== undefined).length, 1,
            "one drain owns the complete ordered queue");

        const loops = await waitForDb(
            () => db.test_loop_queue_by_worker.all<{
                id: number; sequence: number; status: number; prompt: string;
            }>({ worker_id: workerId }),
            (rows) => rows.length === 2 && rows.every(({ status }) => status === 200),
        );
        assert.deepEqual(loops.map(({ sequence }) => sequence), [1, 2]);
        assert.deepEqual(new Set(loops.map(({ prompt }) => prompt)), new Set(["concurrent prompt one", "concurrent prompt two"]));
        assert.equal(mock.remaining, 0, "the one drain processed both loops exactly once");
    });
});

test("loop.cancel terminates a backgrounded exec; the stream concludes 499", async () => {
    // A fire-and-forget exec outlives the loop that spawned it (SEND[102] keeps
    // turn 1 going, the loop ends on turn 2, the spawn runs on). loop.cancel
    // must ACTUALLY terminate it — proven by the exec stream concluding 499,
    // not merely cancelled=true. The wall clock used to hide a broken kill
    // behind a 30s leak (the original assertion never checked the kill).
    //
    // `sleep 30` is the long-running job; {§executor-cancellation} requires
    // loop.cancel to process-group-kill it — proven by the 499
    // conclusion, not a 30s wall-clock leak.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [102]\nrunning"),
            sendOnly("## SEND0 [200]\ndone"),
            sendOnly("## SEND0 [200]\ndone"),
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
            // cancelling — a fixed sleep races the spawn (the resource directory + materialized
            // docs push it past the old 250ms guess). The cancel must land on a live,
            // registered exec so it terminates deterministically and the stream concludes
            // 499; otherwise it fires into the spawn gap and asserts on a stream that never
            // opened (the timing race this replaces — the kill path itself is sound).
            await waitForDb(
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );

            const cancelResp = await rpcCall(ws, 3, "loop.cancel", { reason: "redirected" });
            const cancelResult = cancelResp.result as { cancelled: boolean; reason: string };
            assert.equal(cancelResult.cancelled, true);
            assert.equal(cancelResult.reason, "redirected");

            // The kill actually happened — promptly, not 30s later.
            const conc = await waitFor(
                () => concluded() as Array<{ scheme: string; result: { status: number } }>,
                (cs) => cs.some((c) => c.scheme === "sh" && c.result.status === 499),
                { timeoutMs: 5000 },
            );
            assert.ok(conc.some((c) => c.scheme === "sh" && c.result.status === 499),
                "loop.cancel terminated the backgrounded exec (stream concluded 499)");

            // {§methods-loop-run} {§notifications-loop-terminated}: cancellation cannot
            // retroactively reject the immediate 100 acknowledgement; terminal truth is an event.
            const loopResp = await loopPromise;
            assert.equal(loopResp.error, undefined, "loop.run acknowledgement remains accepted after cancellation");
            assert.equal((loopResp.result as { status: number }).status, 100, "loop.run returned the 100 accept, not the terminal");
        } finally { ws.close(); }
    });
});

test("loop.cancel: no active drain → cancelled=false", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [sendOnly("## SEND0 [200]\ndone")] });
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
            sendOnly("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [102]\nrunning"),
            sendOnly("## SEND0 [200]\ndone"),
            sendOnly("## SEND0 [200]\ndone"),
            sendOnly("## SEND0 [200]\ndone"),
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
            // cancelling — a fixed sleep races the spawn (the resource directory + materialized
            // docs push the spawn later than the old 250ms guess). The cancel must land on a
            // running exec, deterministically; otherwise it fires into the spawn gap and the
            // sleep leaks (the failure this replaces).
            await waitForDb(
                async () => (await db.test_count_entries_by_workspace_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            const firstResp = await firstPromise;
            assert.equal((firstResp.result as { status: number }).status, 100,
                "loop.run accepted (100); the cancelled loop's terminal arrives via events");
            // Wait for the cancelled first loop to actually terminate (499 via loop/terminated)
            // so the worker is genuinely idle before the second loop.run.
            const firstLoop = (firstResp.result as { loopId: number }).loopId;
            await waitFor(() => terminated() as Array<{ loopId: number }>,
                (ts) => ts.some((t) => t.loopId === firstLoop), { timeoutMs: 5000 });

            // Post-cancel, a fresh loop.run starts a NEW drain (enqueued_new_loop) and completes.
            const second = await runLoopToTerminal(ws, 4, { prompt: "second" });
            assert.equal(second.action, "enqueued_new_loop");
            assert.equal(second.result.status, 200);
        } finally { ws.close(); }
    });
});

test("{§methods-loop-run-open-paths}: an active-loop prompt carries its paths into the publishing turn", async () => {
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
            sendOnly("## EXEC0 [sh]\ntrue\n\n## SEND0 [102]\ncontinue after review"), // proposal pauses before the required disposition
            sendOnly("## SEND0 [200]\ndone"),      // turn 2 consumes the injected prompt, ends
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

            const r2 = await rpcCall(ws, 3, "loop.run", {
                prompt: "follow-up",
                openPaths: ["src/active-context.ts"],
            });
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
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (t) => t.length >= 1, { timeoutMs: 5000 },
            );
            assert.equal(ended.length, 1, "exactly one loop terminated — no parallel drain");
            assert.equal(ended[0].result.status, 200, "loop 1 ends cleanly after consuming the injected prompt");

            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number;
            }>({ loop_id: ended[0].loopId });
            const frame = rows.find((row) => row.op === "prompt" && row.pathname === "/1/2");
            const contextRead = rows.find((row) => row.op === "READ" && row.origin === "plurnk" && row.scheme === null && row.pathname === "src/active-context.ts");
            assert.ok(frame, "the injected prompt was published as its own frame");
            assert.ok(contextRead, "the injected prompt's selected path produced a core READ");
            assert.equal(contextRead.turn_id, frame.turn_id,
                "the context READ is observable in the same turn as its prompt frame");
        } finally { ws.close(); }
    });
});

test("{§methods-loop-run-open-paths}: a parked-loop prompt carries its paths into the resumed turn", async (t) => {
    const previousSettlement = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (previousSettlement === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousSettlement;
    });
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [202] <-1>\npark"),
            sendOnly("## SEND0 [499]\ndone with the parked work"),
        ],
    });
    const parkedBoundary = Promise.withResolvers<void>();
    const releaseBoundary = Promise.withResolvers<void>();
    const runLoop = Engine.prototype.runLoop;
    t.mock.method(Engine.prototype, "runLoop", async function (
        this: Engine,
        ...args: Parameters<Engine["runLoop"]>
    ) {
        const result = await runLoop.apply(this, args);
        if (result.result.status === 202) {
            parkedBoundary.resolve();
            await releaseBoundary.promise;
        }
        return result;
    });
    t.after(() => releaseBoundary.resolve());

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "openpaths-parked" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const started = await rpcCall(ws, 2, "loop.run", {
                prompt: "start and park",
                flags: { auto: true },
            });
            const loopId = (started.result as { loopId: number }).loopId;
            await parkedBoundary.promise;
            await waitForDb(
                async () => (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
                (status) => status === 202,
            );

            const resumed = await rpcCall(ws, 3, "loop.run", {
                prompt: "resume with this file",
                openPaths: ["src/parked-context.ts"],
            });
            assert.equal((resumed.result as { action: string }).action, "injected_next_turn");
            assert.equal((resumed.result as { loopId: number }).loopId, loopId,
                "the prompt resumes the parked loop rather than opening another");
            releaseBoundary.resolve();

            await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (events) => events.some((event) => event.loopId === loopId),
                { timeoutMs: 5000 },
            );
            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number;
            }>({ loop_id: loopId });
            const frame = rows.find((row) => row.op === "prompt" && row.pathname === "/1/2");
            const contextRead = rows.find((row) => row.op === "READ" && row.origin === "plurnk" && row.scheme === null && row.pathname === "src/parked-context.ts");
            assert.ok(frame, "the waking prompt was published as its own frame");
            assert.ok(contextRead, "the waking prompt's selected path produced a core READ");
            assert.equal(contextRead.turn_id, frame.turn_id,
                "the context READ is observable in the resumed turn that publishes its prompt frame");
        } finally {
            releaseBoundary.resolve();
            ws.close();
        }
    });
});

test("{§prompt-loop-containment}: an injection crossing the park transition is not stranded", async (t) => {
    const previousSettlement = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (previousSettlement === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousSettlement;
    });
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [202] <-1>\npark"),
            sendOnly("## SEND0 [499]\ndone with the injected prompt"),
        ],
    });
    const parking = Promise.withResolvers<void>();
    const releasePark = Promise.withResolvers<void>();
    const park = LoopLifecycle.prototype.park;
    t.mock.method(LoopLifecycle.prototype, "park", async function (
        this: LoopLifecycle,
        ...args: Parameters<LoopLifecycle["park"]>
    ) {
        parking.resolve();
        await releasePark.promise;
        return park.apply(this, args);
    });
    t.after(() => releasePark.resolve());

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "inject-at-park-boundary" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const started = await rpcCall(ws, 2, "loop.run", {
                prompt: "start and park",
                flags: { auto: true },
            });
            const loopId = (started.result as { loopId: number }).loopId;
            await parking.promise;
            assert.equal(
                (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
                102,
                "the injection lands after SEND requests a park but before the lifecycle commits it",
            );

            const injected = await rpcCall(ws, 3, "loop.run", { prompt: "do not strand this prompt" });
            assert.equal((injected.result as { action: string }).action, "injected_next_turn");
            releasePark.resolve();

            await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (events) => events.some((event) => event.loopId === loopId),
                { timeoutMs: 5000 },
            );
            const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string }>({ loop_id: loopId });
            assert.ok(
                rows.some((row) => row.op === "prompt" && row.pathname === "/1/2"),
                "the park-boundary prompt reaches the resumed turn",
            );
        } finally {
            releasePark.resolve();
            ws.close();
        }
    });
});

test("{§prompt-loop-containment}: every orphaned prompt frame is promoted in order", async () => {
    // Edge: next-turn prompts injected into a loop that then terminates before
    // reaching that turn would be silently lost. Forced deterministically: hold
    // loop 1 at a proposal (status=102, turn 1), inject two turn-2 frames, then
    // let turn 1 emit SEND[200] so loop 1 ends and turn 2 never runs. The drain
    // must promote the orphaned frames to a fresh loop that surfaces them — so two
    // loops terminate for the worker, not one (it would be one if the wake were
    // lost; no other op here spawns a loop — the EXEC proposal is rejected).
    // 16384: the inject-then-reconcile path accumulates both loops' rows across turns, cresting at the 8192 edge;
    // grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the reconcile, not a budget probe.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            // The rejected EXEC is a same-turn failure — {§send-premature-terminate} refuses a [200] over
            // it, so loop 1 ends turn 1 by ABANDON (499, never gated): the orphan premise holds.
            sendOnly("## EXEC0 [sh]\ntrue\n\n## SEND0 [499]\nloop 1 abandons at turn 1"),  // pause, then end
            sendOnly("## SEND0 [200]\nreconciled loop ran"),                              // the promoted loop
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "reconcile-orphan" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const terminated = subscribeNotifications(ws, "loop/terminated");

            const firstPromise = rpcCall(ws, 2, "loop.run", {
                prompt: "kick off",
                flags: { noWeb: true },
            });
            const pending = await waitFor(() => proposals() as Array<{ logEntryId: number }>, (p) => p.length >= 1);

            // Inject two turn-2 frames while loop 1 is paused at turn 1.
            const r2 = await rpcCall(ws, 3, "loop.run", {
                prompt: "the first orphaned follow-up",
                openPaths: ["src/first-orphan-context.ts"],
            });
            assert.ok(r2.result !== undefined, JSON.stringify(r2.error));
            assert.equal((r2.result as { action: string }).action, "injected_next_turn", JSON.stringify(r2.result));
            const r3 = await rpcCall(ws, 4, "loop.run", {
                prompt: "the second orphaned follow-up",
                openPaths: ["src/second-orphan-context.ts"],
            });
            assert.ok(r3.result !== undefined, JSON.stringify(r3.error));
            assert.equal((r3.result as { action: string }).action, "injected_next_turn", JSON.stringify(r3.result));

            // Release the proposal → turn 1 emits SEND[200] → loop 1 ends; the
            // injected turn 2 never runs (it's now orphaned).
            await rpcCall(ws, 5, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
            const first = await firstPromise;
            const firstLoopId = (first.result as { loopId: number }).loopId;

            // The orphaned frames are reconciled into a second loop that runs.
            const ts = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (t) => t.length >= 2,
                { timeoutMs: 5000 },
            );
            assert.equal(ts.length, 2, "the orphaned wake was reconciled into a second loop (would be 1 if lost)");
            const statuses = ts.map((t) => t.result.status).toSorted((a, b) => a - b);
            assert.deepEqual(statuses, [200, 499], "loop 1 abandoned (499, over the rejected EXEC); the reconciled loop concluded 200");
            const promoted = ts.find((event) => event.loopId !== firstLoopId);
            assert.ok(promoted, "the orphaned frame was promoted into a distinct loop");
            const sourcePosture = await db.test_get_loop_posture.get<{
                flags: string; model_route_id: number | null; max_turns: number;
            }>({ id: firstLoopId });
            const promotedPosture = await db.test_get_loop_posture.get<{
                flags: string; model_route_id: number | null; max_turns: number; orphan_source_loop_id: number | null;
            }>({ id: promoted.loopId });
            assert.deepEqual(
                promotedPosture,
                { ...sourcePosture, orphan_source_loop_id: firstLoopId },
                "recovery preserves the source loop's posture and names its durable source",
            );
            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number; rx: string;
            }>({ loop_id: promoted.loopId });
            const frames = rows.filter((row) => row.op === "prompt");
            assert.deepEqual(
                frames.map((row) => ({
                    pathname: row.pathname,
                    content: (JSON.parse(row.rx) as { content: string }).content,
                })),
                [
                    { pathname: "/2/1", content: "the first orphaned follow-up" },
                    { pathname: "/2/2", content: "the second orphaned follow-up" },
                ],
                "the complete orphan set remains separate and ordered in one subsequent turn",
            );
            const contextReads = rows.filter((row) => row.op === "READ" && row.origin === "plurnk" && row.scheme === null);
            assert.deepEqual(
                contextReads.map((row) => row.pathname),
                ["src/first-orphan-context.ts", "src/second-orphan-context.ts"],
                "each promoted frame keeps its selected paths in frame order",
            );
            assert.ok(contextReads.every((row) => row.turn_id === frames[0]?.turn_id),
                "all promoted frame paths are read in the turn that publishes the frames");
            const promptPaths = await db.test_prompt_paths_by_owner.all<{ pathname: string }>({ owner_id: (r2.result as { modelWorkerId: number }).modelWorkerId });
            assert.deepEqual(
                promptPaths.map((row) => row.pathname),
                ["/1/1", "/2/1", "/2/2"],
                "recovery re-homes each orphan identity instead of retaining duplicate old addresses",
            );
        } finally { ws.close(); }
    });
});

test("loop.cancel reaps the worker's open streams by the subscription registry (closed 499)", async () => {
    // A backgrounded sleep registers an OPEN exec subscription; loop.cancel must reap
    // it THROUGH the registry — the open row closes with the exact 499 Problem — not
    // merely fire a notification. The indexed status is only a relational projection.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [202] <-1>\nbackgrounded"),
            sendOnly("## SEND0 [200]\ndone"),
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
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n === 1,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            try { await loopPromise; } catch { /* cancelled */ }

            // The registry reap closed the subscription — open→0, deterministically.
            await waitForDb(
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n === 0,
            );
            const closeStatus = (await db.test_exec_close_status_by_workspace.get<{ close_status: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.close_status;
            assert.equal(closeStatus, 499, "the reaped exec subscription is closed at 499 in the registry");
        } finally { ws.close(); }
    });
});

test("a cancelled worker is not revived by its straggler stream's conclusion", async () => {
    // After loop.cancel, the backgrounded exec's conclusion must NOT open a fresh loop
    // in the worker — the cancel was deliberate. Proven by the worker's loop count staying at
    // its single model loop after the conclusion lands (a resurrection would add a
    // wake-opened loop), plus the conclusion's wakeAction being a skip, not opened-loop.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [202] <-1>\nbackgrounded"),
            sendOnly("## SEND0 [200]\nshould never run"),
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
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
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
            const workerId = (await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId }))?.worker_id;
            const loopCount = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: workerId }))?.n;
            assert.equal(loopCount, 1, "no wake loop was opened for the cancelled worker");
        } finally { ws.close(); }
    });
});
