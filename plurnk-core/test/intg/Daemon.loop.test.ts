import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, makeMockResponse, runLoopToTerminal, waitFor } from "./_rpc.ts";

test("[§methods-loop-run] loop.run accepts immediately (100); the loop's outcome arrives via loop/terminated", async () => {
    const dsl = "<<EDIT(worker:///france/capital):Paris:EDIT\n<<SEND[200]:Paris is the capital.:SEND";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 142)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-test" });
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
            // worker:///france/capital + the prompt frame (2 base — no manifest.json entry, the
            // catalog is FIND-served), plus 11 docs: the 3 non-excluded in-tree schemes (log/worker/prompt
            // — file/exec dropped by the default PLURNK_SERVICE_DOCS_EXCLUDE, skill excluded too), the
            // boot-discovered `http` + `wss` + `mcp` externals (#473), and sh/node/sqlite/git/jq —
            // executor docs the execs family ships. 2 + 11 = 13.
            assert.equal(entryCount, 13);
        } finally { ws.close(); }
    });
});

test("loop.inject speaks into an existing run; errors when there's none (#193)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<SEND[200]:first done:SEND", 10),
        makeMockResponse("<<SEND[200]:injected done:SEND", 10),
    ] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-inject" });

            // No model worker yet → inject has nothing to talk to (loop.run starts one).
            const noWorker = await rpcCall(ws, 2, "loop.inject", { prompt: "too early" });
            assert.ok(noWorker.error !== undefined, "inject before any worker errors");
            assert.match(noWorker.error!.message, /no model worker/);

            // Start a worker; SEND[200] ends it, leaving the worker idle. Wait for the terminal
            // (loop.run no longer blocks) so the worker is genuinely idle before we inject.
            await runLoopToTerminal(ws, 3, { prompt: "first", flags: { yolo: true } });

            // Inject into the idle run → enqueues a fresh loop, returns immediately.
            const injected = await rpcCall(ws, 4, "loop.inject", { prompt: "BTW, the config is TOML" });
            const result = injected.result as { action: string; loopId: number; modelWorkerId: number };
            assert.equal(result.action, "enqueued_new_loop", "idle run → a fresh enqueued loop");
            assert.ok(typeof result.loopId === "number", "returns the loopId");
            assert.ok(typeof result.modelWorkerId === "number", "returns the worker it spoke into");

            // empty prompt is a contract violation.
            const empty = await rpcCall(ws, 5, "loop.inject", { prompt: "" });
            assert.ok(empty.error !== undefined, "empty prompt errors");
        } finally { ws.close(); }
    });
});

test("run.fork branches the model worker into a new -fork run; names it at instantiation; errors with no worker (#228, #248)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("<<EDIT(worker:///x):hi:EDIT\n<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "fork-test" });

            // No model worker yet → nothing to fork.
            const noWorker = await rpcCall(ws, 2, "run.fork", {});
            assert.ok(noWorker.error, "fork with no model worker errors");
            assert.match(noWorker.error!.message, /no model worker/);

            // A loop builds the model worker + its log; forking branches it. Wait for the
            // terminal so the log is settled before the fork copies it.
            await runLoopToTerminal(ws, 3, { prompt: "do a thing" });
            const fork = await rpcCall(ws, 4, "run.fork", {});
            const r = fork.result as { workerId: number; workerName: string | null; parentWorkerId: number };
            assert.ok(typeof r.workerId === "number" && typeof r.parentWorkerId === "number", "returns new + parent run ids");
            assert.notEqual(r.workerId, r.parentWorkerId, "the fork is a distinct run");
            assert.match(r.workerName ?? "", /-fork-\d+$/, "the fork is named <parent>-fork-<N> by default (unique per fork)");

            // #248 — an explicit name names the branch at instantiation (immutable after; no rename).
            const named = await rpcCall(ws, 5, "run.fork", { name: "harvest" });
            assert.equal((named.result as { workerName: string | null }).workerName, "harvest", "an explicit name names the branch");

            // Reserved + taken names are refused up front (workers.name is UNIQUE per workspace) —
            // mirrors workspace.attach, never falling through to the insert.
            const reserved = await rpcCall(ws, 6, "run.fork", { name: "plurnk" });
            assert.ok(reserved.error, "the reserved name is refused");
            assert.match(reserved.error!.message, /reserved/);

            const taken = await rpcCall(ws, 7, "run.fork", { name: "harvest" });
            assert.ok(taken.error, "a name already in the workspace is refused — names are immutable");
            assert.match(taken.error!.message, /already exists/);

            const empty = await rpcCall(ws, 8, "run.fork", { name: "" });
            assert.ok(empty.error, "an empty name is refused");
            assert.match(empty.error!.message, /non-empty/);
        } finally { ws.close(); }
    });
});

test("loop.run streams log/entry notifications during execution", async () => {
    const dsl = "<<EDIT(worker:///x):hello:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logEntries = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "stream-test" });
            // loop.run returns immediately; wait for the loop to terminate so all its
            // log/entry notifications have fired before we inspect them.
            await runLoopToTerminal(ws, 2, { prompt: "test" });
            await flush();

            const captured = logEntries();
            // §notifications / #198 — the turn-1 prompt-foist (system-origin EDIT, the
            // user's words entering the worker) broadcasts too, ahead of the model's ops —
            // and so does its auto-READ (§prompt-auto-read).
            assert.equal(captured.length, 5);
            const prompt = captured[0] as { entry: { op: string; origin: string } };
            assert.equal(prompt.entry.op, "EDIT");
            assert.equal(prompt.entry.origin, "plurnk");
            // §prompt-auto-read — the prompt's body arrives as a foisted READ, broadcast too.
            const autoRead = captured[1] as { entry: { op: string; origin: string } };
            assert.equal(autoRead.entry.op, "READ");
            assert.equal(autoRead.entry.origin, "plurnk");
            // PLAN leads every model turn (grammar 0.70) — dispatched + broadcast to the
            // client as an ordinary log op (this is the "pass PLAN along" behavior).
            const plan = captured[2] as { entry: { op: string; origin: string } };
            assert.equal(plan.entry.op, "PLAN");
            assert.equal(plan.entry.origin, "model");
            const first = captured[3] as { entry: { op: string; origin: string } };
            assert.equal(first.entry.op, "EDIT");
            assert.equal(first.entry.origin, "model");
            const second = captured[4] as { entry: { op: string; status_rx: number } };
            assert.equal(second.entry.op, "SEND");
            assert.equal(second.entry.status_rx, 200);
        } finally { ws.close(); }
    });
});

test("loop.run fires loop/terminated notification on completion", async () => {
    const dsl = "<<EDIT(worker:///x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "term-test" });
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
    const dsl = "<<EDIT(worker:///x):iter:EDIT\n<<SEND[102]:continue:SEND";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 10)] });
    // #506 — the death must reach the daemon log too. Capture stderr around the run.
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map((x) => x instanceof Error ? x.stack ?? x.message : String(x)).join(" ")); };

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const telemetry = subscribeNotifications(ws, "telemetry/event");
            await rpcCall(ws, 1, "workspace.create", { name: "errored-loop" });
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "go", maxTurns: 5 });
            assert.equal((accept.result as { finalStatus: number }).finalStatus, 100, "loop.run accepts immediately (100)");

            const captured = await waitFor(
                () => terminated() as Array<{ finalStatus: number; turnIds: number[]; hitMaxTurns: boolean; loopId: number }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1, "the errored loop fired loop/terminated — the client is not left hanging (#265)");
            assert.equal(captured[0].finalStatus, 500, "a genuine loop error terminates at 500 (failed) — distinct from an abort's 499");
            assert.deepEqual(captured[0].turnIds, [], "turnIds is always present — [] at the error boundary, never absent (#266)");
            assert.equal(captured[0].hitMaxTurns, false);
            // #311 (§tokenomics-agnostic-ruler) — the failure is first-class on BOTH
            // surfaces: the broadcast carries the cause and the loop row is terminal 500, never a
            // contentless corpse over a still-live 102 row.
            const msg = (captured[0] as { message?: string }).message;
            assert.ok(typeof msg === "string" && msg.length > 0, "loop/terminated carries the error message");
            const loopRow = await (_db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: (captured[0] as { loopId: number }).loopId });
            assert.equal(loopRow?.status, 500, "the loop ROW is terminal 500 — a dead loop never reads as live");
            // #506 — the WHY reaches ALL THREE forensic channels, never one: the daemon log carries
            // the stack, and an error-level telemetry event fires (run54 had zero of either).
            const telemErr = (telemetry() as Array<{ event?: { kind?: string; level?: string } }>).find((e) => e.event?.kind === "loop_error");
            assert.ok(telemErr?.event?.level === "error", "an error-level telemetry event named the death");
        } finally { ws.close(); }
    });
    console.error = realErr;
    assert.ok(logged.some((l) => /drain error/.test(l)), "the daemon log carried the drain error — the WHY is never nowhere (#506)");
});

test("loop.run without provider returns 501", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "no-provider" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "anything" });
            const result = response.result as { status: number; error?: string };
            assert.equal(result.status, 501);
        } finally { ws.close(); }
    });
});

test("loop.run requires non-empty prompt", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "empty-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /non-empty params\.prompt/);
        } finally { ws.close(); }
    });
});

test("loop.run respects maxTurns cap when model emits non-terminal statuses repeatedly", async () => {
    const dsl = "<<EDIT(worker:///x):iter:EDIT\n<<SEND[102]:continue:SEND";
    const responses = Array.from({ length: 5 }, () => makeMockResponse(dsl, 10));
    // Generous context: this test isolates the maxTurns ceiling, so the budget must NOT fire first.
    // At 8192 the 3-turn EDIT accumulation + the foisted docs tips into a 413 before turn 3's cap
    // (base-packet size drifts with grammar/scheme doc growth); the headroom keeps the test on-topic.
    const mock = new Mock({ contextWindow: 32768, responses });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "maxturns-test" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "iterate", maxTurns: 3 });
            assert.equal(result.accepted, 100, "loop.run accepts immediately");
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429, "max_turns exhausts the turn ceiling → 429");
            assert.equal(result.turnIds?.length, 3);
        } finally { ws.close(); }
    });
});
test("loop.run({ openPaths }) foists a turn-0 file READ for each path (#260)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("<<SEND[200]:done:SEND", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logEntries = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "openpaths" });
            // Headless workspace: the files needn't exist — what's asserted is that the daemon FOISTS a
            // turn-0 READ for each path (a missing path just surfaces its own 4xx in the log).
            await runLoopToTerminal(ws, 2, { prompt: "look at these", openPaths: ["src/foo.ts", "README.md"] });
            await flush();
            // file:/// paths store with scheme=NULL (a routing-internal scheme; the entries), so that plus
            // a plurnk origin identifies the foists — the prompt EDIT alongside them is scheme='plurnk'.
            const reads = (logEntries() as Array<{ entry: { op: string; origin: string; scheme: string | null; pathname: string } }>)
                .map((c) => c.entry)
                .filter((e) => e.op === "READ" && e.origin === "plurnk" && e.scheme === null);
            assert.deepEqual(reads.map((r) => r.pathname).toSorted(), ["README.md", "src/foo.ts"], "a plurnk-origin file READ foisted per openPath at turn 0 — columns in wire canon ({§fs-answer-in-canon})");
        } finally { ws.close(); }
    });
});

// #506 — the run54/55 death class: a seam SUBSCRIBER throwing (a transport's bad socket) must
// never propagate into engine control flow. The loop completes; the failure logs per event.
test("a throwing seam subscriber never kills the loop — the transport's failure is its own (#506)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("<<SEND[200]:done:SEND", 10)] });
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            daemon.subscribeToEvents(() => { throw new Error("transport socket died mid-send"); });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "sub-throws" });
            await rpcCall(ws, 2, "loop.run", { prompt: "go", flags: { yolo: true } });
            const t = await waitFor(() => terminated() as Array<{ finalStatus: number }>, (ts) => ts.length >= 1, { timeoutMs: 8000 });
            assert.equal(t[0].finalStatus, 200, "the loop concluded normally through a burst of throwing broadcasts");
        } finally { ws.close(); }
    });
    console.error = realErr;
    assert.ok(logged.some((l) => l.includes("seam subscriber failed")), "every subscriber failure logged loudly — never silent, never fatal");
});
