import SessionOwners from "../../src/core/SessionOwners.ts";
import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import StreamMock from "./_stream-mock.ts";
import Dsl from "./dsl.ts";
import { ownSession, TEST_OWNER, serverProposals } from "./_approval.ts";
import { Mock, chatMessageText, ModelProvider } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, subscribeNotifications, waitFor, waitForDb, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { isArrivalRow, packetSection } from "./_packet.ts";
import { admitTogether, namedModelSession, modelOperation } from "./_sessions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { parsePath } from "@plurnk/plurnk-parser";
import { parseLogRecords } from "../LogRecords.ts";
import { type ApplicationLoopProjection, type LogEntryWire } from "@plurnk/plurnk-contracts";
import { type Db } from "../../src/core/Db.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { liveLoop, liveWorkspace } from "../_live-harness.ts";
import { Digest } from "@plurnk/plurnk-digest";

describe("Daemon.drain-inject", () => {
const arrivalBody = (row: { tx: string }): string => (JSON.parse(row.tx) as { body: { raw: string } }).body.raw;

const sendOnly = (dsl: string) => makeMockResponse(dsl);

test("{§loop-completion} loop.run: enqueues + drains + returns first loop's result", async () => {
    const dsl = "````EDIT (workspace:///x)\nhello\n````\n\n````SEND\ndone\n````";
    // {§loop-completion} — observe the EDIT receipt before the final SEND.
    const mock = new Mock({ contextWindow: 16384, responses: [sendOnly(dsl), makeMockResponse("````SEND [200]\ndone\n````", 0)] });

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
            assert.equal(result.turnIds?.length, 3, "packetless initialization and both model turns are durable (the edit receipt forced the second)");
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission}: concurrent admissions before the first claim create distinct ordered loops", async (t) => {
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````SEND [200]\nfirst concurrent loop\n````"),
            sendOnly("````SEND [200]\nsecond concurrent loop\n````"),
        ],
    });

    await withDaemon(mock, async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: "concurrent-loop-allocation" });
        const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
        const providerSpec = { alias: "mocktest", provider: "openai", model: "mocktest" } as const;
        // {§session-wait-timing}: both admissions must precede the first drain claim.
        const accepted = await admitTogether(t, sessionId, [
            () => daemon.inject({
                workspaceId: workspace.workspaceId,
                sessionId,
                prompt: "concurrent prompt one",
                providerSpec,
                effort: "adaptive",
                systemPrompt: "test system",
            }),
            () => daemon.inject({
                workspaceId: workspace.workspaceId,
                sessionId,
                prompt: "concurrent prompt two",
                providerSpec,
                effort: "adaptive",
                systemPrompt: "test system",
            }),
        ]);

        assert.deepEqual(accepted.map(({ action }) => action), ["enqueued_new_loop", "enqueued_new_loop"]);
        assert.equal(new Set(accepted.map(({ loopId }) => loopId)).size, 2, "both accepted prompts own a loop");
        assert.equal(accepted.filter(({ drainPromise }) => drainPromise !== undefined).length, 1,
            "one drain owns the complete ordered queue");

        const acceptedLoopIds = new Set(accepted.map(({ loopId }) => loopId));
        const loops = await waitForDb(
            async () => (await db.test_loop_queue_by_session.all<{
                id: number; sequence: number; status: number; prompt: string;
            }>({ session_id: sessionId })).filter(({ id }) => acceptedLoopIds.has(id)),
            (rows) => rows.length === 2 && rows.every(({ status }) => status === 200),
        );
        assert.deepEqual(loops.map(({ sequence }) => sequence), [1, 2]);
        assert.deepEqual(new Set(loops.map(({ prompt }) => prompt)), new Set(["concurrent prompt one", "concurrent prompt two"]));
        assert.equal(mock.remaining, 0, "the one drain processed both loops exactly once");
    });
});

test("{§session-ownership}: a fresh injection preserves the session owner", async () => {
    const mock = new Mock({
        contextWindow: 16384,
        responses: [sendOnly("````SEND [200]\ndone\n````")],
    });
    await withDaemon(mock, async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: `fresh-loop-${crypto.randomUUID()}` });
        const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
        await ownSession(db, workspace.workspaceId, sessionId);
        const accepted = await daemon.inject({
            workspaceId: workspace.workspaceId,
            sessionId,
            prompt: "delegated work",
            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            effort: "adaptive",
            systemPrompt: "test system",
        });
        assert.equal((await SessionOwners.read(db, sessionId)).address, TEST_OWNER);
        await accepted.drainPromise;
    });
});

test("{§executor-subprocess} loop.cancel terminates a backgrounded exec; the stream concludes 499", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // A fire-and-forget exec outlives the loop that spawned it (in_progress keeps
    // turn 1 going, the loop ends on turn 2, the spawn runs on). loop.cancel
    // must ACTUALLY terminate it — proven by the exec stream concluding 499,
    // not merely cancelled=true.
    //
    // `sleep 30` is the long-running job; {§executor-subprocess} requires
    // loop.cancel to process-group-kill it — proven by the 499
    // conclusion, not a 30s wall-clock leak.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````sh\nsleep 30\n````\n\n````NOTE\nrunning\n````"),
            sendOnly("````SEND [200]\ndone\n````"),
            sendOnly("````SEND [200]\ndone\n````"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "drain-cancel" });
            const workspaceId = (created.result as { id: number }).id;
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "start slow job" });
            // Wait for the backgrounded exec's subscription to ACTUALLY open before
            // cancelling — a fixed sleep races the spawn (the resource directory + materialized
            // docs delay it). The cancel must land on a live,
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

            // {§methods} {§notifications}: cancellation cannot
            // retroactively reject the immediate 100 acknowledgement; terminal truth is an event.
            const loopResp = await loopPromise;
            assert.equal(loopResp.error, undefined, "loop.run acknowledgement remains accepted after cancellation");
            assert.equal((loopResp.result as { status: number }).status, 100, "loop.run returned the 100 accept, not the terminal");
        } finally { ws.close(); }
    });
});

test("{§actor-boundary} loop.cancel: no active drain → cancelled=false", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [sendOnly("````SEND [200]\ndone\n````")] });
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

test("{§actor-boundary} loop.run: post-cancel, a fresh loop.run starts a new drain", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Generous response queue so neither loop exhausts Mock regardless
    // of how many turns each runs before cancel/termination.
    // 16384: the cancel-then-restart drain accumulates the exec entry across turns, cresting at the 8192 edge;
    // grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the drain restart, not a budget probe.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````sh\nsleep 30\n````\n\n````NOTE\nrunning\n````"),
            sendOnly("````SEND [200]\ndone\n````"),
            sendOnly("````SEND [200]\ndone\n````"),
            sendOnly("````SEND [200]\ndone\n````"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "drain-restart" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");

            const firstPromise = rpcCall(ws, 2, "loop.run", {
                prompt: "first",
            });
            // Wait for the backgrounded exec to ACTUALLY spawn (its entry to exist) before
            // cancelling — a fixed sleep races the spawn (the resource directory + materialized
            // docs delay it). The cancel must land on a running exec, deterministically;
            // otherwise it fires into the spawn gap and the sleep leaks.
            await waitForDb(
                async () => (await db.test_count_entries_by_workspace_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            const firstResp = await firstPromise;
            assert.equal((firstResp.result as { status: number }).status, 100,
                "loop.run accepted (100); the cancelled loop's terminal arrives via events");
            // Wait for the cancelled first loop to actually terminate (499 via loop/terminated)
            // so the session is genuinely idle before the second loop.run.
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

test("{§methods-workspace-create}: an active-loop prompt carries its paths into the publishing turn", async () => {
    // Deterministic hold (no 50ms race): a non-auto execution proposal pauses
    // dispatch at status=202 BEFORE any subprocess spawns, so loop 1 is
    // provably live at status=102 when the second loop.run lands. We REJECT it
    // (no spawn → no stream → no wake side-effect); loop 1 then continues to
    // turn 2, whose prompt is the injected "follow-up", and ends. This pins the
    // single-drain invariant: a concurrent loop.run injects into the live loop,
    // it never spins up a parallel drain.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````sh\ntrue\n````\n\n````NOTE\ncontinue after review\n````"), // proposal pauses before the required disposition
            sendOnly("````SEND [200]\nOriginal request done.\n````\n\n````SEND [200]\nFollow-up done.\n````"),
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

            const inbox = (await db.test_messages_by_loop.all({ loop_id: (r2.result as { loopId: number }).loopId })) as Array<{ ordinal: number; body: string }>;
            assert.deepEqual(inbox.map(({ body }) => body), ["kick off", "follow-up"], "the initial and injected messages coexist in the live loop's inbox");

            // Reject the proposal (no spawn); loop 1 continues to turn 2, which
            // consumes the injected prompt and ends cleanly.
            await rpcCall(ws, 4, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
            await firstPromise;  // resolves at the 100 accept; loop 1 completes asynchronously on turn 2

            // Exactly one loop ran for the session: the second call injected, it did not spin up a
            // parallel drain. Wait for the single termination (loop.run does not block to it).
            const ended = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (t) => t.length >= 1, { timeoutMs: 5000 },
            );
            assert.equal(ended.length, 1, "exactly one loop terminated — no parallel drain");
            assert.equal(ended[0].result.status, 200, "loop 1 ends cleanly after consuming the injected prompt");

            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number; tx: string; attrs: string;
            }>({ loop_id: ended[0].loopId });
            const frame = rows.find((row) => isArrivalRow(row) && arrivalBody(row) === "follow-up");
            const contextRead = rows.find((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === null && row.pathname === "src/active-context.ts");
            assert.ok(frame, "the injected prompt was published as its own frame");
            assert.ok(contextRead, "the injected prompt's selected path produced a core READ");
            assert.equal(contextRead.turn_id, frame.turn_id,
                "the context READ is observable in the same turn as its message arrival");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a parked-loop prompt carries its paths into the resumed turn", async (t) => {
    serverProposals(t, "accept");
    const previousSettlement = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (previousSettlement === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousSettlement;
    });
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````sh\nsleep 30\n````\n\n````WAIT\npark\n````"),
            sendOnly("````SEND\ndone with the parked work\n````\n````KILL (session://parked)\n````"),
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

    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "openpaths-parked" });
            const { sessionId } = await daemon.createSession({ workspaceId: (created.result as { id: number }).id, name: "parked" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const started = await rpcCall(ws, 2, "loop.run", {
                sessionId,
                prompt: "start and park",

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
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number; tx: string; attrs: string;
            }>({ loop_id: loopId });
            const frame = rows.find((row) => isArrivalRow(row) && arrivalBody(row) === "resume with this file");
            const contextRead = rows.find((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === null && row.pathname === "src/parked-context.ts");
            assert.ok(frame, "the waking prompt was published as its own frame");
            assert.ok(contextRead, "the waking prompt's selected path produced a core READ");
            assert.equal(contextRead.turn_id, frame.turn_id,
                "the context READ is observable in the resumed turn that publishes its message arrival");
        } finally {
            releaseBoundary.resolve();
            ws.close();
        }
    });
});

test("{§message-arrival}: an injection crossing the park transition is not stranded", async (t) => {
    serverProposals(t, "accept");
    const previousSettlement = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (previousSettlement === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousSettlement;
    });
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````sh\nsleep 30\n````\n\n````WAIT\npark\n````"),
            sendOnly("````SEND\ndone with the injected prompt\n````\n````KILL (session://parked)\n````"),
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

    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "inject-at-park-boundary" });
            const { sessionId } = await daemon.createSession({ workspaceId: (created.result as { id: number }).id, name: "parked" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const started = await rpcCall(ws, 2, "loop.run", {
                sessionId,
                prompt: "start and park",

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
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; pathname: string; tx: string; attrs: string }>({ loop_id: loopId });
            assert.ok(
                rows.some((row) => isArrivalRow(row) && arrivalBody(row) === "do not strand this prompt"),
                "the park-boundary prompt reaches the resumed turn",
            );
        } finally {
            releasePark.resolve();
            ws.close();
        }
    });
});

test("{§message-arrival}: every orphaned message is recovered in order", async () => {
    // Edge: next-turn prompts injected into a loop that then terminates before
    // reaching that turn would be silently lost. Forced deterministically: hold
    // loop 1 at a proposal (status=102, turn 1), inject two turn-2 frames, then
    // let turn 1 complete so loop 1 ends and turn 2 never runs. The drain
    // must promote the orphaned frames to a fresh loop that surfaces them — so two
    // loops terminate for the session, not one (it would be one if the wake were
    // lost; no other op here spawns a loop — the execution proposal is rejected).
    // 16384: the inject-then-reconcile path accumulates both loops' rows across turns, cresting at the 8192 edge;
    // grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the reconcile, not a budget probe.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            // The frames arrive during turn 1, so a model terminal over them defers
            // ({§message-arrival}); loop 1 ends turn 1 at its turn ceiling instead
            // (maxTurns 1 → 429), which no barrier gates: the orphan premise holds.
            sendOnly("````sh\ntrue\n````\n\n````SEND\nloop 1 reaches its turn ceiling\n````"),
            sendOnly("````SEND [200]\nFirst recovered request done.\n````\n\n````SEND [200]\nSecond recovered request done.\n````"),
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
                maxTurns: 1,
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

            const sourceLoopId = ((await firstPromise).result as { loopId: number }).loopId;
            const original = (await db.test_messages_by_loop.all({ loop_id: sourceLoopId })) as Array<{ ordinal: number; body: string }>;
            assert.deepEqual(original.map(({ body }) => body), ["kick off", "the first orphaned follow-up", "the second orphaned follow-up"], "the source loop's inbox holds its assignment and both arrivals");

            // Release the proposal → turn 1 completes → loop 1 ends; the
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
            assert.deepEqual(statuses, [200, 429], "loop 1 ended at its turn ceiling with the frames unpublished; the reconciled loop concluded 200");
            const promoted = ts.find((event) => event.loopId !== firstLoopId);
            assert.ok(promoted, "the orphaned frame was promoted into a distinct loop");
            const sourcePosture = await db.test_get_loop_posture.get<{
                model_route_id: number | null; spawn_model_route_id: number | null; effort: string; max_turns: number;
            }>({ id: firstLoopId });
            const promotedPosture = await db.test_get_loop_posture.get<{
                model_route_id: number | null; spawn_model_route_id: number | null; effort: string; max_turns: number; orphan_source_loop_id: number | null;
            }>({ id: promoted.loopId });
            assert.deepEqual(
                promotedPosture,
                { ...sourcePosture, orphan_source_loop_id: firstLoopId },
                "recovery preserves the source loop's posture and names its durable source",
            );
            const rows = await db.test_log_entries_by_loop.all<{
                op: string; origin: string; scheme: string | null; pathname: string; turn_id: number; tx: string; attrs: string;
            }>({ loop_id: promoted.loopId });
            const frames = rows.filter((row) => isArrivalRow(row));
            assert.deepEqual(
                frames.map((row) => arrivalBody(row)),
                ["the first orphaned follow-up", "the second orphaned follow-up"],
                "the complete orphan set remains separate and ordered in one subsequent turn",
            );
            const promotedInbox = (await db.test_messages_by_loop.all({ loop_id: promoted.loopId })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
            assert.deepEqual(promotedInbox.map(({ ordinal, body }) => ({ ordinal, body })), [
                { ordinal: 1, body: "the first orphaned follow-up" },
                { ordinal: 2, body: "the second orphaned follow-up" },
            ], "the orphans moved into the recovery loop's inbox, renumbered from its first");
            assert.ok(promotedInbox.every(({ log_entry_id }) => log_entry_id !== null), "the recovery loop published them");
            const contextReads = rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === null);
            assert.deepEqual(
                contextReads.map((row) => row.pathname),
                ["src/first-orphan-context.ts", "src/second-orphan-context.ts"],
                "each promoted frame keeps its selected paths in frame order",
            );
            assert.ok(contextReads.every((row) => row.turn_id === frames[0]?.turn_id),
                "all promoted frame paths are read in the turn that publishes the frames");
            const sourceInbox = (await db.test_messages_by_loop.all({ loop_id: sourceLoopId })) as Array<{ body: string }>;
            assert.deepEqual(sourceInbox.map(({ body }) => body), ["kick off"],
                "recovery moves each orphan instead of retaining duplicate old rows; the source keeps only its own assignment");
        } finally { ws.close(); }
    });
});

test("{§actor-boundary} loop.cancel reaps the session's open streams by the subscription registry (closed 499)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // A backgrounded sleep registers an active exec subscription; loop.cancel must reap
    // it THROUGH the registry — the open row closes with the exact 499 Problem — not
    // merely fire a notification. The indexed status is only a relational projection.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````sh\nsleep 30\n````\n\n````WAIT\nbackgrounded\n````"),
            sendOnly("````SEND [200]\ndone\n````"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "reap-registry" });
            const workspaceId = (created.result as { id: number }).id;

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "spawn then leave" });
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

test("{§message-arrival} a cancelled session is not revived by its straggler stream's conclusion", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // After loop.cancel, the backgrounded exec's conclusion must NOT open a fresh loop
    // in the session — the cancel was deliberate. Proven by the session's loop count staying at
    // its single model loop after the conclusion lands (a resurrection would add a
    // wake-opened loop), plus the conclusion's wakeAction being a skip, not opened-loop.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            sendOnly("````sh\nsleep 30\n````\n\n````WAIT\nbackgrounded\n````"),
            sendOnly("````SEND [200]\nshould never run\n````"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "no-resurrection" });
            const workspaceId = (created.result as { id: number }).id;
            const concluded = subscribeNotifications(ws, "stream/concluded");

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "spawn then leave" });
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

            // The session was not resurrected: no prompt-bearing model loop was
            // opened after the original. Runtime documentation reconciliation
            // may have authored terminal administrative loops in the same Session.
            const sessionId = (await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId }))?.session_id;
            const modelLoops = (await db.test_loop_queue_by_session.all<{
                id: number; prompt: string;
            }>({ session_id: sessionId })).filter(({ prompt }) => prompt !== "");
            assert.deepEqual(modelLoops.map(({ id }) => id), [loopId], "no wake loop was opened for the cancelled session");
        } finally { ws.close(); }
    });
});

// {§message-arrival} — a Mock whose first response waits on a gate, so the test
// can inject prompts while turn 1 is genuinely in flight and then let the model complete over them.
class GatedMock extends Mock {
    #gate: Promise<void>;
    #gated = true;
    readonly entered: Promise<void>;
    #enter!: () => void;
    constructor(gate: Promise<void>, ...args: ConstructorParameters<typeof Mock>) {
        super(...args);
        this.#gate = gate;
        this.entered = new Promise<void>((resolve) => { this.#enter = resolve; });
    }
    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        if (this.#gated) { this.#gated = false; this.#enter(); await this.#gate; }
        return super.generate(args);
    }
}

for (const silent of [false, true]) {
    test(`{§message-arrival}: prompts arriving during ${silent ? "empty-body" : "answered"} completion defer it without a strike or a second loop`, async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const mock = new GatedMock(gate, {
            contextWindow: 16384,
            responses: [
                sendOnly(silent ? "````SEND [200]\n````" : "````SEND [200]\nfirst answer, before the follow-ups\n````"),
                sendOnly(silent ? "````SEND [200]\n````\n\n````SEND [200]\n````"
                    : "````SEND [200]\nAnswered the first follow-up.\n````\n\n````SEND [200]\nAnswered the second follow-up.\n````"),
            ],
        });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "defer-to-prompts" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const firstPromise = rpcCall(ws, 2, "loop.run", { prompt: "kick off" });
                // Turn 1's provider call is held open; two prompts arrive meanwhile.
                await mock.entered;
                try {
                    for (const [id, prompt] of [[3, "the first follow-up"], [4, "the second follow-up"]] as const) {
                        const r = await rpcCall(ws, id, "loop.run", { prompt });
                        assert.equal((r.result as { action: string }).action, "injected_next_turn", JSON.stringify(r.result ?? r.error));
                    }
                } finally { release(); }
                const first = await firstPromise;
                const loopId = (first.result as { loopId: number }).loopId;
                const done = await waitFor(
                    () => (terminated() as Array<{ loopId: number; result: { status: number } }>).filter((e) => e.loopId === loopId),
                    (events) => events.length >= 1,
                    { timeoutMs: 5000 },
                );
                assert.equal(done[0].result.status, 200, "the loop completed once the follow-ups were seen");
                const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number | null; turn_id: number; origin: string; rx: string | null; attrs: string }>({ loop_id: loopId });
                const replies = rows.filter((r) => r.op === "SEND" && r.origin === "model");
                assert.deepEqual(replies.map(({ status_rx }) => status_rx), [200, 200, 200], "replies deliver immediately while unseen arrivals defer loop settlement");
                assert.deepEqual(replies.map(({ rx }) => JSON.parse(rx!).repliedTo.length), [1, 1, 1], "each reply resolves one published message, with or without speech");
                const turns = (await db.test_list_turns_in_loop.all({ loop_id: loopId })).filter(({ producer }) => producer === "model");
                assert.deepEqual(turns.map(({ status }) => status), [102, 200]);
                const prompts = rows.filter((r) => isArrivalRow(r));
                assert.equal(prompts.length, 3, "the initial message plus both follow-ups were published");
                assert.ok(prompts.slice(1).every((p) => p.turn_id === replies[1].turn_id), "both follow-ups were published in the turn the model completed from");
                const sessionId = (await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId }))?.session_id;
                const modelLoops = (await db.test_loop_queue_by_session.all<{ id: number; prompt: string }>({ session_id: sessionId })).filter(({ prompt }) => prompt !== "");
                assert.deepEqual(modelLoops.map(({ id }) => id), [loopId], "the observed follow-ups belong to the completed loop, not an orphan recovery loop");
            } finally { ws.close(); }
        });
    });
}
});

describe("KILL.receipt", () => {
const source = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

for (const scheme of ["file", "session"]) for (const anchored of [false, true]) {
    test(`{§op-invariants}: ${scheme} ${anchored ? "anchored" : "numeric"} deletion exposes its existing receipt through packet and log READ`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const root = await mkdtemp(join(tmpdir(), "plurnk-kill-receipt-"));
        const target = scheme === "file" ? "notes.md" : "workspace:///notes.md";
        try {
            const mock = new Mock({ contextWindow: 32768, responses: [
                makeMockResponse(`\`\`\`\`EDIT (${target})
${source}
\`\`\`\`
\`\`\`\`NOTE
Continue the task.
\`\`\`\``, 10),
                makeMockResponse(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\`
\`\`\`\`NOTE
Continue the task.
\`\`\`\``, 10),
                makeMockResponse("````NOTE\ncontinue\n````", 10),
                makeMockResponse("````SEND [200]\ndone\n````", 10),
            ] });
            await withDaemon(mock, async (db, daemon, addr) => {
                const generate = mock.generate.bind(mock);
                let calls = 0;
                mock.generate = async (args) => {
                    if (++calls === 3) {
                        const packet = args.messages.map(chatMessageText).join("\n");
                        const start = packet.match(/^ *10<(@[A-Za-z0-9]{5})>line 10$/m)?.[1];
                        const end = packet.match(/^ *11<(@[A-Za-z0-9]{5})>line 11$/m)?.[1];
                        assert.ok(start && end, "the preceding READ published the coordinates used by KILL");
                        const scope = anchored ? `${start},${end}` : "10,11";
                        return new Mock({ contextWindow: 32768, responses: [makeMockResponse(`\`\`\`\`KILL (${target}) <${scope}>\`\`\`\`
\`\`\`\`NOTE
Continue the task.
\`\`\`\``, 10)] }).generate(args);
                    }
                    return generate(args);
                };
                const ws = await connect(addr);
                try {
                    const created = await rpcCall(ws, 1, "workspace.create", { name: "kill-receipt", projectRoot: root });
                    const workspaceId = (created.result as { id: number }).id;
                    const run = await runLoopToTerminal(ws, 2, { prompt: "delete two lines" });
                    assert.equal(run.finalStatus, 200);
                    const rows = await db.engine_render_log.all<{ id: number; op: string; origin: string; source: number | null; rx: string; weight: number }>({ session_id: run.modelSessionId! });
                    const kill = rows.find((row) => row.op === "KILL" && row.origin === "model" && row.source === null);
                    assert.ok(kill, "an entry mutation receipt stays visible on later turns");
                    const rx = JSON.parse(kill.rx);
                    assert.equal(rx.status, 200, JSON.stringify(rx));
                    assert.equal(rx.receipt.effect.removedText, "line 10\nline 11");
                    const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: run.turnIds!.at(-1)! }))!.packet);
                    const log = packetSection(packet, "log");
                    const receipt = parseLogRecords(log).find((row) => row.logPath.endsWith("/KILL"));
                    assert.ok(receipt, "the packet retains the KILL identity");
                    assert.equal(receipt.path, scheme === "file" ? "notes.md" : target);
                    assert.equal(receipt.extent, "lines 20->18");
                    assert.equal(receipt.change, "lines -2 +0");
                    assert.equal(receipt.removed, "line 10\nline 11");
                    assert.equal(receipt.effect, `${rx.receipt.effect.source} -> ${rx.receipt.effect.result}`);
                    assert.equal(receipt.body, `${rx.receipt.effect.context}\n`);
                    assert.equal(receipt.preview, undefined, "bounded mutation context is not previewed again");
                    assert.ok(kill.weight > 0, "canonical receipt content participates in body accounting");
                    assert.ok(receipt.tokens > 0, "packet accounting includes the complete visible receipt");
                    // A person's READ of the model's log, acting for the model session ({§connection-lifecycle}).
                    const [recalled] = await daemon.dispatchClientAction({
                        workspaceId, actor: TEST_OWNER, contextSessionId: run.modelSessionId!,
                        statements: [{ op: "READ", aside: null, metadata: null, target: parsePath(receipt.logPath), lineMarker: { marks: [1, -1] }, matcher: null, body: null, position: { line: 1, column: 0 } }],
                    });
                    assert.equal(recalled.status, 200, JSON.stringify({ logPath: receipt.logPath, recalled }));
                    assert.equal(recalled.content, rx.receipt.effect.context, "log READ and packet share one canonical receipt body");
                } finally { ws.close(); }
            });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}

test("{§op-invariants} whole-entry KILL has a bodyless result, not an invented text mutation receipt", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````EDIT (workspace:///doomed)\ncontent\n````\n````NOTE\nContinue the task.\n````", 10),
        makeMockResponse("````KILL (workspace:///doomed)````\n````NOTE\nContinue the task.\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "whole-kill" });
            const run = await runLoopToTerminal(ws, 2, { prompt: "remove the entry" });
            assert.equal(run.finalStatus, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: run.turnIds!.at(-1)! }))!.packet);
            const log = packetSection(packet, "log");
            const receipt = parseLogRecords(log).find((row) => row.logPath.endsWith("/KILL"));
            assert.ok(receipt);
            assert.equal(Object.hasOwn(receipt, "status"), false, "routine success is implicit for whole-entry deletion too");
            assert.equal(receipt.path, "workspace:///doomed");
            for (const field of ["body", "extent", "change", "removed", "range"]) {
                assert.equal(receipt[field], undefined, `whole-entry deletion has no ${field}`);
            }
        } finally { ws.close(); }
    });
});
});

describe("invocation", () => {
const streamed = (content: string): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
        const frame = { id: "invocation", model: "invocation-witness", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

// One loop of `main` against a scripted model whose calls the WAITs serialize; each named session's log after it, in order,
// and its loops.
const run = async (
    t: TestContext,
    script: readonly string[],
    peers: readonly string[],
    check: (
        logs: (name: string) => Promise<LogEntryWire[]>,
        announced: readonly LogEntryWire[],
        session: (name: string) => Promise<{ id: number; loops: readonly ApplicationLoopProjection[] }>,
    ) => Promise<void>,
): Promise<void> => {
    serverProposals(t, "accept");
    let calls = 0;
    const provider = new ModelProvider({
        model: "invocation-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => streamed(script[Math.min(calls++, script.length - 1)]),
    });
    await withDaemon(provider, async (db: Db, daemon: Daemon) => {
        const announced: LogEntryWire[] = [];
        daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "log/entry") announced.push((params as { entry: LogEntryWire }).entry);
        });
        const { workspaceId } = await daemon.createWorkspace({ name: `invocation-${crypto.randomUUID()}` });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        for (const peer of peers) await namedModelSession(daemon, workspaceId, peer);
        const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Begin." });
        const status = await waitForDb(() => new LoopLifecycle(db).status(loopId), (value) => value === 200 || value >= 400);
        assert.equal(status, 200, "main concludes");
        const named = async (name: string): Promise<number> => {
            const session = (await daemon.listSessions(workspaceId)).find((candidate) => candidate.name === name);
            assert.ok(session, `${name} exists`);
            return session.id;
        };
        await check(
            async (name) => (await daemon.readLog({ workspaceId, sessionId: await named(name), limit: 1000 })).toSorted((left, right) => left.id - right.id),
            announced,
            async (name) => {
                const id = await named(name);
                return { id, loops: await daemon.listSessionLoops({ workspaceId, sessionId: id }) };
            },
        );
    });
};

const address = (row: LogEntryWire): string => `log:///${row.loop_seq}/${row.turn_seq}/${row.sequence}/${row.op}`;
const attrs = (row: LogEntryWire): Record<string, unknown> => row.attrs as Record<string, unknown>;

test("{§methods-invocation} a stream's observation names its execution, and a FORK's copy names the same one", async (t) => {
    await run(t, [
        "````sh\nprintf 'hello\\n'\n````\n````WAIT\n````",
        "````FORK (session://branch)\nConfirm the greeting.\n````\n````WAIT\n````",
        "````SEND [200]\nConfirmed.\n````",
        "````SEND [200]\nDone.\n````",
    ], [], async (logs, announced) => {
        const main = await logs("main");
        const execution = main.find(({ op }) => op === "sh")!;
        const observation = main.find(({ invocation }) => invocation === address(execution));
        assert.equal((observation?.rx as { content?: unknown } | undefined)?.content, "hello\n", "the observation names the execution that opened its stream");
        assert.equal(observation?.source, null, "the observation's attribution is unchanged");
        assert.equal(announced.find(({ id }) => id === observation.id)?.invocation, observation.invocation, "log/entry carries it as readLog does");
        const copy = (await logs("branch")).find((row) =>
            row.origin === "_plurnk" && row.loop_seq === observation.loop_seq && row.turn_seq === observation.turn_seq && row.sequence === observation.sequence);
        assert.equal(copy?.invocation, observation.invocation, "the branch's copy names the execution at the same coordinate");
    });
});

test("{§methods-invocation} {§loop-completion} a delegation is answered by its child's conclusion, and a message by its completion reply", async (t) => {
    await run(t, [
        "````WORK (session://helper)\nSay hello.\n````\n````WAIT\n````",
        "````SEND [200]\nhello from the helper\n````",
        "````SEND (session://peer)\nWhat is the answer?\n````\n````WAIT\n````",
        "````SEND [200]\nforty-two\n````",
        "````SEND [200]\nThe helper said hello; the answer is forty-two.\n````",
    ], ["peer"], async (logs, _announced, session) => {
        const main = await logs("main");
        const work = main.find(({ op }) => op === "WORK")!;
        const send = main.find(({ op, attrs: opened }) => op === "SEND" && typeof (opened as { message?: unknown }).message === "string")!;
        assert.match(String(attrs(work).message), /^message:\/\/helper\//u, "the WORK names the message it sent");
        assert.match(String(attrs(send).message), /^message:\/\/peer\//u, "the SEND names the message it sent");
        const answers = main.filter(({ invocation }) => invocation !== undefined).map(({ invocation, op, source, attrs: kind }) =>
            ({ invocation, op, source, kind: (kind as { kind?: unknown }).kind }));
        assert.deepEqual(answers, [
            { invocation: address(work), op: "READ", source: "session://helper", kind: "loop_termination" },
            { invocation: address(send), op: "SEND", source: "session://peer", kind: "reply" },
        ], "the child's conclusion answers the WORK and the peer's completion answers the SEND, each once");
        const wait = main.find(({ op, sequence, turn_seq }) => op === "WAIT" && turn_seq === send.turn_seq && sequence > send.sequence);
        assert.equal(wait?.status_rx, 202, "the open message held its sender, so the WAIT parked until the reply");
        const peer = await logs("peer");
        assert.equal(peer.find(({ op, origin }) => op === "SEND" && origin === "_plurnk")?.source, "session://main", "the message names its sender");
        // {§methods-workspace-create} A loop names the operation that opened it; a person's prompt is no session's operation.
        const sender = await session("main");
        assert.deepEqual((await session("helper")).loops.map(({ invocation }) => invocation), [{ sessionId: sender.id, address: address(work) }],
            "the child's loop was opened by the WORK");
        assert.deepEqual((await session("peer")).loops.map(({ invocation }) => invocation), [{ sessionId: sender.id, address: address(send) }],
            "the peer's loop was opened by the SEND");
        assert.deepEqual(sender.loops.map(({ invocation }) => invocation), [null], "main's loop was opened by a person's prompt");
    });
});

test("{§methods-invocation} a peer's progress and its completion each name the SEND they answer; only the completion discharges it", async (t) => {
    await run(t, [
        "````SEND (session://peer)\nWhat is the answer?\n````\n````WAIT\n````",
        "````SEND\nStill looking.\n````\n````SEND [200]\nforty-two\n````",
        "````SEND [200]\nThe answer is forty-two.\n````",
    ], ["peer"], async (logs, announced) => {
        const main = await logs("main");
        const send = main.find(({ op, attrs: opened }) => op === "SEND" && typeof (opened as { message?: unknown }).message === "string")!;
        const replies = main.filter(({ answering }) => answering !== undefined).map(({ answering, invocation, source, tx }) =>
            ({ answering, invocation, source, body: (tx as { body?: { raw?: unknown } } | null)?.body?.raw }));
        assert.deepEqual(replies, [
            { answering: address(send), invocation: undefined, source: "session://peer", body: "Still looking." },
            { answering: address(send), invocation: address(send), source: "session://peer", body: "forty-two" },
        ], "progress names the SEND it answers; the completion names it twice, as what it answers and what it discharges");
        const progress = main.find(({ answering, invocation }) => answering !== undefined && invocation === undefined)!;
        assert.equal(announced.find(({ id }) => id === progress.id)?.answering, address(send), "log/entry carries it as readLog does");
        assert.equal((await logs("peer")).some(({ answering }) => answering !== undefined), false, "the peer's own log answers nothing of its own");
    });
});
});

describe("live-harness-cancellation", () => {
test("{§test-artifact-retention}: an expired specimen finishes cleanup before the next specimen", async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const fail of ["0", "1"]) {
        await assert.rejects(promisify(execFile)(process.execPath, [
            "--conditions=plurnk-dev", "--test", "--test-reporter=spec",
            fileURLToPath(new URL("./fixtures/live-deadline.fixture.ts", import.meta.url)),
        ], { timeout: 5000, env: { ...env, PLURNK_SERVICE_LIVE_TIMEOUT: "30", PLURNK_TEST_CLEANUP_FAIL: fail } }), (error: unknown) => {
            const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
            assert.equal(result.code, 1, "only the deliberately expired specimen fails");
            assert.notEqual(result.killed, true, "the test process exits by itself");
            assert.match(result.stdout ?? "", /deadline cleanup completed[\s\S]*next specimen started after cleanup/);
            assert.match(result.stdout ?? "", /✔ next specimen sees completed cleanup/);
            if (fail === "1") assert.match((result.stdout ?? "") + (result.stderr ?? ""), /cleanup failed visibly/);
            return true;
        });
    }
});

test("{§test-artifact-retention}: failed workspace startup still stops, closes and digests its resources", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const stopped = t.mock.method(Daemon.prototype, "stop");
    const digested = t.mock.method(Digest, "run");
    const failure = new Error("workspace startup failed");
    t.mock.method(Daemon.prototype, "start", async () => { throw failure; });
    await assert.rejects(liveWorkspace({ name: "harness-startup-failure" }), (error) => error === failure);
    assert.equal(stopped.mock.callCount(), 1);
    assert.equal(digested.mock.callCount(), 1, "the closed database remains a diagnostic artifact");
    const { dbPath } = digested.mock.calls[0].arguments[0];
    t.after(() => rm(dirname(dbPath), { recursive: true, force: true }));
    assert.equal(dirname(dirname(dbPath)), process.env.PLURNK_BENCHMARKS ?? join(homedir(), "benchmarks"),
        "live evidence stays in the configured or home benchmark directory, independent of checkout depth");
});

test("{§methods}: the live harness preserves caller cancellation and stops inference", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<unknown>();
    t.mock.method(provider, "generate", async ({ signal }: { signal: AbortSignal }) => {
        entered.resolve();
        return await new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
                cancelled.resolve(signal.reason);
                reject(signal.reason);
            }, { once: true });
        });
    });
    await withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-harness-cancel" });
            const controller = new AbortController();
            const reason = new Error("outer specimen cancelled");
            // The subject is the abort, not the deadline: the deadline only has to outlast the loop reaching
            // inference on a loaded host, so the abort is always what ends the specimen.
            const running = liveLoop({ db, ws }, 2, { prompt: "wait" }, { timeoutMs: 20_000, signal: controller.signal });
            const rejected = assert.rejects(running, (error) => error === reason);
            await entered.promise;
            controller.abort(reason);
            await rejected;
            assert.ok(await cancelled.promise, "the provider receives cancellation before teardown");
            const rows = await waitForDb(
                () => db.test_list_loops_all.all<{ status: number; terminal_result: string }>({}),
                (loops) => loops.some((loop) => loop.status === 499),
            );
            const result = JSON.parse(rows.find((loop) => loop.status === 499)!.terminal_result);
            assert.match(result.problem.reason, /outer specimen cancelled/);
            assert.doesNotMatch(result.problem.reason, /harness_timeout/);
        } finally { ws.close(); }
    });
});

test("{§methods}: an admission failure is not misreported as a harness timeout", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    await withDaemon(provider, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-harness-admission" });
            t.mock.method(daemon, "runLoop", async () => { throw new Error("admission failed"); });
            const cancellation = t.mock.method(daemon, "cancelDrain", () => false);
            await assert.rejects(liveLoop({ db, ws }, 2, { prompt: "go" }), /admission failed/);
            assert.equal(cancellation.mock.callCount(), 1);
            assert.match(String(cancellation.mock.calls[0].arguments[1]), /admission failed/);
            assert.doesNotMatch(String(cancellation.mock.calls[0].arguments[1]), /harness_timeout/);
        } finally { ws.close(); }
    });
});
});

describe("loop-terminal-order", () => {
type Ending = "cancellation" | "timeout" | "shutdown" | "turn ceiling";
type Holder = "turn" | "parked" | "stream";
type Ends = { daemon: Daemon; workspaceId: number; sessionId: number; expire: () => void };

const QUESTION = "````plurnk (question)\n{\"message\":\"Which branch?\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}}}}\n````";
const WAIT = "````WAIT\nAwaiting an answer.\n````";

// A parked loop neither executes nor ends at shutdown: cancellation is the way it ends. A loop that left its interaction
// open works on, so its next call is held while it ends; the turn ceiling ends it before that call.
const CASES: ReadonlyArray<{ gate: "proposal" | "interaction"; op: string; holder: Holder; emission: string; endings: readonly Ending[] }> = [
    { gate: "proposal", op: "sh", holder: "turn", emission: "````sh\necho held\n````", endings: ["cancellation", "timeout", "shutdown"] },
    { gate: "interaction", op: "plurnk", holder: "turn", emission: `${QUESTION}\n${WAIT}`, endings: ["cancellation", "timeout", "shutdown"] },
    { gate: "interaction", op: "plurnk", holder: "parked", emission: `${QUESTION}\n${WAIT}`, endings: ["cancellation"] },
    { gate: "interaction", op: "plurnk", holder: "stream", emission: QUESTION, endings: ["cancellation", "timeout", "shutdown", "turn ceiling"] },
];

const HOLDERS: Record<Holder, string> = { turn: "a running turn", parked: "a parked loop", stream: "a loop working on" };

const END: Record<Ending, (ends: Ends) => Promise<void>> = {
    cancellation: ({ daemon, workspaceId, sessionId }) => daemon.cancelSession({ workspaceId, sessionId, reason: "user_escape" }),
    timeout: async ({ expire }) => expire(),
    shutdown: ({ daemon }) => daemon.stop(),
    "turn ceiling": async () => {},
};

for (const { gate, op, holder, emission, endings } of CASES) {
    for (const ending of endings) {
        test(`{§notifications}: ${gate === "proposal" ? "a proposal" : "a client interaction"} held by ${HOLDERS[holder]}, ended by ${ending}, settles before its loop's one terminal`, async (t) => {
            // The turn holds an interaction through its settlement window; a zero window parks the loop at once, or, with
            // no WAIT, leaves the interaction open while the loop works on.
            const window = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = holder === "turn" ? "60000" : "0";
            t.after(() => {
                if (window === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
                else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = window;
            });
            // The allowance runs out on cue: the loop's own timer callback, fired once its gate is held.
            const startExecution = LoopLifecycle.prototype.startExecution;
            const timers = new Map<number, () => void>();
            t.mock.method(LoopLifecycle.prototype, "startExecution", function (this: LoopLifecycle, loopId: number, budgetMs: number, onTimeout: () => void) {
                timers.set(loopId, onTimeout);
                return startExecution.call(this, loopId, budgetMs, onTimeout);
            });
            const provider = new StreamMock({ contextWindow: 100_000, responses: [
                makeMockResponse(emission), makeMockResponse("````NOTE\nWorking on.\n````"),
            ] });
            // The working loop's next call is held until its ending is under way.
            const generate = provider.generate.bind(provider);
            const held = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            let calls = 0;
            t.mock.method(provider, "generate", async (...args: Parameters<StreamMock["generate"]>) => {
                if (holder === "stream" && ++calls === 2) {
                    held.resolve();
                    await release.promise;
                }
                return generate(...args);
            });
            t.after(() => release.resolve());
            await withDaemon(provider, async (db, daemon) => {
                const { workspaceId } = await daemon.createWorkspace({ name: `terminal-order-${gate}-${holder}-${ending}` });
                const sessionId = await namedModelSession(daemon, workspaceId, "main");
                await ownSession(db, workspaceId, sessionId);
                const order: string[] = [];
                const delayedAnnouncement = gate === "interaction" && ending === "timeout";
                const announcing = Promise.withResolvers<void>();
                const deliver = Promise.withResolvers<void>();
                const terminalReady = Promise.withResolvers<void>();
                if (delayedAnnouncement) {
                    const findSlept = db.drain_find_slept_loop.get.bind(db.drain_find_slept_loop);
                    t.mock.method(db.drain_find_slept_loop, "get", async (...args: Parameters<typeof findSlept>) => {
                        announcing.resolve();
                        await deliver.promise;
                        return findSlept(...args);
                    });
                    const observation = LoopLifecycle.prototype.observation;
                    t.mock.method(LoopLifecycle.prototype, "observation", async function (this: LoopLifecycle, id: number) {
                        const result = await observation.call(this, id);
                        if (result.terminatedAt !== null) {
                            await announcing.promise;
                            terminalReady.resolve();
                        }
                        return result;
                    });
                }
                const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
                    if (method === (gate === "proposal" ? "loop/proposal" : "loop/interaction")) order.push("held");
                    const entry = (params as { entry?: { op?: string; status_rx?: number } }).entry;
                    if (method === "log/entry" && entry?.op === op && (entry.status_rx ?? 0) >= 400) order.push("settled");
                    if (method === "stream/concluded" && gate === "interaction") order.push("settled");
                    if (method === "loop/terminated") order.push(`terminated ${(params as { loopId: number }).loopId}`);
                });
                try {
                    const { loopId, drainPromise } = await daemon.inject({
                        workspaceId, sessionId, prompt: "Go.",
                        providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                        effort: "adaptive", systemPrompt: "test system",
                        ...(ending === "turn ceiling" ? { turnCeiling: { effective: 1, source: "explicit" as const } } : {}),
                    });
                    await waitForDb(async () => order, (events) => events.includes("held"));
                    if (holder === "parked") {
                        assert.ok(drainPromise !== undefined, "the injection started the session's drain");
                        await drainPromise;
                        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 202, "the loop is parked");
                    }
                    if (holder === "stream" && ending !== "turn ceiling") await held.promise;
                    const expire = (): void => (timers.get(loopId) ?? assert.fail("the loop never started executing"))();
                    const ended = END[ending]({ daemon, workspaceId, sessionId, expire });
                    release.resolve();
                    await ended;
                    const terminated = `terminated ${loopId}`;
                    if (delayedAnnouncement) {
                        await terminalReady.promise;
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        assert.equal(order.includes(terminated), false, "a committed stream close still owes its announcement before the terminal");
                        deliver.resolve();
                    }
                    await waitForDb(async () => order, (events) => events.includes(terminated));
                    // Stopped, the daemon has settled every producer: a second terminal would be here by now.
                    await daemon.stop();
                    const settled = order.indexOf("settled");
                    assert.ok(order.indexOf("held") < settled && settled < order.indexOf(terminated), `the gate settles before its loop's terminal: ${order.join(" > ")}`);
                    assert.equal(order.filter((event) => event === terminated).length, 1, `the loop announces one terminal: ${order.join(" > ")}`);
                } finally {
                    deliver.resolve();
                    off();
                }
            });
        });
    }
}
});

describe("readlog-paging", () => {
const work = "````NOTE\nPlan the notes.\n````\n````EDIT (workspace:///a.md)\nfirst\n````\n````READ (workspace:///a.md)\n````";
const done = "````SEND [200]\nDone.\n````";

const streamed = (frames: readonly object[]): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

test("{§methods} {§methods-invocation} beforeId pages newest first through the whole log, and the reasoning row names its streaming request", async (t) => {
    serverProposals(t, "accept");
    let calls = 0;
    const provider = new ModelProvider({
        model: "paging-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            const frames: object[] = [];
            if (calls++ === 0) {
                frames.push({ id: "paging", model: "paging-witness", choices: [{ index: 0, delta: { reasoning_content: "Weighing the plan." }, finish_reason: null }] });
            }
            frames.push({ id: "paging", model: "paging-witness", choices: [{ index: 0, delta: { content: calls === 1 ? work : done }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
            return streamed(frames);
        },
    });
    await withDaemon(provider, async (db, daemon) => {
        const streams: Array<{ modelCallId: number; requestSequence: number }> = [];
        daemon.subscribeToEvents((_workspaceId, method, params) => {
            const event = params as { phase?: string; modelCallId: number; requestSequence: number };
            if (method === "reasoning/event" && event.phase === "start") streams.push(event);
        });
        const { workspaceId } = await daemon.createWorkspace({ name: `paging-${crypto.randomUUID()}` });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Note a." });
        const status = await waitForDb(() => new LoopLifecycle(db).status(loopId), (value) => value === 200 || value >= 400);
        if (status !== 200) {
            const rows = await daemon.readLog({ workspaceId, sessionId, limit: 50 });
            assert.fail(`loop ${status}: ${JSON.stringify(rows.map(({ loop_seq, turn_seq, sequence, origin, op, status_rx, rx }) => [loop_seq, turn_seq, sequence, origin, op, status_rx, JSON.stringify(rx).slice(0, 160)]))}`);
        }

        const whole = await daemon.readLog({ workspaceId, sessionId, limit: 1000 });
        assert.ok(whole.length >= 4, `the loop wrote its rows: ${whole.length}`);
        assert.deepEqual(whole.map(({ id }) => id), whole.map(({ id }) => id).toSorted((left, right) => right - left), "newest first");
        const paged: LogEntryWire[] = [];
        for (let beforeId: number | undefined; ;) {
            const page = await daemon.readLog({ workspaceId, sessionId, limit: 2, ...(beforeId === undefined ? {} : { beforeId }) });
            if (page.length === 0) break;
            paged.push(...page);
            beforeId = page.at(-1)!.id;
        }
        assert.deepEqual(paged.map(({ id }) => id), whole.map(({ id }) => id), "the pages are the whole log, nothing skipped or repeated");

        const carriers = whole.filter(({ reasoning }) => typeof reasoning === "string");
        assert.equal(carriers.length, 1, "one row carries the turn's reasoning");
        assert.equal(carriers[0].reasoning, "Weighing the plan.");
        assert.equal(streams.length, 1, "the turn's one request streamed its reasoning");
        assert.deepEqual(
            { call: carriers[0].reasoning_model_call_id, request: carriers[0].reasoning_request_sequence },
            { call: streams[0].modelCallId, request: streams[0].requestSequence },
            "the row names the request that streamed it",
        );
        assert.ok(whole.filter(({ reasoning }) => reasoning === undefined).every((row) => row.reasoning_model_call_id === undefined),
            "a row without reasoning names no request");
    });
});
});

describe("readlog-session-filter", () => {
test("{§methods}: readLog honors per-session journal isolation", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "r376" });
            const workspaceId = (created.result as { id: number }).id;
            const modelSession = await namedModelSession(daemon, workspaceId, "main");
            // Seed one row in each session: a person's operation journals in the runtime session
            // ({§connection-lifecycle}); the model's own operation in its session.
            await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "workspace:///client-note", content: "client row" })] });
            await modelOperation(daemon, db, { workspaceId, sessionId: modelSession, statement: Dsl.buildEdit({ target: "workspace:///model-note", content: "model row" }) });
            const runtimeSession = await daemon.ensureRuntimeSession(workspaceId);
            const runtimeRows = await daemon.readLog({ workspaceId, sessionId: runtimeSession });
            const modelRows = await daemon.readLog({ workspaceId, sessionId: modelSession });
            assert.ok(runtimeRows.length > 0 && modelRows.length > 0, "both sessions have rows");
            const runtimeSet = new Set(runtimeRows.map((r) => JSON.stringify(r)));
            assert.ok(!modelRows.every((r) => runtimeSet.has(JSON.stringify(r))), "the two sessions return DIFFERENT rows");
        } finally { ws.close(); }
    });
});

test("{§methods}: the panel is the page of a read that names no limit, and the ceiling of one that does", async () => {
    const prior = { page: process.env.PLURNK_SERVICE_LOG_READ_PAGE, max: process.env.PLURNK_SERVICE_LOG_READ_MAX };
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "readlog-page" });
            const workspaceId = (created.result as { id: number }).id;
            for (let n = 1; n <= 5; n += 1) {
                await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: `workspace:///note-${n}`, content: `row ${n}` })] });
            }
            // A person's operations journal in the runtime session ({§connection-lifecycle}).
            const sessionId = await daemon.ensureRuntimeSession(workspaceId);
            process.env.PLURNK_SERVICE_LOG_READ_PAGE = "2";
            process.env.PLURNK_SERVICE_LOG_READ_MAX = "4";
            assert.equal((await daemon.readLog({ workspaceId, sessionId })).length, 2, "no limit named: the page");
            assert.equal((await daemon.readLog({ workspaceId, sessionId, limit: 3 })).length, 3, "a named limit beneath the ceiling stands");
            assert.equal((await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER })).length, 4, "as many as it likes: the ceiling");
        } finally {
            ws.close();
            for (const [name, value] of [["PLURNK_SERVICE_LOG_READ_PAGE", prior.page], ["PLURNK_SERVICE_LOG_READ_MAX", prior.max]] as const) {
                if (value === undefined) delete process.env[name]; else process.env[name] = value;
            }
        }
    });
});
});
