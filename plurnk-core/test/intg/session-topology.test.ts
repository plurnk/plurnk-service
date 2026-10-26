import { serverProposals } from "./_approval.ts";
// {§session-loop-lifecycle} topology join — a child session finishing is a WAKE EDGE for a parent that parked
// awaiting it. Without it, a parent that spawns work and hibernates would dead-park.
// The proof: the parent concludes at all — a non-woken 202 would hang (runLoopToTerminal times out).

import test from "node:test";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { holdChild } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import type { Executor } from "@plurnk/plurnk-execs";
import Results from "../../src/core/results.ts";
import LoopDriver from "../../src/core/LoopDriver.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications, waitFor, waitForDb } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { admitTogether, namedModelSession } from "./_sessions.ts";

test("{§session-lifecycle-child-matrix} a child session concluding wakes a parent parked at 202", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Response order is forced by causality: the parent can't resume until the child concludes,
    // and the child can't run until the parent spawns it — so the Mock queue is deterministic.
    // 16384: the parent's final resume carries the whole child subtree; that accumulation crests at the 8192 edge
    // and grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the wake topology, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Parent turn 1: spawn a child session, then hibernate awaiting it.
        makeMockResponse("````WORK (session://session)\ncompute the thing and finish\n````\n\n````WAIT\nspawned session; waiting on it\n````", 10),
        // Child turn 1: do its part and conclude → this is the wake edge for the parent.
        makeMockResponse("````SEND [200]\nsession done\n````", 10),
        // Parent turn 2 (only reached if the child's conclusion woke it): conclude.
        makeMockResponse("````SEND [200]\nsession finished; all done\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "session-topology" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            // runLoopToTerminal awaits the PARENT's loop/terminated. If the child-wake doesn't fire,
            // the parent stays parked at 202 forever and this times out — so reaching 200 IS the proof.
            const { finalStatus, turnIds, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "spawn a session and wait for it" });
            assert.equal(finalStatus, 200, "the parent resumed from 202 (woken by the child) and concluded");
            assert.equal(turnIds?.length, 3, "the terminal event includes initialization and both model turns across park/resume");
            const [childEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId !== modelSessionId),
                (events) => events.length > 0,
            );
            assert.equal(childEnded.result.status, 200, "the child concluded 200");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} a child cancelling itself (499) also wakes the parent — any conclusion is a wake edge", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // The parent observes cancellation as well as successful completion.
    // 16384: the parent's woken turn carries the whole child history + collect delta, cresting at the
    // 8192 edge; execs-common 0.2.21's second sh teaching line consumed the last margin (the same
    // budget-edge class as the grammar 0.76.4 bumps above). Headroom for the wake, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://doomed)\ntry the risky thing\n````\n\n````WAIT\nwaiting on doomed\n````", 10),
        makeMockResponse("````SEND\ndoomed gave up\n````\n````KILL (session://doomed)\n````", 10),
        makeMockResponse("````SEND [200]\ndoomed is done (failed); concluding\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "child-fail" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn doomed, wait" });
            assert.equal(finalStatus, 200, "the parent woke on the child's 499 and concluded — a failed child is still a wake edge");
        } finally { ws.close(); }
    });
});

test("{§session-lifecycle-child-wake}: one completed child task wakes its parent while another task stays parked", async (t) => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WAIT\nFirst task waits.\n````"),
        makeMockResponse("````WAIT\nSecond task waits.\n````"),
        makeMockResponse("````WAIT\nParent awaits results.\n````"),
        makeMockResponse("````SEND [200]\nFirst task result: 42.\n````\n\n````SEND [200]\nFirst task result: 42.\n````"),
        makeMockResponse("````WAIT\nFirst result observed; second task remains.\n````"),
    ] });
    try {
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "partial-child-result" });
            const parentId = await namedModelSession(daemon, workspaceId, "main");
            const parentSession = await daemon.readSession({ workspaceId, identity: { id: parentId } });
            assert.ok(parentSession);
            const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
            const held = await holdChild(db, workspaceId, childId);
            try {
                const common = {
                    workspaceId, sessionId: childId,
                    source: `session://${parentSession.name}`,
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    effort: "adaptive" as const, systemPrompt: "test system",
                };
                const childTasks = await admitTogether(t, childId, [
                    () => daemon.inject({ ...common, prompt: "First child task." }),
                    () => daemon.inject({ ...common, prompt: "Second child task." }),
                ]);
                const ids = new Set(childTasks.map(({ loopId }) => loopId));
                await waitForDb(
                    async () => (await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: childId }))
                        .filter(({ id }) => ids.has(id)),
                    (tasks) => tasks.length === 2 && tasks.every(({ status }) => status === 202),
                );
                const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Observe each child result." });
                await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }), (row) => row?.status === 202);
                await new LoopLifecycle(db).finish(held, { status: 200, content: "The held work finished." });
                const delivery = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Complete the first task.", source: `session://${parentSession.name}` });
                assert.equal(delivery.loopId, childTasks[0]?.loopId);
                await waitForDb(async () => provider.received.length, (count) => count === 5);
                const latest = provider.received.at(-1)!;
                assert.match(JSON.stringify(latest), /First task result: 42/, "the resumed parent sees the completed task's deliverable");
                const tasks = await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: childId });
                assert.deepEqual(tasks.filter(({ id }) => ids.has(id)).map(({ status }) => status), [200, 202],
                    "observing one completion neither finishes nor wakes the other child task");
                const parentTasks = await db.test_loop_queue_by_session.all<{ id: number; prompt: string }>({ session_id: parentId });
                assert.deepEqual(parentTasks.filter(({ prompt }) => prompt === "Observe each child result.").map(({ id }) => id), [parent.loopId],
                    "the parent resumes its original task without a synthetic message");
            } finally { await daemon.cancelSession({ workspaceId, sessionId: parentId }); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-lifecycle-child-wake}: cancelling a parked child notifies its waiting parent without a live child drain", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WAIT\nChild waits.\n````"),
        makeMockResponse("````WAIT\nParent awaits child.\n````"),
        makeMockResponse("````SEND [200]\nChild cancellation observed.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-parked-child" });
        const parentId = await namedModelSession(daemon, workspaceId, "main");
        const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
        await holdChild(db, workspaceId, childId);
        try {
            const child = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Wait for instructions." });
            await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: child.loopId }), (row) => row?.status === 202);
            const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Observe the child outcome." });
            await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }), (row) => row?.status === 202);
            await daemon.cancelSession({ workspaceId, sessionId: childId });
            const completed = await waitForDb(
                () => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }),
                (row) => row?.status === 200,
            );
            assert.equal(completed?.status, 200);
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: child.loopId }))?.status, 499);
            assert.equal(provider.received.length, 3, "only the live parent resumes on cancellation evidence");
        } finally { await daemon.cancelSession({ workspaceId, sessionId: parentId }); }
    });
});

test("{§session-loop-lifecycle} an empty failed child stream is observed by the child before its terminal result reaches the parent", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://stream-child)\nrun the empty failing stream and report its outcome\n````\n\n````WAIT\nwaiting on stream-child\n````", 10),
        makeMockResponse("````sh (emptyfail)\ngo\n````\n\n````WAIT\nwaiting for emptyfail\n````", 10),
        makeMockResponse("````SEND\nemptyfail failed with no output\n````\n````KILL (session://stream-child)\n````", 10),
        makeMockResponse("````SEND [200]\nthe child reported the empty stream failure\n````", 10),
    ] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        await daemon.registerRuntime({
            namespaceOwner: "session topology test module",
            decl: { name: "emptyfail", glyph: "×", summary: "Empty failure fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } } },
            executor: {
                runtime: "emptyfail", glyph: "×",
                get manifest() { return { name: "emptyfail", channels: { results: "text/plain" }, defaultChannel: "results", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
                get defaultChannel() { return "results"; },
                get channels() { return { results: { mimetype: "text/plain" } }; },
                effect: () => "pure",
                probe: async () => ({ available: true, detail: "fixture" }),
                run: async () => Results.failure(
                    "executor:emptyfail",
                    "fixture-failed",
                    500,
                    "The empty failing stream fixture failed.",
                    { exitCode: 1 },
                    { stage: "execute", retryable: false },
                ),
            } as unknown as Executor,
            availability: { available: true, detail: "fixture" },
        });
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "child-empty-failed-stream" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const { finalStatus, modelSessionId } = await runLoopToTerminal(ws, 2, {
                prompt: "delegate a failing stream and wait for its result",

            });
            assert.equal(finalStatus, 200);
            const [childEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId !== modelSessionId),
                (events) => events.length > 0,
            );
            assert.equal(childEnded.result.status, 499, "the child concluded with its observed stream failure");
            assert.equal(mock.remaining, 0, "all four causal turns ran: parent park, child exec, child terminal, parent terminal");
        } finally { ws.close(); }
    });
});

test("{§session-lifecycle-total-reap}: abandonment survives child activation finishing after cancellation", async (t) => {
    serverProposals(t, "accept");
    const activationStarted = Promise.withResolvers<void>();
    const releaseActivation = Promise.withResolvers<void>();
    const childSettled = Promise.withResolvers<void>();
    let childId: number | undefined;
    const cancelSessionTree = DrainSupervisor.prototype.cancelSessionTree;
    t.mock.method(DrainSupervisor.prototype, "cancelSessionTree", async function (
        this: DrainSupervisor,
        ...args: Parameters<typeof cancelSessionTree>
    ) {
        await activationStarted.promise;
        return cancelSessionTree.apply(this, args);
    });
    const materialize = LoopDocs.materialize;
    t.mock.method(LoopDocs, "materialize", async (...args: Parameters<typeof materialize>) => {
        const [, db, workspaceId] = args;
        const child = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "child" });
        if (child !== undefined) {
            childId = child.id;
            activationStarted.resolve();
            await releaseActivation.promise;
        }
        return materialize(...args);
    });
    const runLoop = LoopDriver.prototype.runLoop;
    t.mock.method(LoopDriver.prototype, "runLoop", async function (
        this: LoopDriver,
        args: Parameters<typeof runLoop>[0],
    ) {
        try { return await runLoop.call(this, args); }
        finally { if (args.sessionId === childId) childSettled.resolve(); }
    });
    // Cancellation reaps the subtree even before the child's activation finishes.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://child)\nkeep working until cancelled\n````\n\n````SEND\nabandon this scope\n````\n````KILL (session://root)\n````", 10),
        makeMockResponse("````NOTE\nstill working\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspace = await rpcCall(ws, 1, "workspace.create", { name: "abandon-tree" });
            const { sessionId } = await daemon.createSession({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
            const parent = runLoopToTerminal(ws, 2, { prompt: "spawn then abandon", sessionId });
            await activationStarted.promise;
            const { finalStatus } = await parent;
            assert.equal(finalStatus, 499);
            const cancelled = await db.test_list_loops_all.all<{ session_id: number; status: number }>({});
            assert.deepEqual(cancelled.filter(({ session_id }) => session_id === childId).map(({ status }) => status), [499],
                "the child is durably cancelled before its delayed activation completes");
            releaseActivation.resolve();
            await childSettled.promise;
            const loops = await db.test_list_loops_all.all<{ id: number; session_id: number; status: number }>({});
            assert.ok(loops.every(({ status }) => ![100, 102, 202].includes(status)), `no unresolved descendant survives abandonment: ${JSON.stringify(loops)}`);
            const childLoops = loops.filter(({ session_id }) => session_id === childId);
            assert.deepEqual(childLoops.map(({ status }) => status), [499], "workspace document maintenance does not create child loops");
            assert.equal(mock.remaining, 1, "the cancelled child never calls the model");
        } finally { releaseActivation.resolve(); ws.close(); }
    });
});

test("{§session-loop-lifecycle} wake propagates UP a grandchild chain (parent→child→grandchild)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Each level parks until the one below concludes — so the order is forced and the recursion shows:
    // grandchild concludes → wakes child → child concludes → wakes parent → parent concludes.
    // 16384: a 2-deep chain piles grandchild→child→parent results into the parent's final resume, cresting at the
    // 8192 edge; grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the wake recursion, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://child)\ndo subwork\n````\n\n````WAIT\nawaiting child\n````", 10),       // parent t1
        makeMockResponse("````WORK (session://grandchild)\ndo leaf work\n````\n\n````WAIT\nawaiting grandchild\n````", 10), // child t1
        makeMockResponse("````SEND [200]\nleaf done\n````", 10),                                                   // grandchild
        makeMockResponse("````SEND [200]\nchild done\n````", 10),                                                  // child t2 (woken)
        makeMockResponse("````SEND [200]\nall done\n````", 10),                                                    // parent t2 (woken)
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "grandchild" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn a 2-deep chain and wait" });
            assert.equal(finalStatus, 200, "the wake propagated up two levels — the parent concluded only after the whole subtree did");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} a parent wakes across SEQUENTIAL children (multiple wakes)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // 16384: the parent's woken turn carries the whole child history; generous headroom over the
    // static packet so the wake budget edge is the subtree, not the tool teaching.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://w1)\nfirst job\n````\n\n````WAIT\nawaiting w1\n````", 10), // parent t1
        makeMockResponse("````SEND [200]\nw1 done\n````", 10),                                       // w1
        makeMockResponse("````WORK (session://w2)\nsecond job\n````\n\n````WAIT\nawaiting w2\n````", 10),// parent t2 (woken by w1)
        makeMockResponse("````SEND [200]\nw2 done\n````", 10),                                       // w2
        makeMockResponse("````SEND [200]\nboth done\n````", 10),                                     // parent t3 (woken by w2)
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "sequential" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "two jobs in sequence" });
            assert.equal(finalStatus, 200, "the parent parked, woke on w1, spawned+parked again, woke on w2, then concluded");
            const sessions = await db.test_sessions_with_parent.all<{ id: number; name: string; parent_session_id: number | null; origin: string }>({});
            const modelSessions = sessions.filter(({ origin }) => origin === "model");
            const parent = modelSessions.find(({ parent_session_id: parentId }) => parentId === null);
            assert.ok(parent, `the topology has a root model session; got ${JSON.stringify(modelSessions)}`);
            assert.deepEqual(
                modelSessions.filter(({ parent_session_id: parentId }) => parentId === parent.id).map(({ name }) => name),
                ["w1", "w2"],
                "the sequential path created both named child sessions under the same parent — terminal output alone is not proof",
            );
        } finally { ws.close(); }
    });
});

test("{§session-lifecycle-idle-is-concluded} an irc (SEND session://name) wakes a CONCLUDED sibling on that session's durable model", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Under {§session-lifecycle-idle-is-concluded}, an actor with nothing to wait on CONCLUDES — it does not
    // park awaiting voice. So the voice door (a sibling's irc) reawakens it as a NEW loop carrying the
    // message as its prompt (the same wake `loop.inject` proves for the operator voice), never a
    // resume-in-place of a slept loop — there is no slept loop to resume.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\nstanding by for the entry code\n````", 10), // loop 1 — idle actor concludes
    ] });
    const directRoute: ProviderSpec = { provider: "mocktest", model: `irc-${crypto.randomUUID()}` };
    const selected = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\nreceived the entry code and confirmed\n````", 10),
    ] });
    ProviderInstantiate.registerInstance(selected, directRoute);
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "irc-wake" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "be a butler; await the entry code" });
            const modelSessionId = (response.result as { modelSessionId: number }).modelSessionId;
            const loopId = (response.result as { loopId: number }).loopId;
            // The actor concludes its first (idle) loop — nothing to wait on.
            await waitFor(() => terminated() as Array<{ loopId: number }>, (ts) => ts.some((t) => t.loopId === loopId), { timeoutMs: 8000 });
            const before = (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }))!.n;
            await daemon.setSessionModel({
                workspaceId,
                sessionId: modelSessionId,
                selector: `${directRoute.provider}/${directRoute.model}`,
            });
            // Address the concluded actor by name, then irc it — the voice door.
            const sessions = ((await rpcCall(ws, 4, "workspace.sessions", {})).result as { sessions: Array<{ name: string; origin: string }> }).sessions;
            const actor = sessions.find((r) => r.origin === "model")!;
            await rpcCall(ws, 5, "op.send", { recipient: `session://${actor.name}`, body: "the entry code is 4815" });
            // A FRESH loop is minted (there was no slept loop to resume).
            const after = await waitForDb(() => db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }), (r) => (r?.n ?? 0) > before, { timeoutMs: 8000 });
            assert.ok((after?.n ?? 0) > before, "the irc reawakened the concluded actor as a FRESH loop — the voice door mints a new loop, never resumes a park");
            const secondLoop = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (items) => items.some(({ loopId: candidate }) => candidate !== loopId),
                { timeoutMs: 8000 },
            );
            assert.equal(secondLoop.find(({ loopId: candidate }) => candidate !== loopId)?.result.status, 200);
            assert.equal(selected.remaining, 0, "the voice door retained the receiving session's explicitly selected model");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} an empty wait continues through the real loop until the assignment is answered", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````WAIT\nnothing running; done for now\n````", 10),
        makeMockResponse("````SEND [200]\nNo work remains.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "idle-concludes" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 2, "loop.run", { prompt: "nothing to do" });
            const t = await waitFor(() => terminated() as Array<{ result: { status: number }; loopId?: number }>, (items) => items.length > 0, { timeoutMs: 8000 });
            assert.equal(t.length, 1, "the loop concluded — one loop/terminated, no held-open 202");
            assert.equal(t[0].result.status, 200, "the answered assignment concludes the loop");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: t[0].loopId! });
            assert.deepEqual(rows.filter(({ op, origin }) => origin === "model" && (op === "WAIT" || op === "SEND")).map(({ status_rx }) => status_rx), [102, 200]);
            assert.equal(mock.remaining, 0);
        } finally { ws.close(); }
    });
});

test("{§session-owner-resolution} server auto-approval settles both WORK and FORK child edits", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Parent turn 1: spawn a session AND fork self, then park awaiting them.
        makeMockResponse("````WORK (session://session)\nedit something and finish\n````\n\n````FORK (session://mirror)\nedit something and finish\n````\n\n````WAIT\ndelegated; waiting\n````", 10),
        // Session turn 1: a SIDE-EFFECTING op (proposes unless auto), then conclude.
        makeMockResponse("````EDIT (workspace:///from-session)\npayload\n````\n\n````SEND\nsession done\n````", 10),
        // Fork turn 1: same shape.
        makeMockResponse("````EDIT (workspace:///from-fork)\npayload\n````\n\n````SEND\nfork done\n````", 10),
        // {§send-premature-terminate}: the children observe their EDIT receipts
        // before completing. A parent claim remains gated on its child results.
        ...Array.from({ length: 4 }, () => makeMockResponse("````SEND [200]\nDelegated edits observed.\n````", 10)),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "delegation-policy" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "delegate everything" });
            assert.equal(finalStatus, 200, "the whole topology concluded — no child stalled in a proposal void");
            const edits = await db.test_edit_states.all<{ pathname: string; state: string }>({});
            const childEdits = edits.filter((x) => /from-(session|fork)/.test(x.pathname));
            assert.equal(childEdits.length, 2, "both delegated children performed their EDIT");
            for (const e of childEdits) {
                assert.equal(e.state, "resolved", `child EDIT ${e.pathname} accepted by server policy`);
            }
        } finally { ws.close(); }
    });
});

test("{§wait-obligation-matrix} a wake re-queue (100) mid-drain is re-claimed and continued — never returned as a terminal", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // The delegation-policy race: a conclusion-wake re-queues a parent's loop (202→100) between its
    // turn-end and its drain's next status check; pre-fix, runLoop read the queued 100 as an external
    // terminal and broadcast a QUEUED loop as loop/terminated{100}.
    // Under {§wait-obligation-matrix} a loop blocks at 202 only on a live obligation, so the wake is a
    // REAL child-wake: the parent blocks on a spawned child, the child's conclusion re-queues the parent
    // (202→100) and the drain re-claims it (100→102). Exactly one terminal must fire for the parent, 200.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WORK (session://helper)\ndo a quick thing\n````\n\n````WAIT\nawaiting helper\n````", 10), // parent — blocks on its child
        makeMockResponse("````SEND [200]\nhelper done\n````", 10),                    // helper — concludes, waking the parent
        makeMockResponse("````SEND [200]\nhelper delivered; concluding\n````", 10),   // parent — re-queued by the wake, concludes
        makeMockResponse("````SEND [200]\ndone\n````", 10),                           // buffer
        makeMockResponse("````SEND [200]\ndone\n````", 10),                           // buffer
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "wake-requeue" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "spawn a helper and await it" });
            const loopId = (accept.result as { loopId: number }).loopId;
            // The parent's loop is re-queued in place by the child-wake, then continues to its own terminal.
            const seen = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (ts) => ts.some((t) => t.loopId === loopId),
                { timeoutMs: 8000 },
            );
            const finals = seen.filter((t) => t.loopId === loopId).map((t) => t.result.status);
            assert.deepEqual(finals, [200], `exactly one terminal broadcast for the parent, 200 — never a queued 100; got ${JSON.stringify(finals)}`);
        } finally { ws.close(); }
    });
});

test("{§log-kill-meta-operation} log-targeted KILL is recorded in the DB, and a failed one persists", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Successful meta-operations are forensic but render-free; failures remain
    // visible error signals. {§log-kill-meta-operation}
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````EDIT (workspace:///note)\nsome content worth folding\n````\n\n````NOTE\nwrote\n````", 10),
        // The phantom KILL fails (404); the next turn observes the failure.
        makeMockResponse("````KILL (log:///1/2/1) <1,-1>````\n````KILL (log:///9/9/9) <1,-1>````\n````NOTE\ncurated\n````", 10),
        makeMockResponse("````SEND [200]\nthe phantom KILL failed; curation done\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "meta-ops" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "curate" });
            assert.equal(finalStatus, 200, "a curation turn is work, never idleness — the loop concluded");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string }>({ loop_id: loopId });
            const kills = rows.filter((r) => r.origin === "model" && r.op === "KILL" && JSON.parse(r.tx).target !== null);
            assert.equal(kills.length, 2, `both KILLs recorded in the DB; got ${JSON.stringify(kills)}`);
            assert.deepEqual(kills.map(({ status_rx }) => status_rx), [200, 404], "one success + one failure recorded");
        } finally { ws.close(); }
    });
});
