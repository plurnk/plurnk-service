// §send-undelivered-child-term — the 1ms fan-out race (the recurring "heavy-topo variance",
// root-caused): workers concluding DURING the parent's generation are no longer live (the wait's
// J leg misses them) but their collect deltas are queued for the NEXT packet. An empty-join
// conclusion here would discard the delivered results;
// a [200] in the same window discards them identically. Both gates now treat a child terminated
// after the current turn's timestamp as PENDING: the wait continues (R semantics), the [200]
// refuses with the steer.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

async function raceScenario(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `race-${crypto.randomUUID()}`);
    const parent = await insertWorker(db, workspaceId);
    const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
    const parentTurn = await insertTurn(db, parentLoop, 1, 102);
    // a child spawned by the parent, whose loop TERMINATED AFTER the parent's turn opened —
    // the exact race window (terminated_at strictly greater than the turn's timestamp).
    const child = await insertWorker(db, workspaceId, parent, "worker-x");
    const childLoop = await insertLoop(db, child, 1, "fetch the value");
    await (db.test_terminate_loop_after_turn as PrepMethod).run({ loop_id: childLoop, turn_id: parentTurn });
    // the terminated_at trigger re-stamps 'now' on the status transition — the second update
    // (terminated_at only, no trigger) makes the fixture's +2s deterministic.
    await (db.test_stamp_terminated_after_turn as PrepMethod).run({ loop_id: childLoop, turn_id: parentTurn });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { workspaceId, parent, parentLoop, parentTurn, engine };
}

test("a bare SEND[202] over a just-concluded child continues until the result is delivered", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.dispatch({ statement: sendStmt(202, null, "Waiting for worker-x."), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102, "the wait is NOT on nothing — the child's deliverable is on the doorstep; continue");
        const loop = await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: parentLoop });
        assert.notEqual(loop?.status, 200, "the loop did not conclude over the undelivered result");
    } finally { await db.close(); }
});

test("a SEND[200] over a just-concluded child is refused with the steer", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.dispatch({ statement: sendStmt(200, null, "done"), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 409, "concluding over an undelivered worker result is refused");
        assert.match(String(r.error), /worker results that arrived during this turn/, "the steer names the pending kind");
    } finally { await db.close(); }
});
