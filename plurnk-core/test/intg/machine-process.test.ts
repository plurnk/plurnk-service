// SPEC {§machine-processes} — behavioral ownership at the real operation seam:
// shared workspace entries, worker-owned logs, and fork topology. Dedicated
// membership and worker-entry specimens own the overlay and private-scratch rows.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});

test("a workspace-commons entry is shared — a second worker updates it rather than minting another", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { workerId, loopId, turnId };
        };
        const a = await spawn();
        const b = await spawn();
        const target = urlPath("worker", "/shared.md");
        const resultA = await engine.dispatch({ statement: editStmt(target, "from worker A"), workspaceId, workerId: a.workerId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        const resultB = await engine.dispatch({ statement: editStmt(target, "from worker B", fullReplace), workspaceId, workerId: b.workerId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // A creates one commons entry (201); B addresses the same commons identity
        // and updates it (200). Private worker entries use an owner authority and
        // are deliberately a different contract.
        assert.equal(resultA.status, 201, "worker A creates the workspace-commons entry");
        assert.equal(resultB.status, 200, "worker B updates the same shared entry instead of minting another");
    } finally { db.close(); }
});

// {§machine-processes-one-overlay} is a REAL test now in contract-workspace.test.ts (two workers on one
// workspace resolve the IDENTICAL git-member overlay — membership is workspace-keyed, no worker_id). It lives
// there for the git-fixture deps (withGitWorkspace); the stub here is retired.

test("a fork copies the parent's log (rows + their fold-state)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/a.md"), "first"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/b.md"), "second"), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        // Fold the first row — a fold-state bit on the parent's own log.
        const ids = await db.test_log_entries_by_worker.all<{ id: number }>({ worker_id: workerId });
        await db.log_set_expanded_by_id.run({ id: ids[0].id, expanded: 0 });

        const branchWorkerId = await Fork.fork(db, workerId);

        const shape = (rows: Array<{ op: string; pathname: string; expanded: number }>) => rows.map((r) => `${r.op}:${r.pathname}:${r.expanded}`);
        const parentLog = await db.engine_render_log.all<{ op: string; pathname: string; expanded: number }>({ worker_id: workerId });
        const branchLog = await db.engine_render_log.all<{ op: string; pathname: string; expanded: number }>({ worker_id: branchWorkerId });
        assert.deepEqual(shape(branchLog), shape(parentLog), "the branch's log mirrors the parent's — rows and fold-state");
        assert.ok(branchLog.some((r) => r.expanded === 0), "the row folded on the parent stayed folded in the branch");
    } finally { db.close(); }
});

test("a fork carries a log row's region tags along with its fold-state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/a.md"), "first"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        // Tag the parent's row (the write FOLD[tag] performs), directly — to isolate the fork-copy.
        const ids = await db.test_log_entries_by_worker.all<{ id: number }>({ worker_id: workerId });
        await db.log_write_tag.run({ log_entry_id: ids[0].id, tag: "projectB" });

        const branchWorkerId = await Fork.fork(db, workerId);

        const branchTags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: branchWorkerId });
        assert.deepEqual(branchTags.map((r) => r.tag), ["projectB"], "the branch inherited the parent's region tag — a named working-set survives the fork");
    } finally { db.close(); }
});

test("a fork shares workspace-commons entries live and uncopied", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/shared.md"), "x"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        const before = (await db.engine_list_workspace_entries.all<{ entry_id: number }>({ workspace_id: workspaceId })).length;

        const branchWorkerId = await Fork.fork(db, workerId);

        const after = (await db.engine_list_workspace_entries.all<{ entry_id: number }>({ workspace_id: workspaceId })).length;
        const branch = await db.test_worker_lineage.get<{ workspace_id: number }>({ id: branchWorkerId });
        assert.equal(branch!.workspace_id, workspaceId, "the branch lives in the parent's workspace");
        assert.equal(after, before, "the fork did not duplicate the workspace-commons entry");
    } finally { db.close(); }
});

test("a fork creates a worker while retaining the shared workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const branchWorkerId = await Fork.fork(db, workerId);
        assert.notEqual(branchWorkerId, workerId, "a fork is a new worker");
        const lineage = await db.test_worker_lineage.get<{ workspace_id: number; parent_worker_id: number | null }>({ id: branchWorkerId });
        assert.equal(lineage!.workspace_id, workspaceId, "the branch is in the parent's workspace — the workspace is shared, never forked");
        assert.equal(lineage!.parent_worker_id, workerId, "the branch's lineage points at the parent worker");
    } finally { db.close(); }
});

test("{§machine-processes-fork-cost} — a fork inherits the log but spends no new money: workspace cost is not double-counted, the branch starts at 0", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        // Give the parent turn a real cost — the rollup triggers carry it to worker + workspace.
        await db.engine_close_turn.run({
            id: turnId, status: 200, packet: JSON.stringify({ tokens: 0, sections: [], attributions: [] }),
            finish_reason: null, model: "mock", meta: "{}",
        });
        const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
            turn_id: turnId,
            sequence: 1,
            attributions: "[]",
            model: "mock",
        });
        assert.ok(attempt !== undefined);
        await db.engine_observe_turn_attempt_response.run({
            id: attempt.id,
            response: JSON.stringify({ assistant: { model: "mock" } }),
            usage_prompt: 100,
            usage_completion: 50,
            usage_reasoning: 0,
            usage_cached: 0,
            usage_cost: JSON.stringify({ kind: "unknown", reason: "awaiting classification" }),
            finish_reason: null,
            model: "mock",
        });
        await db.engine_classify_turn_attempt_response.run({
            id: attempt.id,
            accepted: 1,
            parse_errors: "[]",
            failure: null,
            usage_cost: JSON.stringify({
                kind: "authoritative",
                amount: { amount: "1000", currency: "USD" },
                usdEquivalent: "1000",
                source: "machine fixture",
            }),
            usage_cost_usd: 1000,
        });
        const workspaceCost = async () =>
            (await db.envelope_list_workspaces.all<{ id: number; cost_usd: number }>({})).find((s) => s.id === workspaceId)?.cost_usd;
        const workerCost = async (rid: number) =>
            (await db.envelope_list_workers_for_workspace.all<{ id: number; cost_usd: number }>({ workspace_id: workspaceId })).find((r) => r.id === rid)?.cost_usd;

        assert.equal(await workspaceCost(), 1000, "baseline: the parent turn's cost rolled up to the workspace");
        assert.equal(await workerCost(workerId), 1000, "baseline: and to the parent worker");

        const branchWorkerId = await Fork.fork(db, workerId);

        // The fork copied the log (history) but charged nothing — no new generation happened.
        assert.equal(await workspaceCost(), 1000, "workspace cost is NOT double-counted by the fork — true lifetime spend");
        assert.equal(await workerCost(branchWorkerId), 0, "the branch's cost_usd starts at 0 — it accrues only what IT generates");
        assert.equal(await workerCost(workerId), 1000, "the parent worker's cost is untouched");
        const branchLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: branchWorkerId });
        assert.ok(branchLoop !== undefined);
        const branchUsage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(branchLoop.id);
        assert.equal(branchUsage.costUsd, 0);
        assert.equal(branchUsage.projectedCostUsd, 0);
        assert.deepEqual(branchUsage.costs, [], "copied history carries no provider-call monetary evidence");
    } finally { db.close(); }
});
