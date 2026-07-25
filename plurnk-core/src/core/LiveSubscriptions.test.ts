import test from "node:test";
import assert from "node:assert/strict";
import LiveSubscriptions from "./LiveSubscriptions.ts";

test("LiveSubscriptions routes one cancellation through the registered handle", async () => {
    const registry = new LiveSubscriptions();
    let calls = 0;
    registry.register(7, { cancel: async () => { calls += 1; } });

    assert.equal(await registry.cancel(7), true);
    assert.equal(await registry.cancel(7), true);
    assert.equal(calls, 1, "repeated cancellation shares the one owned teardown");
});

test("LiveSubscriptions distinguishes an absent live handle from successful cancellation", async () => {
    const registry = new LiveSubscriptions();
    assert.equal(await registry.cancel(7), false);

    registry.register(7, { cancel() {} });
    registry.unregister(7);
    assert.equal(await registry.cancel(7), false);
});

test("LiveSubscriptions rejects duplicate ownership", () => {
    const registry = new LiveSubscriptions();
    registry.register(7, { cancel() {} });
    assert.throws(() => registry.register(7, { cancel() {} }), /already registered/);
});

test("LiveSubscriptions preserves a synchronous teardown failure as the shared rejection", async () => {
    const registry = new LiveSubscriptions();
    const failure = new Error("teardown failed");
    registry.register(7, { cancel() { throw failure; } });

    const first = registry.cancel(7);
    const second = registry.cancel(7);
    assert.equal(first, second);
    await assert.rejects(first, failure);
});
