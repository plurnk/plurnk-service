// {§operator-config-workspace-execs} — one subtractive workspace layer governs
// dispatch, capability advertising, and executor document materialization.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { sendStmt } from "./_dsl.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, packetSection, testExecutors } from "./_helpers.ts";

const execStmt = (runtime: string): ExecStatement => ({ op: "EXEC", suffix: "", signal: runtime, target: null, lineMarker: null, body: "echo hi", position: { line: 1, column: 1 } });

const runDisabled = async (execsPolicy: Record<string, string>, runtime: string) => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `sp-${crypto.randomUUID()}`);
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ execs: execsPolicy }) });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "policy");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await engine.dispatch({ statement: execStmt(runtime), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
    } finally { await db.close(); }
};

test("{§operator-config-workspace-execs} per-tag disable refuses EXEC before executor resolution", async () => {
    const r = await runDisabled({ PLURNK_EXECS_SH: "0" }, "sh");
    assert.equal(r.status, 501, "sh is disabled for this workspace by client policy");
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/exec/runtime-disabled");
    assert.equal(r.problem?.requestedRuntime, "sh");
    assert.equal(r.problem?.retryable, false);
    assert.match(r.problem?.recovery as string, /enabled executable tool/);
});

test("{§operator-config-workspace-execs} case-insensitive ONLY makes omitted tags absent", async () => {
    const r = await runDisabled({ PLURNK_EXECS_ONLY: "jq" }, "sh");
    assert.equal(r.status, 501, "sh is not in the allowlist → absent");
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/scheme/exec/runtime-disabled");
    assert.equal(r.problem?.requestedRuntime, "sh");
    assert.deepEqual(r.problem?.availableRuntimes, ["jq"]);
    assert.equal(r.problem?.retryable, false);
});

test("{§operator-config-workspace-execs} one effective set filters packet teaching and executor docs", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `sp-render-${crypto.randomUUID()}`);
        // Baseline: node's doc is present with no workspace policy.
        const before = await engine.docEntries(workspaceId);
        assert.ok(before.some((d) => d.name === "node"), "baseline: node's reference doc renders");
        // Disable node for the workspace → its doc drops.
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ execs: { PLURNK_EXECS_NODE: "0" } }) });
        const after = await engine.docEntries(workspaceId);
        assert.ok(!after.some((d) => d.name === "node"), "node disabled by workspace policy → no doc materialized");
        assert.ok(after.some((d) => d.name === "sh"), "other tags' docs survive the filter");

        const workerId = await insertWorker(db, workspaceId);
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
        const tools = packetSection(JSON.parse(stored.packet) as unknown, "tools");
        assert.doesNotMatch(tools, /## EXEC0 \[node\]/, "node disabled by workspace policy → no capability example");
        assert.match(tools, /## EXEC0(?:\n| )/, "an enabled shell example remains advertised");
    } finally { await db.close(); }
});
