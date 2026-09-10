import assert from "node:assert/strict";
import test from "node:test";
import LiveAcquisitions from "./LiveAcquisitions.ts";

test("{§http-kill}: address cancellation includes concurrent acquisitions without crossing workspaces", () => {
    const live = new LiveAcquisitions();
    const first = new AbortController();
    const second = new AbortController();
    const foreign = new AbortController();
    const key = LiveAcquisitions.key(1, "https://example.com/resource");
    const release = live.track(key, first);
    live.track(key, second);
    live.track(LiveAcquisitions.key(2, "https://example.com/resource"), foreign);
    assert.equal(live.cancel(key), true);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, true);
    assert.equal(foreign.signal.aborted, false);
    const next = new AbortController();
    live.track(key, next);
    release();
    assert.equal(live.cancel(key), true, "old cleanup cannot untrack a subsequent acquisition");
    assert.equal(next.signal.aborted, true);
    assert.equal(live.cancel(key), false);
});
