// Demo: reasoning + concise final reply.
// Multiplication is a clean test for "model thinks, then sends a tight
// answer." The final SEND content carries the answer; no memory write
// is required for this prompt.

import test from "node:test";
import assert from "node:assert/strict";
import { runDemo } from "./_helpers.ts";

test("demo: simple arithmetic — model reasons and replies with the number", async () => {
    const run = await runDemo({
        prompt: "What is 17 multiplied by 23? Reply with just the number.",
        label: "arithmetic",
        maxTurns: 4,
    });
    try {
        assert.equal(run.finalStatus, 200, "model terminated cleanly");
        assert.equal(run.hitMaxTurns, false, "didn't hit the safety cap");
        assert.match(run.lastContent, /391/, "final reply contains the correct answer");
    } finally { await run.db.close(); }
});
