// {§methods-loop-run-fold-consistency} — folded prompts preserve durable loop configuration.
import test from "node:test";
import assert from "node:assert/strict";
import { InvalidLoopFlagsError } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, makeMockResponse, subscribeNotifications, waitFor, waitForDb, runLoopToTerminal } from "./_rpc.ts";

const heldLoopMock = () => new Mock({ contextWindow: 16384, responses: [
    // A non-auto EXEC proposal holds loop 1 live (paused at the review) while injects arrive.
    makeMockResponse("# PLAN0\nhold\n\n## EXEC0 [sh]\necho hold\n\n## SEND0 [102]\nworking", 10),
    makeMockResponse("## SEND0 [200]\ndone", 10),
    makeMockResponse("## SEND0 [200]\ndone again", 10),
] });

test("{§methods-loop-run-fold-consistency}: conflicting flags cannot re-posture a live loop", async () => {
    await withDaemon(heldLoopMock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "posture-conflict" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "start working", flags: { auto: false } });
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            // Loop 1 is live (held at the proposal). An ask-mode prompt must not fold in as act.
            const conflicted = await rpcCall(ws, 3, "loop.run", { prompt: "? what is the plan", flags: { mode: "ask" } });
            const problem = rpcProblem(conflicted);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/loop/loop-flags-conflict");
            assert.deepEqual(problem.conflicts, ["mode: \"act\" -> \"ask\""]);
            assert.match(problem.recovery ?? "", /Cancel.*or omit flags/);
        } finally { ws.close(); }
    });
});

test("{§methods-loop-run-fold-consistency}: matching or absent flags fold without changing posture", async () => {
    await withDaemon(heldLoopMock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "posture-match" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "start working", flags: { auto: false } });
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            const matching = await rpcCall(ws, 3, "loop.run", { prompt: "also do this", flags: { auto: false } });
            assert.equal((matching.result as { action: string }).action, "injected_next_turn", "identical flags fold clean");
            const bare = await rpcCall(ws, 4, "loop.run", { prompt: "and this" });
            assert.equal((bare.result as { action: string }).action, "injected_next_turn", "absent flags adopt the loop's posture");
            // Release the held proposal so teardown reaps a settled world.
            const pending = proposals() as Array<{ logEntryId: number }>;
            await rpcCall(ws, 5, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
            await runLoopToTerminal(ws, 6, { prompt: "wrap up", flags: { auto: false } }).catch(() => {});
        } finally { ws.close(); }
    });
});

test("inject surfaces contract-invalid durable posture before comparing it (#169)", async () => {
    await withDaemon(heldLoopMock(), async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "posture-invalid" });
            const workspaceId = (created.result as { id: number }).id;
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const started = await rpcCall(ws, 2, "loop.run", { prompt: "start working", flags: { auto: false } });
            const { loopId, modelWorkerId } = started.result as { loopId: number; modelWorkerId: number };
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            await db.engine_set_loop_flags.run({ loop_id: loopId, flags: JSON.stringify({ noInteraction: "sometimes" }) });

            await assert.rejects(
                daemon.runLoop({ workspaceId, workerId: modelWorkerId, prompt: "fold this", flags: { mode: "ask" } }),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.equal(error.message, `Loop ${loopId} has invalid persisted flags.`);
                    assert.ok(error.cause instanceof InvalidLoopFlagsError);
                    return true;
                },
            );

            await db.engine_set_loop_flags.run({ loop_id: loopId, flags: "{}" });
            const pending = proposals() as Array<{ logEntryId: number }>;
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
        } finally { ws.close(); }
    });
});

test("{§methods-loop-run-fold-consistency}: a folded prompt cannot replace the durable turn ceiling", async () => {
    await withDaemon(heldLoopMock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "max-turns-conflict" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const started = await rpcCall(ws, 2, "loop.run", { prompt: "start working", maxTurns: 5 });
            const loopId = (started.result as { loopId: number }).loopId;
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });

            const omitted = await rpcCall(ws, 3, "loop.run", { prompt: "keep the ceiling" });
            assert.equal((omitted.result as { action: string }).action, "injected_next_turn");
            assert.equal(
                (await db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId }))?.max_turns,
                5,
                "an omitted ceiling leaves the durable selection unchanged",
            );

            const matching = await rpcCall(ws, 4, "loop.run", { prompt: "same ceiling", maxTurns: 5 });
            assert.equal((matching.result as { action: string }).action, "injected_next_turn");

            const conflicted = await rpcCall(ws, 5, "loop.run", { prompt: "different ceiling", maxTurns: 6 });
            const problem = rpcProblem(conflicted);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/loop/turn-ceiling-conflict");
            assert.equal(problem.selectedMaximumTurns, 5);
            assert.equal(problem.requestedMaximumTurns, 6);
            assert.match(problem.recovery ?? "", /Cancel or conclude/);
        } finally {
            ws.close();
        }
    });
});

test("{§methods-loop-run-fold-consistency}: an omitted ceiling resumes a parked loop unchanged", async () => {
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [202] <-1>\npark", 10),
            makeMockResponse("## SEND0 [499]\ndone", 10),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "parked-max-turns" });
            const started = await rpcCall(ws, 2, "loop.run", {
                prompt: "start and park",
                flags: { auto: true },
                maxTurns: 5,
            });
            const loopId = (started.result as { loopId: number }).loopId;
            await waitForDb(
                async () => (await db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId }))?.max_turns,
                (maxTurns) => maxTurns === 5,
            );
            await waitForDb(
                async () => (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
                (status) => status === 202,
                { timeoutMs: 10_000 },
            );

            const conflicted = await rpcCall(ws, 3, "loop.run", { prompt: "different ceiling", maxTurns: 6 });
            assert.equal(rpcProblem(conflicted).type, "https://problems.plurnk.xyz/daemon/loop/turn-ceiling-conflict");

            const omitted = await rpcCall(ws, 4, "loop.run", { prompt: "resume with the durable ceiling" });
            assert.equal((omitted.result as { action: string }).action, "injected_next_turn");
            assert.equal((omitted.result as { loopId: number }).loopId, loopId, "the parked loop resumes in place");
            assert.equal(
                (await db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId }))?.max_turns,
                5,
            );
        } finally {
            ws.close();
        }
    });
});
