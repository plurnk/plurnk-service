import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, makeMockResponse, runLoopToTerminal, waitFor } from "./_rpc.ts";

test("[§methods-loop-run] loop.run accepts immediately (100); the loop's outcome arrives via loop/terminated", async () => {
    const dsl = "<<EDIT(known:///france/capital):Paris:EDIT\n<<SEND[200]:Paris is the capital.:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 142)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "loop-test" });
            // loop.run accepts and returns immediately (100 + loopId); the terminal outcome —
            // finalStatus, turnIds, usage — rides loop/terminated, surfaced here by the helper.
            const result = await runLoopToTerminal(ws, 2, { prompt: "what is the capital of france?" });
            assert.equal(result.accepted, 100, "loop.run returns immediately — accepted, not the terminal");
            assert.equal(result.finalStatus, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds?.length, 1);
            // #197 — loop/terminated carries usage summed over the loop's turns.
            assert.equal(result.usage?.completionTokens, 142, "completion tokens summed from the turn");
            assert.equal(result.usage?.promptTokens, 0);
            assert.equal(result.usage?.costPico, 0);

            const entryCount = (await (db.test_count_entries as PrepMethod).get<{ n: number }>())?.n;
            // known:///france/capital + plurnk:///manifest.json + plurnk://prompt/<loop> (3 base), plus 8
            // docs: the 4 non-excluded in-tree schemes (log/known/unknown/run — plurnk/file/exec dropped by
            // the default PLURNK_DOCS_EXCLUDE), the boot-discovered `http` external, and sh/node/sqlite —
            // executor docs that execs 0.4.15 now ships (plurnk-execs#12 handoff landed). 3 + 8 = 11.
            assert.equal(entryCount, 11);
        } finally { ws.close(); }
    });
});

test("loop.inject speaks into an existing run; errors when there's none (#193)", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<SEND[200]:first done:SEND", 10),
        makeMockResponse("<<SEND[200]:injected done:SEND", 10),
    ] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "loop-inject" });

            // No model run yet → inject has nothing to talk to (loop.run starts one).
            const noRun = await rpcCall(ws, 2, "loop.inject", { prompt: "too early" });
            assert.ok(noRun.error !== undefined, "inject before any run errors");
            assert.match(noRun.error!.message, /no model run/);

            // Start a run; SEND[200] ends it, leaving the run idle. Wait for the terminal
            // (loop.run no longer blocks) so the run is genuinely idle before we inject.
            await runLoopToTerminal(ws, 3, { prompt: "first", flags: { yolo: true } });

            // Inject into the idle run → enqueues a fresh loop, returns immediately.
            const injected = await rpcCall(ws, 4, "loop.inject", { prompt: "BTW, the config is TOML" });
            const result = injected.result as { action: string; loopId: number; modelRunId: number };
            assert.equal(result.action, "enqueued_new_loop", "idle run → a fresh enqueued loop");
            assert.ok(typeof result.loopId === "number", "returns the loopId");
            assert.ok(typeof result.modelRunId === "number", "returns the run it spoke into");

            // empty prompt is a contract violation.
            const empty = await rpcCall(ws, 5, "loop.inject", { prompt: "" });
            assert.ok(empty.error !== undefined, "empty prompt errors");
        } finally { ws.close(); }
    });
});

test("run.fork branches the model run into a new -fork run; names it at instantiation; errors with no run (#228, #248)", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<EDIT(known:///x):hi:EDIT\n<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "fork-test" });

            // No model run yet → nothing to fork.
            const noRun = await rpcCall(ws, 2, "run.fork", {});
            assert.ok(noRun.error, "fork with no model run errors");
            assert.match(noRun.error!.message, /no model run/);

            // A loop builds the model run + its log; forking branches it. Wait for the
            // terminal so the log is settled before the fork copies it.
            await runLoopToTerminal(ws, 3, { prompt: "do a thing" });
            const fork = await rpcCall(ws, 4, "run.fork", {});
            const r = fork.result as { runId: number; runName: string | null; parentRunId: number };
            assert.ok(typeof r.runId === "number" && typeof r.parentRunId === "number", "returns new + parent run ids");
            assert.notEqual(r.runId, r.parentRunId, "the fork is a distinct run");
            assert.match(r.runName ?? "", /-fork$/, "the fork is named <parent>-fork by default");

            // #248 — an explicit name names the branch at instantiation (immutable after; no rename).
            const named = await rpcCall(ws, 5, "run.fork", { name: "harvest" });
            assert.equal((named.result as { runName: string | null }).runName, "harvest", "an explicit name names the branch");

            // Reserved + taken names are refused up front (runs.name is UNIQUE per session) —
            // mirrors session.attach, never falling through to the insert.
            const reserved = await rpcCall(ws, 6, "run.fork", { name: "plurnk" });
            assert.ok(reserved.error, "the reserved name is refused");
            assert.match(reserved.error!.message, /reserved/);

            const taken = await rpcCall(ws, 7, "run.fork", { name: "harvest" });
            assert.ok(taken.error, "a name already in the session is refused — names are immutable");
            assert.match(taken.error!.message, /already exists/);

            const empty = await rpcCall(ws, 8, "run.fork", { name: "" });
            assert.ok(empty.error, "an empty name is refused");
            assert.match(empty.error!.message, /non-empty/);
        } finally { ws.close(); }
    });
});

test("loop.run streams log/entry notifications during execution", async () => {
    const dsl = "<<EDIT(known:///x):hello:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logEntries = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "session.create", { name: "stream-test" });
            // loop.run returns immediately; wait for the loop to terminate so all its
            // log/entry notifications have fired before we inspect them.
            await runLoopToTerminal(ws, 2, { prompt: "test" });
            await flush();

            const captured = logEntries();
            // §notifications / #198 — the turn-1 prompt-foist (system-origin EDIT, the
            // user's words entering the run) broadcasts too, ahead of the
            // model's ops; previously it was written but never notified.
            assert.equal(captured.length, 4);
            const prompt = captured[0] as { entry: { op: string; origin: string } };
            assert.equal(prompt.entry.op, "EDIT");
            assert.equal(prompt.entry.origin, "plurnk");
            // PLAN leads every model turn (grammar 0.70) — dispatched + broadcast to the
            // client as an ordinary log op (this is the "pass PLAN along" behavior).
            const plan = captured[1] as { entry: { op: string; origin: string } };
            assert.equal(plan.entry.op, "PLAN");
            assert.equal(plan.entry.origin, "model");
            const first = captured[2] as { entry: { op: string; origin: string } };
            assert.equal(first.entry.op, "EDIT");
            assert.equal(first.entry.origin, "model");
            const second = captured[3] as { entry: { op: string; status_rx: number } };
            assert.equal(second.entry.op, "SEND");
            assert.equal(second.entry.status_rx, 200);
        } finally { ws.close(); }
    });
});

test("loop.run fires loop/terminated notification on completion", async () => {
    const dsl = "<<EDIT(known:///x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "session.create", { name: "term-test" });
            // loop.run returns immediately (100 accepted); the loop's outcome rides loop/terminated.
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            const ack = accept.result as { finalStatus: number; turnIds: number[] };
            assert.equal(ack.finalStatus, 100, "loop.run accepts immediately, not the terminal");
            assert.deepEqual(ack.turnIds, [], "the 100-ack carries turnIds — always present, never absent (#266)");
            const captured = await waitFor(
                () => terminated() as Array<{ loopId: number; finalStatus: number; hitMaxTurns: boolean; usage: { promptTokens: number; completionTokens: number; costPico: number } }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1);
            const params = captured[0];
            assert.equal(params.finalStatus, 200);
            assert.equal(params.hitMaxTurns, false);
            // #197 — loop/terminated carries the loop's usage totals.
            assert.equal(params.usage.completionTokens, 50);
        } finally { ws.close(); }
    });
});

test("loop.run still fires loop/terminated when the loop throws — no client hang (#265)", async () => {
    // A loop that ERRORS (terminal provider failure / engine throw — not a clean SEND, abort, or
    // strike-abandonment) must STILL broadcast loop/terminated: loop.run only acked 100, so it's the
    // async client's sole outcome channel. One non-terminal turn, then the Mock exhausts — generate()
    // throws a plain Error, runTurn re-throws (non-ProviderError → throw), it escapes runLoop to the
    // drain. Pre-#265 the drain rejected the already-.catch()'d promise and broadcast nothing → hang.
    const dsl = "<<EDIT(known:///x):iter:EDIT\n<<SEND[102]:continue:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 10)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "session.create", { name: "errored-loop" });
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "go", maxTurns: 5 });
            assert.equal((accept.result as { finalStatus: number }).finalStatus, 100, "loop.run accepts immediately (100)");

            const captured = await waitFor(
                () => terminated() as Array<{ finalStatus: number; turnIds: number[]; hitMaxTurns: boolean }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1, "the errored loop fired loop/terminated — the client is not left hanging (#265)");
            assert.equal(captured[0].finalStatus, 500, "a genuine loop error terminates at 500 (failed) — distinct from an abort's 499");
            assert.deepEqual(captured[0].turnIds, [], "turnIds is always present — [] at the error boundary, never absent (#266)");
            assert.equal(captured[0].hitMaxTurns, false);
        } finally { ws.close(); }
    });
});

test("loop.run without provider returns 501", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "no-provider" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "anything" });
            const result = response.result as { status: number; error?: string };
            assert.equal(result.status, 501);
        } finally { ws.close(); }
    });
});

test("loop.run requires non-empty prompt", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "empty-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /non-empty params\.prompt/);
        } finally { ws.close(); }
    });
});

test("loop.run respects maxTurns cap when model emits non-terminal statuses repeatedly", async () => {
    const dsl = "<<EDIT(known:///x):iter:EDIT\n<<SEND[102]:continue:SEND";
    const responses = Array.from({ length: 5 }, () => makeMockResponse(dsl, 10));
    const mock = new Mock({ contextSize: 8192, responses });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "maxturns-test" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "iterate", maxTurns: 3 });
            assert.equal(result.accepted, 100, "loop.run accepts immediately");
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429, "max_turns exhausts the turn ceiling → 429");
            assert.equal(result.turnIds?.length, 3);
        } finally { ws.close(); }
    });
});

test("discover catalog includes loop.run and loop/terminated", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { methods: Record<string, { longRunning?: boolean }>; notifications: Record<string, unknown> };
            assert.ok(cat.methods["loop.run"] !== undefined);
            assert.equal(cat.methods["loop.run"].longRunning, false,
                "loop.run accepts and returns immediately (Model 3); the loop runs async, surfaced via loop/terminated");
            assert.ok(cat.notifications["loop/terminated"] !== undefined);
        } finally { ws.close(); }
    });
});
