// {§capability-policy-cascade} — the workspace layer uses the same selectors
// as every other layer and shapes both operation admission and generated tool
// references. There is no executor-specific policy channel.

import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityPolicy, ExecStatement } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { sendStmt } from "./_dsl.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";

const execStmt = (runtime: string): ExecStatement => ({
    metadata: null,
    op: "EXEC",
    annotation: null,
    delimiter: "",
    signal: runtime,
    target: null,
    lineMarker: null,
    body: "echo hi",
    position: { line: 1, column: 1 },
});

const runWithPolicy = async (capabilities: CapabilityPolicy, runtime: string) => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `workspace-policy-${crypto.randomUUID()}`);
        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities }),
        });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "policy");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await engine.dispatch({
            statement: execStmt(runtime),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
    } finally { await db.close(); }
};

test("{§capability-policy-cascade}: a workspace runtime denial refuses EXEC before executor resolution", async () => {
    const result = await runWithPolicy({ deny: [{ runtime: "sh" }] }, "sh");
    assert.equal(result.status, 403);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
    assert.equal(result.problem?.runtime, "sh");
    assert.equal(result.problem?.policyScope, "workspace");
    assert.equal(result.problem?.retryable, false);
    assert.equal(result.problem?.recovery, undefined);
});

test("{§capability-policy-cascade}: workspace only makes every omitted runtime unavailable", async () => {
    const result = await runWithPolicy({ only: [{ runtime: "jq" }] }, "sh");
    assert.equal(result.status, 403);
    assert.equal(result.problem?.runtime, "sh");
    assert.equal(result.problem?.policyScope, "workspace");
});

test("{§capability-policy-cascade}: one effective workspace policy filters executable references", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `workspace-policy-render-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const before = await engine.referenceEntries(workspaceId, workerId);
        assert.ok(before.some((doc) => doc.pathname === "/_plurnk/plurnk/node.md"));

        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities: { deny: [{ runtime: "node" }] } }),
        });
        const after = await engine.referenceEntries(workspaceId, workerId);
        assert.ok(!after.some((doc) => doc.pathname === "/_plurnk/plurnk/node.md"));
        assert.ok(after.some((doc) => doc.pathname === "/_plurnk/plurnk/sh.md"));

        const loopId = await insertLoop(db, workerId, 1, "policy teaching");
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }],
        });
        const { turnId } = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "inspect the tools" },
            ],
        });
        const stored = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
        assert.ok(stored !== undefined);
        const packet = JSON.parse(stored.packet) as { sections: Array<{ name: string }> };
        assert.equal(packet.sections.some(({ name }) => name === "tools"), false);
    } finally { await db.close(); }
});

test("{§capability-admission}: harness-authored initialization obeys the same loop capability policy", async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `loop-policy-init-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "finish without external capabilities");
        await db.engine_set_loop_policy.run({
            loop_id: loopId,
            policy: JSON.stringify({
                capabilities: {
                    deny: [
                        { operation: "COPY" },
                        { operation: "FIND" },
                        { operation: "READ" },
                    ],
                },
                proposals: "accept",
            }),
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "finish" },
            ],
        });
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_loop.all<{ origin: string; op: string | null }>({ loop_id: loopId });
        const harnessOps = rows.filter(({ origin }) => origin === "_plurnk").map(({ op }) => op);
        assert.equal(harnessOps.includes("PLAN"), true);
        assert.equal(harnessOps.includes("SEND"), true);
        assert.deepEqual(
            harnessOps.filter((op) => op === "COPY" || op === "FIND" || op === "READ"),
            [],
            "the harness neither advertises nor exercises capabilities denied to this loop",
        );
    } finally {
        await db.close();
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});

test("{§capability-admission}: Turn 0 catalogs only capabilities admitted by this loop", async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `loop-policy-catalog-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const loopId = await insertLoop(db, workerId, 2, "inspect the admitted catalog");
        await db.engine_set_loop_policy.run({
            loop_id: loopId,
            policy: JSON.stringify({
                capabilities: { deny: [{ runtime: "node" }] },
                proposals: "accept",
            }),
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [
                { role: "system", content: "definition" },
                { role: "user", content: "finish" },
            ],
        });
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_loop.all<{
            op: string | null;
            pathname: string | null;
            rx: string;
        }>({ loop_id: loopId });
        const survey = rows.find(({ op, pathname }) =>
            op === "FIND" && pathname?.startsWith("/_plurnk/plurnk/") === true);
        assert.ok(survey !== undefined, "the admitted reference catalog remains available");
        const resultBody = JSON.parse(survey.rx) as { content?: string; results?: unknown[] };
        const items = (resultBody.results
            ?? (resultBody.content === undefined ? [] : JSON.parse(resultBody.content) as unknown[])) as Array<Array<{ path: string }>>;
        const paths = items.flat().map(({ path }) => path);
        assert.equal(paths.some((path) => path.endsWith("/node.md")), false, "a denied runtime is not taught");
        assert.equal(paths.some((path) => path.endsWith("/sh.md")), true, "an admitted peer remains taught");
    } finally {
        await db.close();
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});
