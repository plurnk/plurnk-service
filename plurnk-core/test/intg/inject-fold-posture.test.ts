import { serverProposals, TEST_OWNER } from "./_approval.ts";
// {§methods-loop-run-fold-consistency} — folded prompts preserve durable loop configuration.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, subscribeNotifications, waitFor, waitForDb } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

const heldLoopMock = () => new Mock({ contextWindow: 16384, responses: [
    // A non-auto execution proposal holds loop 1 live (paused at the review) while injects arrive.
    makeMockResponse("\n````sh\necho hold\n````\n\n````NOTE\nworking\n````", 10),
    makeMockResponse("````KILL\ndone\n````", 10),
    makeMockResponse("````KILL\ndone again\n````", 10),
] });

test("{§worker-ownership}: injecting a message preserves the owner's pending review", async () => {
    await withDaemon(heldLoopMock(), async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "owned-injection" });
            const workspaceId = (created.result as { id: number }).id;
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const started = await rpcCall(ws, 2, "loop.run", { prompt: "start working" });
            const { modelWorkerId } = started.result as { modelWorkerId: number };
            const pending = await waitFor(() => proposals() as Array<{ logEntryId: number }>, (items) => items.length === 1);
            const folded = await rpcCall(ws, 3, "loop.run", { prompt: "also do this" });
            assert.equal((folded.result as { action: string }).action, "injected_next_turn");
            assert.equal((await daemon.readWorker({ workspaceId, identity: { id: modelWorkerId } }))?.owner, TEST_OWNER);
            assert.equal((await daemon.pendingProposals(workspaceId)).length, 1);
            await rpcCall(ws, 5, "loop.resolve", { logEntryId: pending[0]!.logEntryId, decision: "reject" });
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

test("{§methods-loop-run-fold-consistency}: an omitted ceiling resumes a parked loop unchanged", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("````sh\nsleep 30\n````\n\n````WAIT\npark\n````", 10),
            makeMockResponse("````KILL\ndone\n````", 10),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "parked-max-turns" });
            const started = await rpcCall(ws, 2, "loop.run", {
                prompt: "start and park",

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
