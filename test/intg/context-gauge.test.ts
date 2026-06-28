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

// #274 — loopUsage.contextSize is the gauge's DENOMINATOR: the LAST turn's model window, so a
// /model-switched loop reports the window of the model that actually ran (not the stale active one).
test("[#274] loopUsage.contextSize is the last turn's model window — survives a model switch", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ctx-size-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        // Turn 1 ran a 49k-window model; turn 2 switched to a 200k-window model.
        await (db.test_turns_insert_with_prompt_and_context_size as PrepMethod).run({ loop_id: loopId, sequence: 1, status: 200, packet: "{}", prompt: 100, context_size: 49152 });
        await (db.test_turns_insert_with_prompt_and_context_size as PrepMethod).run({ loop_id: loopId, sequence: 2, status: 200, packet: "{}", prompt: 250, context_size: 200000 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.contextSize, 200000, "contextSize is the LAST turn's window — the switched-to model, not the stale default");
        assert.equal(usage.contextTokens, 250, "numerator + denominator come from the same (last) turn/model");
    } finally { await db.close(); }
});

test("[#274] loopUsage.contextSize is null when the provider reports no window", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ctx-null-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        // A windowless provider — usage_prompt set, usage_context_size left NULL.
        await (db.test_turns_insert_with_usage_prompt as PrepMethod).run({ loop_id: loopId, sequence: 1, status: 200, packet: "{}", val: 100 });

        const usage = await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId);
        assert.equal(usage.contextSize, null, "no window → null (the client omits the gauge)");
    } finally { await db.close(); }
});
