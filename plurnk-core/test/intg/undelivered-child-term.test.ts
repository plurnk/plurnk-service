// {§send-undelivered-child-term}: workers concluding DURING the parent's generation are no
// longer live, but their ambient event is newer than the parent's observation cursor and queued
// for the NEXT packet. Both dispositions must preserve that completed-but-unobserved result.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

async function raceScenario(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `race-${crypto.randomUUID()}`);
    const parent = await insertWorker(db, workspaceId);
    const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
    const parentTurn = await insertTurn(db, parentLoop, 1, 102);
    // A child spawned by the parent concludes after the parent's turn opened.
    const child = await insertWorker(db, workspaceId, parent, "worker-x");
    const childLoop = await insertLoop(db, child, 1, "fetch the value");
    await insertTurn(db, childLoop, 1, 102);
    await new LoopLifecycle(db).finish(childLoop, {
        status: 200,
        content: "the value is 42",
        mimetype: "text/markdown",
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { workspaceId, parent, parentLoop, parentTurn, engine };
}

test("a bare SEND[202] over a just-concluded child continues until the result is delivered", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.dispatch({ statement: sendStmt(202, null, "Waiting for worker-x."), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102, "the wait is NOT on nothing — the child's deliverable is on the doorstep; continue");
        const loop = await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop });
        assert.notEqual(loop?.status, 200, "the loop did not conclude over the undelivered result");
    } finally { await db.close(); }
});

test("a SEND[200] over a just-concluded child is refused with the steer", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.dispatch({ statement: sendStmt(200, null, "done"), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 409, "concluding over an undelivered worker result is refused");
        assert.match(r.problem?.detail ?? "", /worker results that arrived during this turn/, "the steer names the pending kind");
    } finally { await db.close(); }
});
