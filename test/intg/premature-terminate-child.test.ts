// §send-premature-terminate extended to CHILD RUNS — a SEND[200] while a spawned child is still
// live is premature exactly as a SEND[200] with an open stream is (children and streams are the same
// kind of "live thing the run holds", §run-lifecycle). Engine-level A/B so it's race-free.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

test("[§send-premature-terminate] SEND[200] with a live CHILD run downgrades to 102 + steers", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `prem-child-${crypto.randomUUID()}`);
        const parentRun = await insertRun(db, sessionId);
        const parentLoop = await insertLoop(db, parentRun, 1, "parent");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const send200 = () => engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] }),
            sessionId, runId: parentRun, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        // Baseline: no child → SEND[200] is a clean terminal.
        const clean = await send200();
        assert.equal(clean.status, 200, "with no live child, SEND[200] terminates cleanly");
        assert.equal(clean.steerStruck, false);

        // Spawn a live child run (parent_run_id = parentRun, a non-terminal loop — default status 102).
        const childRun = await insertRun(db, sessionId, parentRun);
        await insertLoop(db, childRun, 1, "child");

        // Now SEND[200] is premature — the child is still a live thing the run holds.
        const premature = await send200();
        assert.equal(premature.status, 102, "with a live child, SEND[200] downgrades to 102 (premature-terminate)");
        assert.equal(premature.steerStruck, true, "and the premature-terminate steer fired");
    } finally { await db.close(); }
});
