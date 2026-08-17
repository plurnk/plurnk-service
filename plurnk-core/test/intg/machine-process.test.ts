// SPEC {§machine-processes} — behavioral ownership at the real operation seam:
// shared workspace entries, worker-owned logs, and fork topology. Dedicated
// membership and worker-entry specimens own the overlay and private-scratch rows.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testDeferredProviderCapacity } from "./_helpers.ts";
import { foldStmt } from "./_dsl.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({
    op: "EDIT", annotation: null, delimiter: "", signal: null, target, lineMarker: marker, body,
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
        // Fold the first row through the real curation event path.
        await engine.dispatch({
            statement: foldStmt(urlPath("log", "/1/1/1")),
            workspaceId, workerId, loopId, turnId, sequence: 3, origin: "model",
        });

        const branchWorkerId = await Fork.fork(db, workerId);

        const shape = (rows: Array<{ op: string; pathname: string; expanded: number }>) => rows.map((r) => `${r.op}:${r.pathname}:${r.expanded}`);
        const parentLog = await db.engine_render_log.all<{ op: string; pathname: string; expanded: number }>({ worker_id: workerId });
        const branchLog = await db.engine_render_log.all<{ op: string; pathname: string; expanded: number }>({ worker_id: branchWorkerId });
        assert.deepEqual(shape(branchLog), shape(parentLog), "the branch's log mirrors the parent's — rows and fold-state");
        assert.ok(branchLog.some((r) => r.expanded === 0), "the row folded on the parent stayed folded in the branch");
        const effectShape = (rows: Array<{ op: string; operation_sequence: number; target_sequence: number; expanded_before: number }>) =>
            rows.map((row) => `${row.op}:${row.operation_sequence}->${row.target_sequence}:${row.expanded_before}`);
        const parentEffects = await db.test_log_curation_effects_by_worker.all<{
            op: string; operation_sequence: number; target_sequence: number; expanded_before: number;
        }>({ worker_id: workerId });
        const branchEffects = await db.test_log_curation_effects_by_worker.all<{
            op: string; operation_sequence: number; target_sequence: number; expanded_before: number;
        }>({ worker_id: branchWorkerId });
        assert.deepEqual(effectShape(branchEffects), effectShape(parentEffects), "the branch retains the exact FOLD event effect with remapped row identities");
        assert.deepEqual(effectShape(branchEffects), ["FOLD:3->1:1"]);
    } finally { db.close(); }
});

test("a fork carries a log row's classifications along with its fold-state", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("worker", "/a.md"), "first"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        // Classify the parent's row directly to isolate the fork-copy behavior.
        const ids = await db.test_log_entries_by_worker.all<{ id: number }>({ worker_id: workerId });
        await db.log_write_tag.run({ log_entry_id: ids[0].id, tag: "projectB" });

        const branchWorkerId = await Fork.fork(db, workerId);

        const branchTags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: branchWorkerId });
        assert.deepEqual(branchTags.map((r) => r.tag), ["projectB"], "the branch inherited the parent's log classification");
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

test("{§machine-processes-fork-cost} — a fork inherits history without copying provider requests", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await db.engine_close_turn.run({
            id: turnId, status: 200, packet: JSON.stringify({ weight: 0, sections: [], attributions: [] }),
            usage_curation_budget: null, finish_reason: null, model: "mock", meta: "{}",
        });
        const modelCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: turnId,
            sequence: 1,
            kind: "emission",
            attributions: "[]",
            model: "mock",
        });
        assert.ok(modelCall !== undefined);
        const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
            model_call_id: modelCall.id,
        });
        assert.ok(attempt !== undefined);
        const request = await db.engine_open_provider_request.get<{ id: number }>({
            model_call_id: modelCall.id,
            sequence: 1,
            provider: "provider:fixture",
            model: "mock",
        });
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(request!.id, {
            provider: "provider:fixture",
            model: "mock",
            outcome: "response",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            cost: {
                kind: "charged",
                amount: { amount: "1000", currency: "USD" },
                source: "machine fixture",
            },
        }));
        await db.engine_observe_model_call_response.run({
            id: modelCall.id,
            response: JSON.stringify({ assistant: { model: "mock" } }),
            failure: null,
            capacity: JSON.stringify(testDeferredProviderCapacity("machine:emission-fixture")),
            finish_reason: null,
            model: "mock",
        });
        await db.engine_classify_turn_attempt_response.run({
            id: attempt.id,
            accepted: 1,
            parse_errors: "[]",
        });
        const bareCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: turnId,
            sequence: 2,
            kind: "bare",
            attributions: "[]",
            model: "mock",
        });
        assert.ok(bareCall !== undefined);
        const bareRequest = await db.engine_open_provider_request.get<{ id: number }>({
            model_call_id: bareCall.id,
            sequence: 1,
            provider: "provider:fixture",
            model: "mock",
        });
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(bareRequest!.id, {
            provider: "provider:fixture",
            model: "mock",
            outcome: "response",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost: {
                kind: "charged",
                amount: { amount: "0", currency: "USD" },
                source: "machine fixture",
            },
        }));
        await db.engine_observe_model_call_response.run({
            id: bareCall.id,
            response: JSON.stringify({ assistant: { content: "Berlin", model: "mock" } }),
            failure: null,
            capacity: JSON.stringify(testDeferredProviderCapacity("machine:bare-fixture")),
            finish_reason: "stop",
            model: "mock",
        });
        await db.engine_insert_log_entry.run({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: 1,
            origin: "model",
            source: null,
            model_call_id: bareCall.id,
            op: "BARE",
            delimiter: "0",
            signal: null,
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            query: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ op: "BARE", body: "What is the capital of Germany?" }),
            mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 200, content: "Berlin", mimetype: "text/plain" }),
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: 1,
            state: "resolved",
            outcome: null,
            attrs: "{}",
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        assert.equal((await engine.loopUsage(loopId)).accounting.costUsd, "1000");
        assert.equal((await db.test_count_provider_requests.get<{ n: number }>())?.n, 2);

        const branchWorkerId = await Fork.fork(db, workerId);

        assert.equal((await db.test_count_provider_requests.get<{ n: number }>())?.n, 2, "forking creates no provider request");
        assert.equal((await engine.loopUsage(loopId)).accounting.costUsd, "1000", "parent evidence is untouched");
        const branchLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: branchWorkerId });
        assert.ok(branchLoop !== undefined);
        const branchUsage = await engine.loopUsage(branchLoop.id);
        assert.equal(branchUsage.accounting.costUsd, "0");
        assert.deepEqual(branchUsage.accounting.requests, [], "copied history carries no physical request evidence");
        const [branchTurn] = await db.test_list_turns_in_loop.all<{ id: number }>({ loop_id: branchLoop.id });
        assert.ok(branchTurn !== undefined);
        assert.deepEqual(
            await db.test_model_calls.all({ turn_id: branchTurn.id }),
            [],
            "copied turns carry no logical model-call or admission identity",
        );
        const branchRows = await db.test_log_entries_by_turn.all<{ op: string | null; model_call_id: number | null }>({
            turn_id: branchTurn.id,
        });
        assert.deepEqual(
            branchRows.map(({ op, model_call_id }) => ({ op, model_call_id })),
            [{ op: "BARE", model_call_id: null }],
            "the BARE result remains conversational history without claiming the source call",
        );
    } finally { db.close(); }
});
