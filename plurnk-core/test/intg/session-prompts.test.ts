// #238 — workspace.prompts: a workspace's prior user prompts, newest-first, for a client's
// up/down readline history. One RPC over loops.prompt, replacing the log-archaeology path
// (workspace.workers → log.read → filter prompt entries → dig tx.body).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const send = () => makeMockResponse("<<SEND[200]:ok:SEND", 50);

test("workspace.prompts returns the workspace's user prompts newest-first, capped by limit (#238)", async () => {
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
            assert.ok(bad.error, "limit:0 is a JSON-RPC error");
            assert.match(bad.error!.message, /limit must be a positive integer/);
        } finally { ws.close(); }
    });
});
