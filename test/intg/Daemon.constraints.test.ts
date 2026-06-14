// SPEC §membership constraint-overlay client tooling (F.3). The membership EFFECTS are
// proven in contract-workspace.test.ts; this is the RPC wire round-trip:
// session.constrain / .constraints / .unconstrain, and input validation.

import test from "node:test";
import assert from "node:assert/strict";
import { withDaemon, connect, rpcCall } from "./_rpc.ts";

test("session.constrain / .constraints / .unconstrain round-trip over RPC (SPEC §membership overlay tooling)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "constraint-rpc-test" });

            const added = await rpcCall(ws, 2, "session.constrain", { effect: "hide", glob: "secret/**" });
            assert.deepEqual(added.result, { effect: "hide", glob: "secret/**" }, "constrain echoes the constraint");

            const listed = await rpcCall(ws, 3, "session.constraints", {});
            assert.deepEqual((listed.result as { constraints: unknown[] }).constraints, [{ effect: "hide", glob: "secret/**" }], "constraints lists what was set");

            await rpcCall(ws, 4, "session.unconstrain", { effect: "hide", glob: "secret/**" });
            const after = await rpcCall(ws, 5, "session.constraints", {});
            assert.deepEqual((after.result as { constraints: unknown[] }).constraints, [], "unconstrain (the `drop` verb) deletes the row");

            const bad = await rpcCall(ws, 6, "session.constrain", { effect: "bogus", glob: "x" });
            assert.ok(bad.error, "an invalid effect must surface as a JSON-RPC error, not a silent accept");
        } finally {
            ws.close();
        }
    });
});
