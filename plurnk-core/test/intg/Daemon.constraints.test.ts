// SPEC §membership constraint-overlay client tooling (F.3). The membership EFFECTS are
// proven in contract-workspace.test.ts; this is the RPC wire round-trip:
// workspace.constrain / .constraints / .unconstrain, and input validation.

import test from "node:test";
import assert from "node:assert/strict";
import { withDaemon, connect, rpcCall } from "./_rpc.ts";

test("workspace.constrain / .constraints / .unconstrain round-trip over RPC (SPEC overlay tooling)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "constraint-rpc-test" });

            const added = await rpcCall(ws, 2, "workspace.constrain", { effect: "hide", glob: "secret/**" });
            assert.deepEqual(added.result, { effect: "hide", glob: "secret/**" }, "constrain echoes the constraint");

            const listed = await rpcCall(ws, 3, "workspace.constraints", {});
            assert.deepEqual((listed.result as { constraints: unknown[] }).constraints, [{ effect: "hide", glob: "secret/**" }], "constraints lists what was set");

            await rpcCall(ws, 4, "workspace.unconstrain", { effect: "hide", glob: "secret/**" });
            const after = await rpcCall(ws, 5, "workspace.constraints", {});
            assert.deepEqual((after.result as { constraints: unknown[] }).constraints, [], "unconstrain (the `drop` verb) deletes the row");

            const bad = await rpcCall(ws, 6, "workspace.constrain", { effect: "bogus", glob: "x" });
            assert.ok(bad.error, "an invalid effect must surface as a JSON-RPC error, not a silent accept");
        } finally {
            ws.close();
        }
    });
});

test("workspace.create({constraints}) seeds the overlay atomically — listed with no follow-up RPC (#200)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", {
                name: "constraint-seed-test",
                constraints: [{ effect: "pick", glob: "docs/**" }, { effect: "view", glob: "vendor/**" }],
            });
            // Present from the start — no workspace.constrain round-trip needed.
            const listed = await rpcCall(ws, 2, "workspace.constraints", {});
            const got = (listed.result as { constraints: Array<{ effect: string; glob: string }> }).constraints;
            assert.equal(got.length, 2, "both seeded constraints are present");
            assert.deepEqual(
                got.toSorted((a, b) => a.glob.localeCompare(b.glob)),
                [{ effect: "pick", glob: "docs/**" }, { effect: "view", glob: "vendor/**" }],
                "workspace.create's constraints land atomically with the workspace",
            );
        } finally { ws.close(); }
    });
});

test("workspace.create rejects a malformed seeded constraint (#200)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const bad = await rpcCall(ws, 1, "workspace.create", { name: "bad-seed", constraints: [{ effect: "bogus", glob: "x" }] });
            assert.ok(bad.error, "an invalid seeded constraint surfaces as a JSON-RPC error, not a silent accept");
            assert.match(bad.error!.message, /pick \| hide \| view/);
        } finally { ws.close(); }
    });
});
