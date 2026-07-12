// #360 — the per-turn world model is synchronized: a write is visible to reads in the SAME
// turn (ops dispatch sequentially against live state, never a turn-start snapshot). Pinned
// after a requiem confabulated a desync (run39): the model stitched the turn-1 init-foist
// FIND (items:0, correct — pre-write) to its later EDIT[201] and testified they were one turn.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("same-turn visibility: an EDIT-created known entry is FINDable in the SAME turn (#360)", async () => {
    const mock = new Mock({ contextSize: 16384, responses: [
        // Turn 1: write, then read-back in the same turn; SEND[102] (a same-turn SEND[200] would
        // — correctly — trip the weigh-before-conclude 409; that gate is not under test here).
        makeMockResponse("<<PLAN:write then find:PLAN\n<<EDIT[abs](known:///abs/module-loader-spec.md):the spec body:EDIT\n<<FIND(known:///**)::FIND\n<<SEND[102]:wrote and listed:SEND", 10),
        makeMockResponse("<<SEND[200]:done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "probe360" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { yolo: true } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; origin: string; rx: string }>({ loop_id: 2 });
            const modelFind = (rows ?? []).filter((r) => r.op === "FIND" && r.origin === "model");
            assert.ok(modelFind.length >= 1, "the model's FIND dispatched");
            const rx = JSON.parse(modelFind[0].rx ?? "{}") as { content?: string };
            assert.match(rx.content ?? "", /module-loader-spec/,
                "the just-EDITed entry is visible to the SAME-turn FIND — writes land before subsequent ops read");
        } finally { ws.close(); }
    });
});
