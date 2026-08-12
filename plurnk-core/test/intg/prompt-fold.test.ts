// A prompt is one first-class, owner-keyed log row. It is born OPEN like any
// newly delivered body, while the separate Active User Prompts section retains its
// durable prompt:// entry address.

import test from "node:test";
import { viableWindow } from "./_helpers.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

type LogRow = { op: string; pathname: string; scheme: string; expanded: number; turn_id: number };
const mock = () => new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("<|SEND[200]>done<SEND|>", 50)] });

test("the first-class prompt row and a normal same-turn op are both born open", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompt-fold" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "hello there" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "prompt" && r.scheme === "prompt");
            assert.ok(prompt !== undefined, "the prompt is logged once as a first-class row");
            assert.equal(prompt!.expanded, 1, "new prompt delivery is OPEN");
            const send = rows.find((r) => r.op === "SEND" && r.turn_id === prompt!.turn_id);
            assert.ok(send !== undefined, "the model's own op shares the turn");
            assert.equal(send!.expanded, 1, "a normal op in the same turn stays OPEN");
        } finally { ws.close(); }
    });
});
