import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

// #263 — loopUsage.contextTokens is the gauge's numerator: the LAST turn's prompt tokens (window
// occupancy), distinct from the summed promptTokens (cost), which overcounts a growing context.

test("[#263] loopUsage.contextTokens is the last turn's prompt, not the summed total", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ctx-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        // Two turns, a context that grows: prompts 100 then 250.
        await (db.test_turns_insert_with_usage_prompt as PrepMethod).run({ loop_id: loopId, sequence: 1, status: 200, packet: "{}", val: 100 });
        await (db.test_turns_insert_with_usage_prompt as PrepMethod).run({ loop_id: loopId, sequence: 2, status: 200, packet: "{}", val: 250 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.promptTokens, 350, "promptTokens sums across turns (the cost figure)");
        assert.equal(usage.contextTokens, 250, "contextTokens is the LAST turn's prompt (occupancy)");
    } finally { await db.close(); }
});
