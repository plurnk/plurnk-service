import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleOfLoopStatus, selectSessionLoop } from "./LoopLifecycle.ts";

test("{§loop-lifecycle-vocabulary} one projection from loop status to the shared lifecycle words", () => {
    assert.equal(lifecycleOfLoopStatus(null), "idle");
    assert.equal(lifecycleOfLoopStatus(undefined), "idle");
    assert.equal(lifecycleOfLoopStatus(100), "queued");
    assert.equal(lifecycleOfLoopStatus(102), "running");
    assert.equal(lifecycleOfLoopStatus(202), "parked");
    for (const concluded of [200, 204]) assert.equal(lifecycleOfLoopStatus(concluded), "completed", `a loop that concluded ${concluded}`);
    assert.equal(lifecycleOfLoopStatus(499), "cancelled", "a loop stopped without failing");
    for (const terminal of [413, 429, 500, 504, 508]) assert.equal(lifecycleOfLoopStatus(terminal), "failed", String(terminal));
});

test("{§application-session-observation}: live work outranks newer terminal history", () => {
    const loop = (sequence: number, status: number, terminatedAt: string | null = null) => ({ sequence, status, terminatedAt });
    const running = loop(2, 102);
    const parked = loop(1, 202);
    const queued = loop(3, 100);
    const completed = loop(4, 200, "2026-09-16T01:00:00.000Z");
    const failed = loop(5, 500, "2026-09-16T00:00:00.000Z");
    assert.equal(selectSessionLoop([parked, running, queued, completed, failed]), running);
    assert.equal(selectSessionLoop([completed, queued, parked]), parked);
    assert.equal(selectSessionLoop([completed, queued]), queued);
    assert.equal(selectSessionLoop([failed, completed]), completed, "latest settlement, not greatest sequence");
    assert.equal(selectSessionLoop([loop(6, 100), queued]), queued, "oldest obligation within the same live state");
    assert.equal(selectSessionLoop([]), null);
});
