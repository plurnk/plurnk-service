import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleOfLoopStatus } from "./LoopLifecycle.ts";

test("{§loop-lifecycle-vocabulary} one projection from loop status to the shared lifecycle words", () => {
    assert.equal(lifecycleOfLoopStatus(null), "idle");
    assert.equal(lifecycleOfLoopStatus(undefined), "idle");
    assert.equal(lifecycleOfLoopStatus(100), "queued");
    assert.equal(lifecycleOfLoopStatus(102), "running");
    assert.equal(lifecycleOfLoopStatus(202), "parked");
    assert.equal(lifecycleOfLoopStatus(200), "completed");
    for (const terminal of [413, 429, 499, 500, 504, 508]) assert.equal(lifecycleOfLoopStatus(terminal), "failed", String(terminal));
});
