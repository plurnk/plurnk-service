// Wake-on-completion daemon decision tree (§worker-lifecycle-wake-liveness). When an exec
// spawn concludes (an OPEN stream-status transition), Daemon.#handleWakeWorker picks one of:
//   - "no-op-active-loop" — the worker has a live drain; the conclusion folds into its next turn
//   - "resumed-loop" — the worker is parked at a slept (202) loop; that SAME loop resumes in place
//   - "skipped-aborted" — closeStatus=499 (deliberate cancel) — no resume
//
// These exercise the daemon end-to-end through real WS calls with a
// Mock provider. Mock emissions use the EXEC op per plurnk.md.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, waitFor, waitForDb, runLoopToTerminal } from "./_rpc.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";

const execDsl = (command: string): string =>
    `<<EXEC[sh]:${command}:EXEC\n<<SEND[102]<-1>:done:SEND`;

const mockResponse = (dsl: string) => {
    // grammar 0.70: turns lead with PLAN. No `ops` here → the Engine re-parses
    // content, so the PLAN must be in the content the mock emits.
    const turn = dsl.startsWith("<<PLAN") ? dsl : `<<PLAN::PLAN\n${dsl}`;
    return {
        assistant: {
            content: turn,
            reasoning: null,
            usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
        },
        assistantRaw: null,
    };
};

test("#598: an async wake resumes with the loop's durable provider, never the boot default", async () => {
    const boot = new Mock({
        contextWindow: 16384,
        responses: [mockResponse("<<SEND[500]:boot provider must never run this loop:SEND")],
    });
    const selected = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("sleep 1; echo selected")),
            mockResponse("<<SEND[200]:resumed on selected provider:SEND"),
        ],
    });
    const selectedSpec = { alias: "wakeb", provider: "openai", model: "wake-provider-b" } as const;
    const prior = process.env.PLURNK_MODEL_wakeb;
    process.env.PLURNK_MODEL_wakeb = "openai/wake-provider-b";
    ProviderInstantiate.registerInstance(selected, selectedSpec);

    try {
        await withDaemon(boot, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-provider-identity" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const started = await rpcCall(ws, 2, "loop.run", {
                    prompt: "run on B, park, then resume on B",
                    alias: "wakeb",
                    model: "openai/wake-provider-b",
                    flags: { auto: true },
                });
                const loopId = (started.result as { loopId: number }).loopId;

                await waitForDb(
                    async () => (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status,
                    (status) => status === 202,
                );

                // A repeated client call naming a DIFFERENT provider must not mutate a
                // parked loop. Mid-loop hot-swap is not an implicit side effect of prompt
                // injection; the caller must conclude/cancel and open a new loop.
                const conflict = await rpcCall(ws, 3, "loop.run", {
                    prompt: "silently change this parked loop to the boot model",
                    alias: "mocktest",
                    model: "openai/mocktest",
                    flags: { auto: true },
                });
                assert.match(conflict.error?.message ?? "", /provider selection is frozen/,
                    "a conflicting provider request against the parked loop fails loudly");

                await waitFor(
                    () => terminated() as Array<{ loopId: number; finalStatus: number }>,
                    (events) => events.some((event) => event.loopId === loopId && event.finalStatus === 200),
                    { timeoutMs: 6000 },
                );
                assert.equal(selected.remaining, 0, "provider B generated both the initial and resumed turns");
                assert.equal(boot.remaining, 1, "boot-default provider A was never called");
            } finally { ws.close(); }
        });
    } finally {
        if (prior === undefined) delete process.env.PLURNK_MODEL_wakeb;
        else process.env.PLURNK_MODEL_wakeb = prior;
    }
});

test("#598: a parked loop retains its provider across daemon restart", async () => {
    const boot = new Mock({
        contextWindow: 16384,
        responses: [mockResponse("<<SEND[500]:boot provider must remain unused:SEND")],
    });
    const selected = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("sleep 30")),
            mockResponse("<<SEND[200]:resumed after restart on selected provider:SEND"),
        ],
    });
    const selectedSpec = { alias: "restartb", provider: "openai", model: "restart-provider-b" } as const;
    const prior = process.env.PLURNK_MODEL_restartb;
    process.env.PLURNK_MODEL_restartb = "openai/restart-provider-b";
    ProviderInstantiate.registerInstance(selected, selectedSpec);

    const db = await openMigrated();
    let first: Daemon | undefined;
    let second: Daemon | undefined;
    try {
        first = new Daemon({ db, provider: boot });
        await first.start();
        const envelope = await first.createWorkspace({ name: "exec-wake-provider-restart", projectRoot: null });
        const workerId = await first.ensureModelWorker(envelope.workspaceId);
        const started = await first.runLoop({
            workspaceId: envelope.workspaceId,
            workerId,
            prompt: "park on B before restart",
            alias: "restartb",
            model: "openai/restart-provider-b",
            flags: { auto: true },
        });
        await waitForDb(
            async () => (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: started.loopId }))?.status,
            (status) => status === 202,
        );
        await first.stop();
        first = undefined;

        second = new Daemon({ db, provider: boot });
        await second.start();
        const terminated: Array<{ loopId: number; finalStatus: number }> = [];
        second.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number; finalStatus: number });
        });
        const resumed = await second.runLoop({
            workspaceId: envelope.workspaceId,
            workerId,
            prompt: "resume the parked loop after restart",
            alias: "restartb",
            model: "openai/restart-provider-b",
            flags: { auto: true },
        });
        assert.equal(resumed.loopId, started.loopId, "restart resumes the same durable loop");
        await waitFor(
            () => terminated,
            (events) => events.some((event) => event.loopId === started.loopId && event.finalStatus === 200),
            { timeoutMs: 6000 },
        );
        assert.equal(selected.remaining, 0, "B generated before and after daemon restart");
        assert.equal(boot.remaining, 1, "restart never substituted boot-default A");
    } finally {
        if (first !== undefined) await first.stop();
        if (second !== undefined) await second.stop();
        await db.close();
        if (prior === undefined) delete process.env.PLURNK_MODEL_restartb;
        else process.env.PLURNK_MODEL_restartb = prior;
    }
});

test("wake-on-completion: a slept (202) loop resumes IN PLACE — no new loop, no summary-as-prompt", async () => {
    // First loop: EXEC echo + SEND[202] (Accepted) — the loop SLEEPS while the
    // spawn runs on. When the spawn concludes (an OPEN stream-status transition,
    // §actor-boundary-passive-wake), the daemon AWAKENS that same loop in place —
    // never a fresh loop with a synthetic summary prompt. The resumed loop reads
    // the concluded stream's own state and finishes on its own.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("echo hi")),
            mockResponse("<<SEND[200]:saw the wake:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-dormant" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");
            const terminatedEvents = subscribeNotifications(ws, "loop/terminated");

            // loop.run ACCEPTS and returns immediately (100 + loopId) — it never blocks on
            // the loop's lifecycle. A parked loop awaits an external event (here the spawn's
            // conclusion; in general a user reply), so loop.run cannot resolve on it without
            // deadlocking the very client that must send that event. Park, resume, and the
            // true terminal all arrive via events. §worker-lifecycle-wake-liveness.
            const firstWorker = await rpcCall(ws, 2, "loop.run", { prompt: "kick off exec then park", flags: { auto: true } });
            const parkedLoop = (firstWorker.result as { loopId: number }).loopId;
            assert.equal((firstWorker.result as { finalStatus: number }).finalStatus, 100, "loop.run returns immediately (100 accepted) — never a fake 200/202 standing in for the loop's real outcome");

            // echo hi is fast; the conclusion fires after the loop sleeps; the daemon
            // RESUMES the same loop; that resumed turn terminates it. Event-driven —
            // wait for the resume to land AND the loop to terminate. Hard-fails on a
            // timeout if the slept loop is ever stranded (the lost-loop hang), instead
            // of a fixed sleep that hides it under load.
            await waitFor(
                () => terminatedEvents() as Array<{ loopId: number; finalStatus: number }>,
                (ts) => {
                    const wake = (concludedEvents() as Array<{ scheme: string; wakeLoopId?: number }>).find((c) => c.scheme === "sh");
                    return wake?.wakeLoopId !== undefined && ts.some((t) => t.loopId === wake.wakeLoopId && t.finalStatus === 200);
                },
                { timeoutMs: 6000 },
            );

            const concluded = concludedEvents() as Array<{
                scheme: string; target: string; closeStatus: number; summary: string;
                wakeAction: string; wakeLoopId?: number;
                loop_seq?: number; turn_seq?: number; sequence?: number;
            }>;
            assert.ok(concluded.length >= 1, `expected >=1 stream/concluded event, got ${concluded.length}`);
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.closeStatus, 200);
            assert.match(wake.target, /^sh:\/\/\//, "stream/concluded carries the tag-authority target URI (#179)");
            assert.match(wake.summary, /^sh:\/\/\/\d+\/\d+\/\d+ completed \(exit 0\)/,
                "summary references the tag-authority <runtime>:///<loop>/<turn>/<seq> path");
            assert.equal(wake.wakeAction, "resumed-loop", "the daemon resumed the slept loop in place");
            // The resume-in-place lock: the woken loop IS the parked loop, not a new one.
            assert.equal(wake.wakeLoopId, parkedLoop, "the SAME slept loop resumed — no fresh loop opened");

            // #224 — the coordinate the waterfall TUI used to parse out of the
            // exec URI is now explicit fields; assert they agree with the URI.
            const seg = wake.target.replace(/^sh:\/\/\//, "").split("/");  // [loop, turn, seq]
            assert.equal(wake.loop_seq, Number(seg[0]), "stream/concluded carries loop_seq as a field matching the URI (#224)");
            assert.equal(wake.turn_seq, Number(seg[1]), "carries turn_seq");
            assert.equal(wake.sequence, Number(seg[2]), "carries sequence");

            // The loop's TRUE outcome arrives via loop/terminated — the resumed loop ends 200,
            // never through loop.worker's (already-returned) result.
            const terminated = terminatedEvents() as Array<{ loopId: number; finalStatus: number }>;
            assert.ok(terminated.some((t) => t.loopId === parkedLoop && t.finalStatus === 200),
                "the resumed loop's 200 terminal arrives via events, not loop.worker's return");
        } finally { ws.close(); }
    });
});

test("wake-on-completion: active loop → daemon does NOT open a new loop (no-op-active-loop)", async () => {
    // Loop emits exec + a SEND[102] continuation per turn — the loop
    // stays active across multiple turns. The exec finishes mid-loop;
    // wake should see active loop and skip.
    const continueResponse = mockResponse("<<SEND[102]:thinking:SEND");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("echo soon").replace("SEND[102]<-1>", "SEND[102]")),
            continueResponse,
            continueResponse,
            continueResponse,
            mockResponse("<<SEND[200]:done:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-active" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            await runLoopToTerminal(ws, 2, { prompt: "stay active during exec", flags: { auto: true } });
            await flush();
            // Event-driven: wait for the exec to conclude (it finishes while the loop is
            // still emitting SEND[102] continuations), not a fixed sleep racing the spawn.
            await waitFor(
                () => concludedEvents() as Array<{ scheme: string }>,
                (cs) => cs.some((c) => c.scheme === "sh"),
                { timeoutMs: 5000 },
            );

            const concluded = concludedEvents() as Array<{ scheme: string; wakeAction: string }>;
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.wakeAction, "no-op-active-loop",
                "wake declined to open a new loop because the original was still active");
        } finally { ws.close(); }
    });
});

test("wake-on-completion: streaming spawn outlives loop — wake summary reports the FULL final byte count, not what was buffered at loop-end", async () => {
    // A countdown emits 5 lines over ~2.5s. The model SEND[202]s — the loop SLEEPS
    // while the countdown runs on. When the countdown concludes, the loop RESUMES in
    // place, and the conclusion's summary reflects the COMPLETE stdout (10 bytes for
    // "5\n4\n3\n2\n1\n") — proving the streaming continued past the sleep and the
    // conclusion is the final state, not a partial snapshot buffered at sleep-time.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(`<<EXEC[sh]:for i in 5 4 3 2 1; do echo $i; sleep 0.4; done:EXEC\n<<SEND[102]<-1>:fire and forget:SEND`),
            // Wake-opened loop just terminates so the test completes:
            mockResponse("<<SEND[200]:saw the wake:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-streaming" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            const startedAt = Date.now();
            const firstResp = await rpcCall(ws, 2, "loop.run", { prompt: "stream while I leave", flags: { auto: true } });
            const firstResult = firstResp.result as { loopId: number; finalStatus: number };
            const parkedLoop = firstResult.loopId;
            const firstElapsed = Date.now() - startedAt;
            assert.equal(firstResult.finalStatus, 100, "loop.run returns immediately (100 accepted); the spawn's late conclusion resumes the loop");
            // loop.run accepts immediately — it returns well before the spawn's ~2.5s.
            // The resume path handles the spawn's late conclusion, not a blocking loop.run.
            assert.ok(firstElapsed < 1500,
                `loop.run returns before the spawn finishes (~2.5s); got ${firstElapsed}ms`);

            // Event-driven: wait for the ~2.5s countdown spawn to conclude (200) and its
            // wake to fire, not a fixed sleep that flakes if the spawn runs long under load.
            await waitFor(
                () => concludedEvents() as Array<{ scheme: string; closeStatus: number }>,
                (cs) => cs.some((c) => c.scheme === "sh" && c.closeStatus === 200),
                { timeoutMs: 8000 },
            );

            const concluded = concludedEvents() as Array<{
                scheme: string; closeStatus: number; summary: string; wakeAction: string; wakeLoopId?: number;
            }>;
            const wake = concluded.find((c) => c.scheme === "sh" && c.closeStatus === 200);
            assert.ok(wake, "exec stream concluded");
            // The KEY assertion: summary has the FULL byte count, not
            // whatever happened to be in the channel when loop ended.
            assert.match(wake.summary, /stdout=10 bytes/,
                `summary should report the full final stdout=10 bytes ("5\\n4\\n3\\n2\\n1\\n"); got ${wake.summary}`);
            assert.equal(wake.wakeAction, "resumed-loop", "the slept loop resumed in place");
            assert.equal(wake.wakeLoopId, parkedLoop, "the SAME slept loop resumed — no fresh loop");
        } finally { ws.close(); }
    });
});

test("wake-on-completion: loop.cancel mid-spawn → daemon skips wake (skipped-aborted)", async () => {
    // Slow exec; loop.cancel RPC fires the drain controller; spawn aborts
    // with closeStatus=499; daemon's handler skips opening a wake loop.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(`<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND`),
            mockResponse("<<SEND[200]:never:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-cancelled" });
            const workspaceId = (created.result as { id: number }).id;
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "cancel mid-stream", flags: { auto: true } });
            await flush();
            // Cancel must land on a LIVE exec (sleep 30 mid-run) — wait for its subscription
            // to open, not a fixed sleep racing the spawn (the flake this replaces).
            await waitForDb(
                async () => (await (db.test_count_open_subs_by_scheme as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            try { await loopPromise; } catch { /* cancelled */ }

            // Event-driven: wait for the exec's 499 conclusion to broadcast.
            await waitFor(
                () => concludedEvents() as Array<{ scheme: string }>,
                (cs) => cs.some((c) => c.scheme === "sh"),
                { timeoutMs: 5000 },
            );

            const concluded = concludedEvents() as Array<{ scheme: string; closeStatus: number; wakeAction: string }>;
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.closeStatus, 499);
            assert.equal(wake.wakeAction, "skipped-aborted",
                "deliberate cancellations don't resurrect into a wake loop");
        } finally { ws.close(); }
    });
});

test("loop.cancel preserves partial stdout on the 499 conclusion (chunk-capture)", async () => {
    // printf lands "a\nb\n" (4 bytes) immediately, then `sleep 30` runs; at
    // cancel time those bytes are already in the channel. loop.cancel
    // process-group-kills the job (execs 0.4.0+ fixed #4); the 499
    // conclusion must STILL report those 4 bytes — partial output captured
    // + retained through an abort, not discarded.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(`<<EXEC[sh]:printf 'a\\nb\\n'; sleep 30:EXEC\n<<SEND[102]:running:SEND`),
            mockResponse("<<SEND[200]:never:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-cancel-partial" });
            const streamEvents = subscribeNotifications(ws, "stream/event");
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "cancel after partial output", flags: { auto: true } });

            // Deterministic: cancel only AFTER the 4 bytes have actually
            // landed in the stdout channel — no fixed sleep racing printf.
            await waitFor(
                () => streamEvents() as Array<{ channel: string; contentLength: number }>,
                (evs) => evs.some((e) => e.channel === "stdout" && e.contentLength >= 4),
                { timeoutMs: 4000 },
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            try { await loopPromise; } catch { /* cancelled */ }

            await waitFor(
                () => concludedEvents() as Array<{ scheme: string }>,
                (cs) => cs.some((c) => c.scheme === "sh"),
                { timeoutMs: 4000 },
            );

            const concluded = concludedEvents() as Array<{ scheme: string; closeStatus: number; summary: string }>;
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.closeStatus, 499, "deliberate cancel concludes at 499");
            assert.match(wake.summary, /stdout=4 bytes/,
                `partial stdout ("a\\nb\\n" = 4 bytes) survives the abort; got ${wake.summary}`);
        } finally { ws.close(); }
    });
});
