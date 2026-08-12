// {§methods-workspace-prompts}: clients read prompt history without log archaeology.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const send = () => makeMockResponse("<|SEND[200]>ok<SEND|>", 50);

test("{§methods-workspace-prompts}: workspace prompts are newest-first and limit-capped", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompts-hist" });
            await runLoopToTerminal(ws, 2, { prompt: "first prompt" });
            await runLoopToTerminal(ws, 3, { prompt: "second prompt" });

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
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/input/limit-invalid");
            assert.equal(problem.value, 0);
            assert.equal(problem.recovery, "Use a positive integer limit.");
        } finally { ws.close(); }
    });
});
