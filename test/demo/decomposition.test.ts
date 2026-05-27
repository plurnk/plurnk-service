// Demo: planning + multiple EDITs.
// "Decompose into sub-questions and store each" exercises the model's
// ability to plan, emit multiple write ops in sequence, and terminate
// cleanly when done — the classic multi-step working-memory pattern.

import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { runDemo } from "./_helpers.ts";

test("demo: decompose a question into 3 sub-questions stored as unknown:// entries", async () => {
    const run = await runDemo({
        prompt: "Why is the sky blue? Decompose this into 3 specific sub-questions and store each as a separate unknown:// entry.",
        label: "decomposition",
        maxTurns: 8,
    });
    try {
        assert.equal(run.finalStatus, 200, "model terminated cleanly");
        assert.equal(run.hitMaxTurns, false, "didn't hit the safety cap");

        // Outcome: at least 3 unknown:// entries were written under the session.
        const count = (await (run.db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({
            session_id: run.sessionId, scheme: "unknown",
        }))?.n ?? 0;
        assert.ok(count >= 3, `expected ≥3 unknown:// entries, got ${count}`);
    } finally { await run.db.close(); }
});
