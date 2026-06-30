// §send-premature-terminate extended to CHILD RUNS — a SEND[200] while a spawned child is still
// live is premature exactly as a SEND[200] with an open stream is (children and streams are the same
// kind of "live thing the run holds", §run-lifecycle). Engine-level A/B so it's race-free.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { sendStmt } from "./_dsl.ts";

test("[§send-premature-terminate] SEND[200] with a live CHILD run is refused 409 on the record (no erasure) + steers", async () => {
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
        assert.equal(premature.status, 102, "the TURN stays a continue (102) — the loop never went terminal");
        assert.equal(premature.steerStruck, true, "and the premature-terminate steer fired");

        // The record is faithful, NOT erased: the SEND row keeps its [200] emission but is stamped 409
        // (refused — Conflict), auto-surfacing in the errors section (status≥400). The old downgrade
        // rewrote the row to 102, erasing what the model did.
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ status_rx: number; op: string }>({ turn_id: premature.turnId });
        const sendRow = rows.find((r) => r.op === "SEND");
        assert.equal(sendRow?.status_rx, 409, "the SEND row records the refusal as 409, preserving the model's termination attempt");
    } finally { await db.close(); }
});

test("[§send-premature-terminate] a model that won't stop premature-200ing with a live child STRIKES OUT (500)", async () => {
    // The 200-vs-202 robustness: a confused model that keeps declaring done while its child runs is
    // not allowed to falsely complete — each premature 200 strikes, and it abandons at 500. It can't
    // hang the runtime, and it can't lie about being done.
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `prem-strike-${crypto.randomUUID()}`);
        const parentRun = await insertRun(db, sessionId);
        const parentLoop = await insertLoop(db, parentRun, 1, "parent");
        // A persistently live child (its loop stays non-terminal through the parent's whole loop).
        const childRun = await insertRun(db, sessionId, parentRun);
        await insertLoop(db, childRun, 1, "child");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: Array.from({ length: 6 }, () => ({ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } })) });
        const result = await engine.runLoop({ provider, sessionId, runId: parentRun, loopId: parentLoop, messages: [], maxTurns: 10, maxStrikes: 3 });
        // The engine rails abandon it: identical repeated premature-200 turns trip CYCLE detection (508)
        // before the plain strike threshold (500) — defense in depth. Either way the model is terminated
        // and never gets a false 200. The robustness guarantee: a confused model can't falsely complete
        // (no 200 terminal) and can't hang (it terminates), it just abandons via the rails.
        assert.ok([500, 508].includes(result.finalStatus), `premature-200 spammer abandons via the rails (500 strike / 508 cycle); got ${result.finalStatus}`);
        assert.notEqual(result.finalStatus, 200, "a model declaring done with work running NEVER gets a false 200");
    } finally { await db.close(); }
});
