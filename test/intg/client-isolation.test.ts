// #194 / §connection-lifecycle / §machine-processes — the client writes to its own run, end-to-end.
//
// A client `op.*` lands in the connection's CLIENT run; `loop.run` runs the model
// in its OWN run; the packet renders the model's run, so no client-origin row ever
// reaches the model's conversation — invisibility by run, no origin filter. This
// proves the server wiring (op.* → client run, loop.run → model run) that the
// engine-level §actor-boundary-isolation guarantee rests on.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

test("a client op.* never enters the model's packet — the client writes to its own run (#194)", async () => {
    // The model just terminates; we only care where the client op landed.
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "client-isolation" });
            // A client op — lands in the connection's client run.
            await rpcCall(ws, 2, "op.edit", { target: "known://secret", content: "client-only" });
            // The model runs — in its OWN run.
            const run = await rpcCall(ws, 3, "loop.run", { prompt: "go" });
            const loopId = (run.result as { loopId: number }).loopId;

            const modelRun = await (db.test_get_run_id_by_loop as PrepMethod).get<{ run_id: number }>({ loop_id: loopId });
            assert.ok(modelRun !== undefined, "the model loop has a run");

            // The model's packet is rendered from the model's run alone.
            const modelLog = await (db.engine_render_log as PrepMethod).all<{ origin: string; pathname: string }>({ run_id: modelRun!.run_id });
            assert.ok(modelLog.length > 0, "the model's packet carries its own log");
            assert.ok(
                modelLog.every((r) => r.origin !== "client"),
                "no client-origin op reaches the model's packet — the client wrote to its own run, not the model's",
            );

            // And the client still sees its own op: log.read reads the connection's
            // (client) run, where the op.edit lives.
            const own = await rpcCall(ws, 4, "log.read");
            const entries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(entries.some((e) => e.op === "EDIT" && e.origin === "client"), "the client reads its own op from its own run");
        } finally { ws.close(); }
    });
});
