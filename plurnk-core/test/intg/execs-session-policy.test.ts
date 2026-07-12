// #328 — the per-session client execs layer: a session whose client policy disables a runtime tag
// (per-tag kill OR an ONLY allowlist that omits it) has that tag ABSENT — refused at EXEC dispatch,
// subtractive over the boot registry. The no-op case (no session policy) is covered by every other
// EXEC test running with settings='{}' and NOT being policy-refused.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { ExecStatement } from "@plurnk/plurnk-grammar";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";

const execStmt = (runtime: string): ExecStatement => ({ op: "EXEC", suffix: "", signal: runtime, target: null, lineMarker: null, body: "echo hi", position: { line: 1, column: 1 } });

const runDisabled = async (execsPolicy: Record<string, string>, runtime: string) => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const sessionId = await insertSession(db, `sp-${crypto.randomUUID()}`);
        await (db.test_set_session_settings as PrepMethod).run({ id: sessionId, settings: JSON.stringify({ execs: execsPolicy }) });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "policy");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await engine.dispatch({ statement: execStmt(runtime), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
    } finally { await db.close(); }
};

test("#328 per-tag kill: a session disabling sh refuses EXEC[sh] as absent (before executor resolution)", async () => {
    const r = await runDisabled({ PLURNK_EXECS_SH: "0" }, "sh");
    assert.equal(r.status, 501, "sh is disabled for this session by client policy");
    assert.match(String(r.error ?? ""), /disabled for this session by client policy/);
});

test("#328 allowlist (case-insensitive key): ONLY=jq makes sh absent for the session", async () => {
    const r = await runDisabled({ PLURNK_EXECS_ONLY: "jq" }, "sh");
    assert.equal(r.status, 501, "sh is not in the allowlist → absent");
    assert.match(String(r.error ?? ""), /disabled for this session by client policy/);
});

test("#328 render filter: a session-disabled tag is absent from docEntries — never taught-then-refused", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        engine.setExecutors(await testExecutors());
        const sessionId = await insertSession(db, `sp-render-${crypto.randomUUID()}`);
        // Baseline: node's doc is present with no session policy.
        const before = await engine.docEntries(sessionId);
        assert.ok(before.some((d) => d.name === "node"), "baseline: node's reference doc renders");
        // Disable node for the session → its doc drops.
        await (db.test_set_session_settings as PrepMethod).run({ id: sessionId, settings: JSON.stringify({ execs: { PLURNK_EXECS_NODE: "0" } }) });
        const after = await engine.docEntries(sessionId);
        assert.ok(!after.some((d) => d.name === "node"), "node disabled by session policy → no doc materialized");
        assert.ok(after.some((d) => d.name === "sh"), "other tags' docs survive the filter");
    } finally { await db.close(); }
});
