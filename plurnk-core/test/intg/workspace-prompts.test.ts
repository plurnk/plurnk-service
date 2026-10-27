// {§methods-workspace-create}: clients read prompt history without log archaeology; history is
// what a client addressed to a session, scoped like log.read (#894).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";

const send = () => makeMockResponse("````SEND [200]\nok\n````", 50);
const addressed = (thread: string, id: string) => {
    const address = `acp://operator/threads/${thread}/messages/${id}`;
    return { source: address, messageAddress: address };
};

test("{§methods-workspace-create}: workspace prompts are newest-first and limit-capped", async () => {
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

            // A malformed sessionId fails the same way.
            const badSession = rpcProblem(await rpcCall(ws, 7, "workspace.prompts", { sessionId: 0 }));
            assert.equal(badSession.type, "https://problems.plurnk.xyz/daemon/input/identifier-invalid");
            assert.equal(badSession.field, "sessionId");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a client prompt at a forked model session is that session's history, not the crack", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send(), send()] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-fork" });
            const workspaceId = (created.result as { id: number }).id;
            const mainSession = await namedModelSession(daemon, workspaceId, "main");
            await runLoopToTerminal(ws, 2, { prompt: "typed at main", sessionId: mainSession, ...addressed("main", "1") });

            // The TUI's /session + /attach flow: a fork of the thread's session, bound by name, seeded by a human.
            const research = await daemon.forkSession({ workspaceId, sessionId: mainSession, name: "research" });
            await runLoopToTerminal(ws, 3, { prompt: "typed at the research fork", sessionId: research.sessionId, ...addressed("research", "1") });
            await runLoopToTerminal(ws, 4, { prompt: "typed at the research fork again", sessionId: research.sessionId, ...addressed("research", "2") });

            const scopedToFork = await rpcCall(ws, 5, "workspace.prompts", { sessionId: research.sessionId });
            assert.deepEqual(
                (scopedToFork.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork"],
                "the forked session's own human prompts are its history, newest-first",
            );
            const scopedToMain = await rpcCall(ws, 6, "workspace.prompts", { sessionId: mainSession });
            assert.deepEqual(
                (scopedToMain.result as { prompts: string[] }).prompts,
                ["typed at main"],
                "the forked session's parent keeps its own history, without the fork's prompts",
            );
            const unscoped = await rpcCall(ws, 7, "workspace.prompts", {});
            assert.deepEqual(
                (unscoped.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork", "typed at main"],
                "an omitted sessionId lists every model session's client-addressed seeds",
            );
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a seed nobody addressed — a session-issued task — is never history", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-authorship" });
            const workspaceId = (created.result as { id: number }).id;
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            await runLoopToTerminal(ws, 2, { prompt: "a human asked this", sessionId, ...addressed("main", "1") });
            // A session-issued seed carries the issuing session as its source and no message address
            // ({§message-arrival}); the seam admits the same shape.
            const task = await runLoopToTerminal(ws, 3, { prompt: "a session delegated this", sessionId, source: "session://exampleSessionName" });
            const seed = await db.test_loop_seed_message.get<{ address: string | null; source: string | null }>({ loop_id: task.loopId });
            assert.deepEqual(seed, { address: null, source: "session://exampleSessionName" }, "the fixture wrote an unaddressed, session-sourced seed");

            const history = await rpcCall(ws, 4, "workspace.prompts", { sessionId });
            assert.deepEqual((history.result as { prompts: string[] }).prompts, ["a human asked this"], "the delegated task is not in the session's history");
        } finally { ws.close(); }
    });
});
