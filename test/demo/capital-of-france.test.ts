// Demo: knowledge recall + termination.
// Natural human-style prompt; assertion is on the outcome (the user got a
// useful answer), not on op shapes. A failure here indicts the model +
// sysprompt + grammar trio.

import test from "node:test";
import assert from "node:assert/strict";
import { runDemo } from "./_helpers.ts";

test("demo: 'What is the capital of France?' — model produces a useful outcome", async () => {
    const run = await runDemo({
        prompt: "What is the capital of France?",
        label: "capital-of-france",
    });
    try {
        assert.equal(run.finalStatus, 200, "model terminated with SEND[200]");
        assert.equal(run.hitMaxTurns, false, "didn't hit the safety cap");
        assert.match(run.lastContent, /paris/i, "final reply mentions Paris");
    } finally { await run.db.close(); }
});
