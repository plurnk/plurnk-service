import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, makeMockResponse, runLoopToTerminal, waitFor } from "./_rpc.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";

test("loop.run accepts immediately (100); the loop's outcome arrives via loop/terminated", async () => {
    const dsl = "## EDIT0 (worker:///france/capital)\nParis\n\n## SEND0 [200]\nParis is the capital.";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 142)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-test" });
            // loop.run accepts and returns immediately (100 + loopId); the terminal outcome —
            // result, turnIds, usage — rides loop/terminated, surfaced here by the helper.
            const result = await runLoopToTerminal(ws, 2, { prompt: "what is the capital of france?" });
            assert.equal(result.accepted, 100, "loop.run returns immediately — accepted, not the terminal");
            assert.equal(result.result.status, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds?.length, 1);
            // {§notifications}: loop/terminated carries usage summed over the loop's turns.
            assert.equal(result.usage?.accounting.usage?.outputTokens, 142, "output tokens sum the physical request evidence");
            assert.equal(result.usage?.accounting.usage?.inputTokens, 0);
            assert.equal(result.usage?.accounting.usage?.outputTokenDetails?.reasoningTokens, 0);
            assert.equal(result.usage?.accounting.usage?.inputTokenDetails?.cacheReadTokens, 0);
            assert.equal(result.usage?.accounting.costUsd, "0");
            assert.deepEqual(result.attributions, [], "attribution remains a top-level terminal projection, separate from usage");

            const entryCount = (await db.test_count_entries.get<{ n: number }>())?.n;
            // worker:///france/capital + the prompt frame (2 base — no manifest.json entry, the
            // catalog is FIND-served), plus 11 docs: the 3 non-excluded in-tree schemes (log/worker/prompt
            // — file/exec dropped by the default PLURNK_SERVICE_DOCS_EXCLUDE, skill excluded too), the
            // boot-discovered `http` + `wss` externals ({§plugin-discovery}), and sh/node/sqlite/git/jq —
            // executor docs the execs family ships. Configured protocol modules add their own
            // runtime docs only when present. 2 + 10 = 12.
            assert.equal(entryCount, 12);
        } finally { ws.close(); }
    });
});

test("loop.inject speaks into an existing worker; errors when there's none", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("## SEND0 [200]\nfirst done", 10),
        makeMockResponse("## SEND0 [200]\ninjected done", 10),
    ] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "loop-inject" });

            // No model worker yet → inject has nothing to talk to (loop.run starts one).
            const noWorker = await rpcCall(ws, 2, "loop.inject", { prompt: "too early" });
            const noWorkerResult = noWorker.result as { status: number; problem: { type: string; detail: string } };
            assert.equal(noWorkerResult.status, 409);
            assert.equal(noWorkerResult.problem.type, "https://problems.plurnk.dev/daemon/worker/model-worker-required");
            assert.equal(noWorkerResult.problem.detail, "No model worker exists for prompt injection.");

            // Start a worker; SEND[200] ends it, leaving the worker idle. Wait for the terminal
            // (loop.run no longer blocks) so the worker is genuinely idle before we inject.
            await runLoopToTerminal(ws, 3, { prompt: "first", flags: { auto: true } });

            // Inject into the idle worker → enqueues a fresh loop, returns immediately.
            const injected = await rpcCall(ws, 4, "loop.inject", { prompt: "BTW, the config is TOML" });
            const result = injected.result as { action: string; loopId: number; modelWorkerId: number };
            assert.equal(result.action, "enqueued_new_loop", "idle worker → a fresh enqueued loop");
            assert.ok(typeof result.loopId === "number", "returns the loopId");
            assert.ok(typeof result.modelWorkerId === "number", "returns the worker it spoke into");

            // empty prompt is a contract violation.
            const empty = await rpcCall(ws, 5, "loop.inject", { prompt: "" });
            const emptyResult = empty.result as { status: number; problem: { type: string } };
            assert.equal(emptyResult.status, 400);
            assert.equal(emptyResult.problem.type, "https://problems.plurnk.dev/daemon/input/prompt-invalid");
        } finally { ws.close(); }
    });
});

test("run.fork branches the model worker into a named worker; errors with no worker", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("## EDIT0 (worker:///x)\nhi\n\n## SEND0 [200]\ndone", 10)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "fork-test" });

            // No model worker yet → nothing to fork.
            const noWorker = await rpcCall(ws, 2, "run.fork", {});
            const noWorkerResult = noWorker.result as { status: number; problem: { type: string; detail: string } };
            assert.equal(noWorkerResult.status, 409);
            assert.equal(noWorkerResult.problem.type, "https://problems.plurnk.dev/daemon/worker/model-worker-required");
            assert.equal(noWorkerResult.problem.detail, "No model worker exists to fork.");

            // A loop builds the model worker + its log; forking branches it. Wait for the
            // terminal so the log is settled before the fork copies it.
            await runLoopToTerminal(ws, 3, { prompt: "do a thing" });
            const fork = await rpcCall(ws, 4, "run.fork", {});
            const r = fork.result as { workerId: number; workerName: string | null; parentWorkerId: number };
            assert.ok(typeof r.workerId === "number" && typeof r.parentWorkerId === "number", "returns new and parent worker ids");
            assert.notEqual(r.workerId, r.parentWorkerId, "the fork is a distinct worker");
            assert.match(r.workerName ?? "", /-fork-\d+$/, "the fork is named <parent>-fork-<N> by default (unique per fork)");

            // {§worker-scheme-fork} — an explicit branch name is immutable after instantiation.
            const named = await rpcCall(ws, 5, "run.fork", { name: "harvest" });
            assert.equal((named.result as { workerName: string | null }).workerName, "harvest", "an explicit name names the branch");

            // Reserved + taken names are refused up front (workers.name is UNIQUE per workspace) —
            // mirrors workspace.attach, never falling through to the insert.
            const reserved = await rpcCall(ws, 6, "run.fork", { name: "plurnk" });
            const reservedResult = reserved.result as { status: number; problem: { type: string } };
            assert.equal(reservedResult.status, 409);
            assert.equal(reservedResult.problem.type, "https://problems.plurnk.dev/daemon/worker/name-reserved");

            const taken = await rpcCall(ws, 7, "run.fork", { name: "harvest" });
            const takenResult = taken.result as { status: number; problem: { type: string } };
            assert.equal(takenResult.status, 409);
            assert.equal(takenResult.problem.type, "https://problems.plurnk.dev/daemon/worker/name-conflict");

            const empty = await rpcCall(ws, 8, "run.fork", { name: "" });
            const emptyResult = empty.result as { status: number; problem: { type: string } };
            assert.equal(emptyResult.status, 400);
            assert.equal(emptyResult.problem.type, "https://problems.plurnk.dev/daemon/input/name-invalid");
        } finally { ws.close(); }
    });
});

test("loop.run streams log/entry notifications during execution", async () => {
    const dsl = "## EDIT0 (worker:///x)\nhello\n\n## SEND0 [200]\ndone";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logEntries = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "stream-test" });
            // loop.run returns immediately; wait for the loop to terminate so all its
            // log/entry notifications have fired before we inspect them.
            const terminal = await runLoopToTerminal(ws, 2, { prompt: "test" });
            await flush();

            const captured = logEntries().filter((event) => (event as { entry?: { loop_id?: unknown } }).entry?.loop_id === terminal.loopId);
            // The actionless prompt row broadcasts once ahead of model ops.
            assert.equal(captured.length, 4);
            const prompt = captured[0] as { entry: { op: string; origin: string } };
            assert.equal(prompt.entry.op, "prompt");
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
    const dsl = "## EDIT0 (worker:///x)\nbody\n\n## SEND0 [200]\ndone";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "term-test" });
            // loop.run returns immediately (100 accepted); the loop's outcome rides loop/terminated.
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            const ack = accept.result as { loopId: number; status: number };
            assert.equal(ack.status, 100, "loop.run accepts immediately, not the terminal");
            const captured = await waitFor(
                () => terminated() as Array<{ workerId: number; loopId: number; result: { status: number }; hitMaxTurns: boolean; attributions: string[]; usage: import("../../src/core/Engine.ts").LoopUsage }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1);
            const params = captured[0];
            assert.ok(params.workerId > 0, "terminal carries its owning workerId with the loopId");
            assert.equal(params.loopId, ack.loopId, "terminal coordinate matches the acknowledged loop");
            assert.equal(params.result.status, 200);
            assert.equal(params.hitMaxTurns, false);
            assert.deepEqual(params.attributions, []);
            // {§notifications}: loop/terminated carries the loop's usage totals.
            assert.equal(params.usage.accounting.usage?.outputTokens, 50);
            assert.equal(params.usage.accounting.usage?.outputTokenDetails?.reasoningTokens, 0);
            assert.equal(params.usage.accounting.usage?.inputTokenDetails?.cacheReadTokens, 0);
        } finally { ws.close(); }
    });
});

test("loop.run still fires loop/terminated when the loop throws — no client hang", async () => {
    // A loop that ERRORS (terminal provider failure / engine throw — not a clean SEND, abort, or
    // strike-abandonment) must STILL broadcast loop/terminated: loop.run only acked 100, so it's the
    // async client's sole outcome channel. One non-terminal turn, then the Mock exhausts and returns
    // its typed invalid-response failure; the drain must still publish it ({§notifications}).
    const dsl = "## EDIT0 (worker:///x)\niter\n\n## SEND0 [102]\ncontinue";
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse(dsl, 10)] });
    // The failure must reach daemon diagnostics too. Capture stderr around the loop.
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map((x) => x instanceof Error ? x.stack ?? x.message : String(x)).join(" ")); };

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "errored-loop" });
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "go", maxTurns: 5 });
            assert.equal((accept.result as { status: number }).status, 100, "loop.run accepts immediately (100)");

            const captured = await waitFor(
                () => terminated() as Array<{ result: { status: number }; turnIds: number[]; hitMaxTurns: boolean; loopId: number }>,
                (ts) => ts.length >= 1,
            );
            assert.equal(captured.length, 1, "the errored loop fired loop/terminated — the client is not left hanging");
            assert.equal(captured[0].result.status, 502, "the exact provider-boundary status reaches the client");
            assert.ok(captured[0].turnIds.length > 0, "every durable turn completed before the failure is accounted for");
            assert.equal(captured[0].hitMaxTurns, false);
            const exact = captured[0].result as { status: number; problem?: { type?: string; detail?: string; instance?: string } };
            assert.equal(exact.problem?.type, "https://problems.plurnk.dev/provider/mock/invalid-response");
            assert.equal(exact.problem?.detail, "Mock provider exhausted: no more queued responses");
            assert.match(exact.problem?.instance ?? "", /^log:\/\/\//, "the failure identifies its durable operation");
            const loopRow = await _db.test_get_loop_status.get<{ status: number }>({ id: (captured[0] as { loopId: number }).loopId });
            assert.equal(loopRow?.status, 500, "the compact scheduler projection is terminal, never a live 102");
            assert.deepEqual(
                await new LoopLifecycle(_db).result((captured[0] as { loopId: number }).loopId),
                captured[0].result,
                "the durable loop result and emitted product result are identical",
            );
            const turns = await _db.test_list_turns_in_loop.all<{
                status: number;
                packet: string;
            }>({ loop_id: captured[0].loopId });
            const failedTurn = turns.at(-1);
            assert.equal(failedTurn?.status, 502, "the attempted provider turn is closed with the exact failure status");
            const failedPacket = JSON.parse(failedTurn?.packet ?? "{}") as {
                sections?: unknown;
                assistant?: unknown;
            };
            assert.ok(Array.isArray(failedPacket.sections), "the exact request packet survives forensics");
            assert.equal(failedPacket.assistant, undefined, "no empty assistant response is fabricated");
        } finally { ws.close(); }
    });
    console.error = realErr;
    assert.ok(logged.some((l) => /drain error/.test(l)), "the daemon log carried the drain error — the cause is not swallowed");
});

test("loop.run without provider returns 501", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "no-provider" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "anything" });
            const result = response.result as { status: number; problem?: { type?: string; detail?: string } };
            assert.equal(result.status, 501);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/daemon/provider/not-configured");
            assert.equal(result.problem?.detail, "No provider is configured for this loop.");
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
            const result = response.result as { status: number; problem?: { type?: string; detail?: string; field?: string } };
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.dev/daemon/input/prompt-invalid");
            assert.equal(result.problem?.detail, "prompt is not a non-empty string.");
            assert.equal(result.problem?.field, "prompt");
        } finally { ws.close(); }
    });
});

test("loop.run respects maxTurns cap when model emits non-terminal statuses repeatedly", async () => {
    const dsl = "## EDIT0 (worker:///x)\niter\n\n## SEND0 [102]\ncontinue";
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
            assert.equal(result.result.status, 429, "max_turns exhausts the turn ceiling → 429");
            assert.equal(result.turnIds?.length, 3);
        } finally { ws.close(); }
    });
});
test("{§methods-loop-run-open-paths}: a fresh loop foists one turn-zero READ per path", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("## SEND0 [200]\ndone", 10)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const logEntries = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "openpaths" });
            // Headless workspace: the files needn't exist — what's asserted is that the daemon FOISTS a
            // turn-0 READ for each path (a missing path just surfaces its own 4xx in the log).
            const result = await runLoopToTerminal(ws, 2, { prompt: "look at these", openPaths: ["src/foo.ts", "README.md"] });
            await flush();
            // Bare file targets use scheme=NULL in log metadata even though the addressed
            // entry identity stores scheme='file'; origin plus the nullable target identifies the foists.
            const reads = (logEntries() as Array<{ entry: { op: string; origin: string; scheme: string | null; pathname: string } }>)
                .map((c) => c.entry)
                .filter((e) => e.op === "READ" && e.origin === "plurnk" && e.scheme === null);
            assert.deepEqual(reads.map((r) => r.pathname).toSorted(), ["README.md", "src/foo.ts"], "a plurnk-origin file READ foisted per openPath at turn 0 — columns in wire canon ({§fs-answer-in-canon})");
            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number;
            }>({ loop_id: result.loopId });
            const frame = rows.find((row) => row.op === "prompt" && row.pathname === "/1/1");
            assert.ok(frame, "the initial prompt frame exists");
            assert.ok(rows.filter((row) => row.op === "READ" && row.origin === "plurnk" && row.scheme === null)
                .every((row) => row.turn_id === frame.turn_id),
            "every selected path is read in the same turn that publishes the initial prompt frame");
        } finally { ws.close(); }
    });
});

// {§methods-event-subscribe}: a subscriber failure never propagates into engine control flow.
test("a throwing seam subscriber never kills the loop — the transport's failure is its own", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("## SEND0 [200]\ndone", 10)] });
    const logged: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            daemon.subscribeToEvents(() => { throw new Error("transport socket died mid-send"); });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "sub-throws" });
            await rpcCall(ws, 2, "loop.run", { prompt: "go", flags: { auto: true } });
            const t = await waitFor(() => terminated() as Array<{ result: { status: number } }>, (ts) => ts.length >= 1, { timeoutMs: 8000 });
            assert.equal(t[0].result.status, 200, "the loop concluded normally through a burst of throwing broadcasts");
        } finally { ws.close(); }
    });
    console.error = realErr;
    assert.ok(logged.some((l) => l.includes("seam subscriber failed")), "every subscriber failure logged loudly — never silent, never fatal");
});
