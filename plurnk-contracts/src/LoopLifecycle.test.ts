import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleOfLoopStatus, selectWorkerLoop } from "./LoopLifecycle.ts";

test("{§loop-lifecycle-vocabulary} one projection from loop status to the shared lifecycle words", () => {
    assert.equal(lifecycleOfLoopStatus(null), "idle");
    assert.equal(lifecycleOfLoopStatus(undefined), "idle");
    assert.equal(lifecycleOfLoopStatus(100), "queued");
    assert.equal(lifecycleOfLoopStatus(102), "running");
    assert.equal(lifecycleOfLoopStatus(202), "parked");
    assert.equal(lifecycleOfLoopStatus(200), "completed");
    for (const terminal of [413, 429, 499, 500, 504, 508]) assert.equal(lifecycleOfLoopStatus(terminal), "failed", String(terminal));
});

test("{§application-worker-observation}: live work outranks newer terminal history", () => {
    const loop = (sequence: number, status: number, terminatedAt: string | null = null) => ({ sequence, status, terminatedAt });
    const running = loop(2, 102);
    const parked = loop(1, 202);
    const queued = loop(3, 100);
    const completed = loop(4, 200, "2026-09-16T01:00:00.000Z");
    const failed = loop(5, 500, "2026-09-16T00:00:00.000Z");
    assert.equal(selectWorkerLoop([parked, running, queued, completed, failed]), running);
    assert.equal(selectWorkerLoop([completed, queued, parked]), parked);
    assert.equal(selectWorkerLoop([completed, queued]), queued);
    assert.equal(selectWorkerLoop([failed, completed]), completed, "latest settlement, not greatest sequence");
    assert.equal(selectWorkerLoop([loop(6, 100), queued]), queued, "oldest obligation within the same live state");
    assert.equal(selectWorkerLoop([]), null);
});
