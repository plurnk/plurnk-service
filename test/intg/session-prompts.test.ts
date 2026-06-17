// #238 — session.prompts: a session's prior user prompts, newest-first, for a client's
// up/down readline history. One RPC over loops.prompt, replacing the log-archaeology path
// (session.runs → log.read → filter prompt entries → dig tx.body).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

const send = () => makeMockResponse("<<SEND[200]:ok:SEND", 50);

test("session.prompts returns the session's user prompts newest-first, capped by limit (#238)", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "prompts-hist" });
            await rpcCall(ws, 2, "loop.run", { prompt: "first prompt" });
            await rpcCall(ws, 3, "loop.run", { prompt: "second prompt" });

            // Defaults to the attached session; newest-first.
            const all = await rpcCall(ws, 4, "session.prompts", {});
            assert.deepEqual(
                (all.result as { prompts: string[] }).prompts,
                ["second prompt", "first prompt"],
                "newest-first over the attached session's user prompts (no archaeology)",
            );

            // limit caps to the newest N.
            const capped = await rpcCall(ws, 5, "session.prompts", { limit: 1 });
            assert.deepEqual((capped.result as { prompts: string[] }).prompts, ["second prompt"], "limit caps to the newest N");

            // Malformed limit fails hard — no silent default.
            const bad = await rpcCall(ws, 6, "session.prompts", { limit: 0 });
            assert.ok(bad.error, "limit:0 is a JSON-RPC error");
            assert.match(bad.error!.message, /limit must be a positive integer/);
        } finally { ws.close(); }
    });
});
