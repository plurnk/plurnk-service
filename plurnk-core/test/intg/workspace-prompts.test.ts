// {§methods-workspace-prompts}: clients read prompt history without log archaeology; history is
// what a client addressed to a worker, scoped like log.read (#894).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const send = () => makeMockResponse("````KILL\nok\n````", 50);
const addressed = (thread: string, id: string) => {
    const address = `agui://anonymous/threads/${thread}/messages/${id}`;
    return { source: address, messageAddress: address };
};

test("{§methods-workspace-prompts}: workspace prompts are newest-first and limit-capped", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompts-hist" });
            await runLoopToTerminal(ws, 2, { prompt: "first prompt", ...addressed("prompts-hist", "1") });
            await runLoopToTerminal(ws, 3, { prompt: "second prompt", ...addressed("prompts-hist", "2") });

            // Defaults to the attached workspace; newest-first.
            const all = await rpcCall(ws, 4, "workspace.prompts", {});
            assert.deepEqual(
                (all.result as { prompts: string[] }).prompts,
                ["second prompt", "first prompt"],
                "newest-first over the attached workspace's user prompts (no archaeology)",
            );

            // limit caps to the newest N.
            const capped = await rpcCall(ws, 5, "workspace.prompts", { limit: 1 });
            assert.deepEqual((capped.result as { prompts: string[] }).prompts, ["second prompt"], "limit caps to the newest N");

            // Malformed limit fails hard — no silent default.
            const bad = await rpcCall(ws, 6, "workspace.prompts", { limit: 0 });
            const problem = rpcProblem(bad);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/limit-invalid");
            assert.equal(problem.value, 0);
            assert.equal(problem.recovery, "Use a positive integer limit."); // {§pinned-wording-core}

            // A malformed workerId fails the same way.
            const badWorker = rpcProblem(await rpcCall(ws, 7, "workspace.prompts", { workerId: 0 }));
            assert.equal(badWorker.type, "https://problems.plurnk.xyz/daemon/input/identifier-invalid");
            assert.equal(badWorker.field, "workerId");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-prompts}: a client prompt at a forked conversation worker is that worker's history, not the crack", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send(), send()] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-fork" });
            const workspaceId = (created.result as { id: number }).id;
            const conversation = await daemon.ensureModelWorker(workspaceId);
            await runLoopToTerminal(ws, 2, { prompt: "default conversation prompt", workerId: conversation, ...addressed("prompts-fork", "1") });

            // The TUI's /worker + /attach flow: a fork of the conversation, bound by name, seeded by a human.
            const research = await daemon.forkWorker({ workspaceId, workerId: conversation, name: "research" });
            await runLoopToTerminal(ws, 3, { prompt: "typed at the research fork", workerId: research.workerId, ...addressed("research", "1") });
            await runLoopToTerminal(ws, 4, { prompt: "typed at the research fork again", workerId: research.workerId, ...addressed("research", "2") });

            const scopedToFork = await rpcCall(ws, 5, "workspace.prompts", { workerId: research.workerId });
            assert.deepEqual(
                (scopedToFork.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork"],
                "the forked conversation's own human prompts are its history, newest-first",
            );
            const scopedToConversation = await rpcCall(ws, 6, "workspace.prompts", { workerId: conversation });
            assert.deepEqual(
                (scopedToConversation.result as { prompts: string[] }).prompts,
                ["default conversation prompt"],
                "the default conversation's history does not carry the fork's prompts",
            );
            const unscoped = await rpcCall(ws, 7, "workspace.prompts", {});
            assert.deepEqual(
                (unscoped.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork", "default conversation prompt"],
                "an omitted workerId lists every model worker's client-addressed seeds",
            );
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-prompts}: a seed nobody addressed — a worker-issued task — is never history", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-authorship" });
            const workspaceId = (created.result as { id: number }).id;
            const conversation = await daemon.ensureModelWorker(workspaceId);
            await runLoopToTerminal(ws, 2, { prompt: "a human asked this", workerId: conversation, ...addressed("prompts-authorship", "1") });
            // A worker-issued seed carries the issuing worker as its source and no message address
            // ({§message-arrival}); the seam admits the same shape.
            const task = await runLoopToTerminal(ws, 3, { prompt: "a worker delegated this", workerId: conversation, source: "worker://exampleWorkerName" });
            const seed = await db.test_loop_seed_message.get<{ address: string | null; source: string | null }>({ loop_id: task.loopId });
            assert.deepEqual(seed, { address: null, source: "worker://exampleWorkerName" }, "the fixture wrote an unaddressed, worker-sourced seed");

            const history = await rpcCall(ws, 4, "workspace.prompts", { workerId: conversation });
            assert.deepEqual((history.result as { prompts: string[] }).prompts, ["a human asked this"], "the delegated task is not in the worker's history");
        } finally { ws.close(); }
    });
});
