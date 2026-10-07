import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Problems } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import WorkerOwners from "../../src/core/WorkerOwners.ts";
import ProposalPolicies from "../../src/core/ProposalPolicies.ts";
import RuntimeWorker from "../../src/core/RuntimeWorker.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import DispatchAsPlurnk from "../../src/server/dispatch-as-plurnk.ts";
import Envelope from "../../src/server/envelope.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { editStmt, urlPath } from "./_dsl.ts";
import { schemeManifest } from "./_scheme.ts";

function panel(t: TestContext, values: Record<string, string>): void {
    const prior = Object.keys(values).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, values);
    t.after(() => {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

test("{§runtime-bookkeeping-policy}: reference publication is independent of invalid interactive policy", async (t) => {
    panel(t, {
        PLURNK_SERVICE_PROPOSALS: "invalid",
    });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "bookkeeping-documents");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    await LoopDocs.materialize(engine, db, workspaceId);
    const entries = await db.loop_docs_materialized.all({ workspace_id: workspaceId });
    assert.ok(entries.length > 0, "the real generated reference tree is available");
    const workerId = await RuntimeWorker.ensure(db, workspaceId);
    const loop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: workerId });
    assert.ok(loop);
    assert.deepEqual(await WorkerOwners.read(db, workerId), { address: "_plurnk", tools: [] });
});

test("{§worker-owner-resolution}: administrative loop creation does not read proposal defaults; proposal admission does", async (t) => {
    panel(t, { PLURNK_SERVICE_PROPOSALS: "invalid" });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "client-policy");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await Envelope.ensureClientLoop(db, workerId);
    await Envelope.closeClientLoop(db, loopId, { status: 200 });
    assert.throws(() => ProposalPolicies.disposition([], false), (cause: unknown) => {
        const problem = Problems.fromError(cause);
        assert.equal(problem?.status, 503);
        assert.equal(problem?.key, "PLURNK_SERVICE_PROPOSALS");
        return true;
    });
});

test("{§runtime-bookkeeping-policy}: an unexpected proposal is refused even when ordinary effect policy auto-accepts", async (t) => {
    panel(t, {
        PLURNK_SERVICE_EFFECT_HOST: "auto",
        PLURNK_SERVICE_PROPOSALS: "accept",
    });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "bookkeeping-rejection");
    const workerId = await RuntimeWorker.ensure(db, workspaceId);
    const schemes = new SchemeRegistry();
    let applied = 0;
    schemes.register("proposing-test", {
        manifest: schemeManifest("proposing-test"),
        async editBatch() { return { status: 202, attrs: { effect: "host" } }; },
        async applyResolution() { applied++; return { status: 201 }; },
    });
    const engine = new Engine({ db, schemes });
    await assert.rejects(
        DispatchAsPlurnk.dispatch(engine, db, workspaceId, workerId, [editStmt(urlPath("proposing-test", "/unexpected"), "new effect")]),
        (cause: unknown) => {
            const problem = Problems.fromError(cause);
            assert.ok(problem, String(cause));
            assert.equal(problem.status, 400);
            assert.equal(problem.type, "https://problems.plurnk.xyz/proposal/rejected");
            return true;
        },
    );
    assert.deepEqual(await engine.pendingProposals(workspaceId), []);
    const row = await db.test_get_log_rx_by_worker_op.get<{ rx: string }>({ worker_id: workerId, op: "EDIT" });
    assert.ok(row);
    assert.equal(JSON.parse(row.rx).outcome, "runtime_bookkeeping");
    assert.equal(applied, 0, "the scheme never receives authority to apply its proposal");
});
