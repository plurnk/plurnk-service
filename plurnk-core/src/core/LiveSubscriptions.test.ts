import test from "node:test";
import assert from "node:assert/strict";
import LiveSubscriptions from "./LiveSubscriptions.ts";

test("{§subscriptions-subscription-registry-routes-cancellation} LiveSubscriptions routes one cancellation through the registered handle", async () => {
    const registry = new LiveSubscriptions();
    let calls = 0;
    registry.register(7, { cancel: async () => { calls += 1; } });

    assert.equal(await registry.cancel(7), true);
    assert.equal(await registry.cancel(7), true);
    assert.equal(calls, 1, "repeated cancellation shares the one owned teardown");
});

test("{§subscriptions-subscription-registry-routes-cancellation} LiveSubscriptions distinguishes an absent live handle from successful cancellation", async () => {
    const registry = new LiveSubscriptions();
    assert.equal(await registry.cancel(7), false);

    registry.register(7, { cancel() {} });
    registry.unregister(7);
    assert.equal(await registry.cancel(7), false);
});

test("{§subscriptions-subscription-registry-routes-cancellation} LiveSubscriptions rejects duplicate ownership", () => {
    const registry = new LiveSubscriptions();
    registry.register(7, { cancel() {} });
    assert.throws(() => registry.register(7, { cancel() {} }), /already registered/);
});

test("{§subscription-finalization} LiveSubscriptions preserves a synchronous teardown failure as the shared rejection", async () => {
    const registry = new LiveSubscriptions();
    const failure = new Error("teardown failed");
    registry.register(7, { cancel() { throw failure; } });

    const first = registry.cancel(7);
    const second = registry.cancel(7);
    assert.equal(first, second);
    await assert.rejects(first, failure);
});

test("{§subscription-finalization} failed cancellation may be retried without replacing its owner", async () => {
    const registry = new LiveSubscriptions();
    const failure = new Error("teardown failed");
    let calls = 0;
    registry.register(7, { cancel() { if (++calls === 1) throw failure; } });
    await assert.rejects(registry.cancel(7), (cause) => cause === failure);
    assert.equal(await registry.cancel(7), true);
    assert.equal(await registry.cancel(7), true);
    assert.equal(calls, 2, "successful cancellation is still coalesced");
});

test("{§stream-asked-stop} only the holding session's KILL marks a stream as asked to stop", () => {
    const registry = new LiveSubscriptions();
    registry.register(7, { cancel() {} }, 3);
    registry.asked(7, 4);
    assert.equal(registry.wasAsked(7), false, "a peer's KILL is not the holder's ask");
    registry.asked(7, 3);
    assert.equal(registry.wasAsked(7), true);
    registry.unregister(7);
    assert.equal(registry.wasAsked(7), false, "the mark ends with the registration");
});

// A subscription's close: committed, unregistered, then delivered.
const conclude = (registry: LiveSubscriptions, subscriptionId: number): void => {
    registry.unregister(subscriptionId);
    registry.delivered(subscriptionId);
};
const settledYet = async (promise: Promise<unknown>): Promise<boolean> => {
    let settled = false;
    void promise.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return settled;
};

test("{§exec-lifetime} a loop's reap cancels what its terminal reaps and settles once each has concluded", async () => {
    const registry = new LiveSubscriptions();
    const cancelled: number[] = [];
    registry.register(1, { cancel() { cancelled.push(1); } }, 3, 7);
    registry.register(2, { cancel() { cancelled.push(2); } }, 3, 7);
    registry.register(3, { cancel() { cancelled.push(3); } }, 3, 8);
    registry.register(4, { cancel() { cancelled.push(4); } }, 3);
    const reap = registry.reapLoop(7);
    assert.equal(await settledYet(reap), false, "the reap waits for what it cancelled");
    assert.deepEqual(cancelled, [1, 2], "the loop's own subscriptions, not another loop's, nor one that outlives its loop");
    conclude(registry, 1);
    assert.equal(await settledYet(reap), false, "every one of them");
    conclude(registry, 2);
    assert.deepEqual(await reap, [1, 2], "it settles with the subscriptions it reaped");
    assert.deepEqual(await registry.reapLoop(7), [], "nothing left to reap");
});

test("{§exec-lifetime} a reap reports a cancellation that fails and does not wait on it", async (t) => {
    const registry = new LiveSubscriptions();
    const reported = t.mock.method(console, "error", () => {});
    let attempts = 0;
    registry.register(1, { cancel() { attempts += 1; throw new Error("teardown failed"); } }, 3, 7);
    assert.deepEqual(await registry.reapLoop(7), [], "a subscription it could not reap is not among the reaped");
    assert.equal(reported.mock.callCount(), 1, "the failure is reported");
    await assert.rejects(registry.cancel(1), /teardown failed/u);
    assert.equal(attempts, 2, "a failed cancellation leaves its owner for another attempt");
});
