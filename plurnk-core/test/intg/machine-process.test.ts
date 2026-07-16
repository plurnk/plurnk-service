// SPEC §machine-processes — the machine and its processes (workspace = world, run = log, fork).
//
// These prove the ownership line through BEHAVIOR on the real op surface — never
// by reflecting the schema catalog (no sqlite_master, no PRAGMA: that reaches
// around SqlRite and tests shape instead of conduct). One invariant is true today
// and asserted for real; the rest are deferred-red conformance targets for the epic
// this section defines. {§machine-processes-run-is-its-log} is now GREEN — worker_watermarks is
// gone, and the proof (a run learns a sibling's edit purely through its pulled log, no
// shadow) lives in Engine.env-delta.test.ts where the runTurn harness exercises the pull.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("[§machine-processes-one-filesystem] the entries are the workspace's — a second run writing the same path updates the one shared entry, it does not mint a second", async () => {
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
        const target = urlPath("known", "/shared.md");
        const ra = await engine.dispatch({ statement: editStmt(target, "from run A"), workspaceId, workerId: a.workerId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        const rb = await engine.dispatch({ statement: editStmt(target, "from run B"), workspaceId, workerId: b.workerId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // A creates the entry (201) in the workspace's one filesystem; B, a different
        // run at the same (scope, scheme, pathname), UPDATES that one entry (200).
        // A per-run filesystem would have minted a second entry and 201'd again.
        assert.equal(ra.status, 201, "run A creates the entry in the workspace's filesystem");
        assert.equal(rb.status, 200, "run B writing the SAME path updates the one shared entry — the filesystem is the workspace's, not the run's");
    } finally { db.close(); }
});

// [§machine-processes-one-overlay] is a REAL test now in contract-workspace.test.ts (two runs on one
// workspace resolve the IDENTICAL git-member overlay — membership is workspace-keyed, no worker_id). It lives
// there for the git-fixture deps (withGitWorkspace); the stub here is retired.

test("[§machine-processes-fork-copies-the-log] a fork copies the parent's log (rows + their fold-state)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("known", "/a.md"), "first"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt(urlPath("known", "/b.md"), "second"), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        // Fold the first row — a fold-state bit on the parent's own log.
        const ids = await (db.test_log_entries_by_run as PrepMethod).all<{ id: number }>({ worker_id: workerId });
        await (db.log_set_expanded_by_id as PrepMethod).run({ id: ids[0].id, expanded: 0 });

        const branchWorkerId = await Fork.fork(db, workerId);

        const shape = (rows: Array<{ op: string; pathname: string; expanded: number }>) => rows.map((r) => `${r.op}:${r.pathname}:${r.expanded}`);
        const parentLog = await (db.engine_render_log as PrepMethod).all<{ op: string; pathname: string; expanded: number }>({ worker_id: workerId });
        const branchLog = await (db.engine_render_log as PrepMethod).all<{ op: string; pathname: string; expanded: number }>({ worker_id: branchWorkerId });
        assert.deepEqual(shape(branchLog), shape(parentLog), "the branch's log mirrors the parent's — rows and fold-state");
        assert.ok(branchLog.some((r) => r.expanded === 0), "the row folded on the parent stayed folded in the branch");
    } finally { db.close(); }
});

test("[§log-region-tagging] a fork carries a log row's region tags along with its fold-state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("known", "/a.md"), "first"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        // Tag the parent's row (the write FOLD[tag] performs), directly — to isolate the fork-copy.
        const ids = await (db.test_log_entries_by_run as PrepMethod).all<{ id: number }>({ worker_id: workerId });
        await (db.log_write_tag as PrepMethod).run({ log_entry_id: ids[0].id, tag: "projectB" });

        const branchWorkerId = await Fork.fork(db, workerId);

        const branchTags = await (db.test_log_tags_by_run as PrepMethod).all<{ coordinate: string; tag: string }>({ worker_id: branchWorkerId });
        assert.deepEqual(branchTags.map((r) => r.tag), ["projectB"], "the branch inherited the parent's region tag — a named working-set survives the fork");
    } finally { db.close(); }
});

test("[§machine-processes-fork-shares-the-world] a fork shares the workspace's filesystem and overlay, live and uncopied", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("known", "/shared.md"), "x"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        const before = (await (db.engine_list_workspace_entries as PrepMethod).all<{ entry_id: number }>({ workspace_id: workspaceId })).length;

        const branchWorkerId = await Fork.fork(db, workerId);

        const after = (await (db.engine_list_workspace_entries as PrepMethod).all<{ entry_id: number }>({ workspace_id: workspaceId })).length;
        const branch = await (db.test_run_lineage as PrepMethod).get<{ workspace_id: number }>({ id: branchWorkerId });
        assert.equal(branch!.workspace_id, workspaceId, "the branch lives in the parent's workspace — one shared world");
        assert.equal(after, before, "the fork copied no entries — the filesystem is shared, not duplicated");
    } finally { db.close(); }
});

test("[§machine-processes-no-fork-workspace] a workspace cannot be forked; the fork is run-scoped", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const branchWorkerId = await Fork.fork(db, workerId);
        assert.notEqual(branchWorkerId, workerId, "a fork is a new run");
        const lineage = await (db.test_run_lineage as PrepMethod).get<{ workspace_id: number; parent_worker_id: number | null }>({ id: branchWorkerId });
        assert.equal(lineage!.workspace_id, workspaceId, "the branch is in the parent's workspace — the workspace is shared, never forked");
        assert.equal(lineage!.parent_worker_id, workerId, "the branch's lineage points at the parent run");
    } finally { db.close(); }
});

test("#254 — a fork inherits the log but spends no new money: workspace cost is not double-counted, the branch starts at 0", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        // Give the parent turn a real cost — the rollup triggers carry it to run + workspace.
        await (db.engine_close_turn as PrepMethod).run({
            id: turnId, status: 200, packet: "{}",
            usage_prompt: 100, usage_completion: 50, usage_reasoning: 0, usage_cached: 0, usage_cost_pico: 1000,
            finish_reason: null, model: "mock", meta: "{}",
        });
        const workspaceCost = async () =>
            (await (db.envelope_list_workspaces as PrepMethod).all<{ id: number; cost_pico: number }>({})).find((s) => s.id === workspaceId)?.cost_pico;
        const workerCost = async (rid: number) =>
            (await (db.envelope_list_workers_for_workspace as PrepMethod).all<{ id: number; cost_pico: number }>({ workspace_id: workspaceId })).find((r) => r.id === rid)?.cost_pico;

        assert.equal(await workspaceCost(), 1000, "baseline: the parent turn's cost rolled up to the workspace");
        assert.equal(await workerCost(workerId), 1000, "baseline: and to the parent run");

        const branchWorkerId = await Fork.fork(db, workerId);

        // The fork copied the log (history) but charged nothing — no new generation happened.
        assert.equal(await workspaceCost(), 1000, "workspace cost is NOT double-counted by the fork — true lifetime spend");
        assert.equal(await workerCost(branchWorkerId), 0, "the branch's cost_pico starts at 0 — it accrues only what IT generates");
        assert.equal(await workerCost(workerId), 1000, "the parent run's cost is untouched");
    } finally { db.close(); }
});
