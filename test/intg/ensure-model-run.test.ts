// #371 — ensureModelRun is IDEMPOTENT at the seam: the WS connection's per-session cache used to
// mask an insert-only implementation (26 runs in one e2e session once the seam exposed it). The
// canonical conversation is the session's earliest model-origin ROOT run; forks and spawned
// workers (which inherit origin='model' but carry parent_run_id) never shadow it.
import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";

test("ensureModelRun finds first — repeated calls return ONE conversation run (#371)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "one-conversation" });
            const sessionId = (created.result as { id: number }).id;
            const a = await daemon.ensureModelRun(sessionId);
            const b = await daemon.ensureModelRun(sessionId);
            const c = await daemon.ensureModelRun(sessionId);
            assert.equal(a, b); assert.equal(b, c);
            const runs = await (db.test_runs_by_session as PrepMethod).all<{ id: number; origin: string }>({ session_id: sessionId });
            assert.equal((runs ?? []).filter((r) => r.origin === "model").length, 1, "exactly one model run minted across three ensures");
            // A fork of the conversation never shadows it — ensure still returns the root.
            const fork = await daemon.forkRun({ sessionId, runId: a, name: "branch" });
            assert.notEqual(fork.runId, a);
            assert.equal(await daemon.ensureModelRun(sessionId), a, "the fork (origin-inherited, parented) does not shadow the canonical root");
        } finally { ws.close(); }
    });
});
