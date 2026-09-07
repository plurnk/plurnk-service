import assert from "node:assert/strict";
import test from "node:test";
import WorkspaceGate from "./WorkspaceGate.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a queued exclusive request blocks later ordinary turns", async () => {
    const gate = new WorkspaceGate(async (workerId, rootWorkerId) => workerId === rootWorkerId);
    const first = await gate.acquireTurn(1, 1);
    const exclusive = gate.requestExclusive(1);
    let laterAcquired = false;
    const later = gate.acquireTurn(1, 2).then((release) => {
        laterAcquired = true;
        return release;
    });
    await tick();
    assert.equal(laterAcquired, false);
    first();
    await exclusive.acquired;
    await tick();
    assert.equal(laterAcquired, false);
    exclusive.release();
    (await later)();
});

test("exclusive mode admits only its selected lineage and serializes those turns", async () => {
    const descendants = new Set(["7:7", "8:7"]);
    const gate = new WorkspaceGate(async (workerId, rootWorkerId) => descendants.has(`${workerId}:${rootWorkerId}`));
    const exclusive = gate.requestExclusive(1);
    await exclusive.acquired;
    exclusive.setRoot(7);

    let childTwoAcquired = false;
    let outsiderAcquired = false;
    const childOne = await gate.acquireTurn(1, 7);
    const childTwo = gate.acquireTurn(1, 8).then((release) => {
        childTwoAcquired = true;
        return release;
    });
    const outsider = gate.acquireTurn(1, 9).then((release) => {
        outsiderAcquired = true;
        return release;
    });
    await tick();
    assert.equal(childTwoAcquired, false);
    assert.equal(outsiderAcquired, false);
    childOne();
    const childTwoRelease = await childTwo;
    assert.equal(childTwoAcquired, true);
    assert.equal(outsiderAcquired, false);
    childTwoRelease();
    exclusive.setRoot(null);
    exclusive.release();
    (await outsider)();
});

test("a capability replacement acquires only at an immediately quiescent boundary", async () => {
    const gate = new WorkspaceGate(async () => false);
    const first = gate.tryExclusive(1);
    assert.ok(first !== null);
    assert.equal(gate.tryExclusive(1), null, "a second replacement cannot queue behind the first");
    first.release();

    const turn = await gate.acquireTurn(1, 1);
    assert.equal(gate.tryExclusive(1), null, "a replacement cannot wait behind active user work");
    turn();

    const settled = gate.tryExclusive(1);
    assert.ok(settled !== null, "the retry succeeds after the workspace settles");
    settled.release();
});

test("cancelling a queued turn removes its request without waiting for the workspace", async () => {
    const gate = new WorkspaceGate(async () => true);
    const exclusive = gate.requestExclusive(1);
    await exclusive.acquired;
    const abort = new AbortController();
    const reason = new Error("execution allowance exhausted");
    let rejected: unknown;
    const waiting = gate.acquireTurn(1, 1, abort.signal).catch((error: unknown) => { rejected = error; });
    try {
        abort.abort(reason);
        await tick();
        assert.equal(rejected, reason, "cancellation is settled before the exclusive owner releases");
    } finally {
        exclusive.release();
        const release = await waiting;
        if (typeof release === "function") release();
    }
    (await gate.acquireTurn(1, 2))();
});

test("cancellation during an asynchronous lineage check cannot admit the cancelled turn", async () => {
    const checking = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<boolean>();
    const gate = new WorkspaceGate(async () => { checking.resolve(); return checked.promise; });
    const exclusive = gate.requestExclusive(1);
    await exclusive.acquired;
    exclusive.setRoot(1);
    const abort = new AbortController();
    const reason = new Error("cancelled during lineage lookup");
    let rejected: unknown;
    const waiting = gate.acquireTurn(1, 2, abort.signal).catch((error: unknown) => { rejected = error; });
    await checking.promise;
    abort.abort(reason);
    checked.resolve(true);
    try {
        await tick();
        assert.equal(rejected, reason);
    } finally {
        const release = await waiting;
        if (typeof release === "function") release();
        exclusive.release();
    }
    (await gate.acquireTurn(1, 3))();
});

test("a changed exclusive root invalidates an asynchronous lineage permission", async () => {
    const checking = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<boolean>();
    const reconsidered = Promise.withResolvers<void>();
    const gate = new WorkspaceGate(async (_workerId, root) => {
        if (root === 1) { checking.resolve(); return checked.promise; }
        reconsidered.resolve();
        return false;
    });
    const exclusive = gate.requestExclusive(1);
    await exclusive.acquired;
    exclusive.setRoot(1);
    let acquired = false;
    const waiting = gate.acquireTurn(1, 2).then((release) => { acquired = true; return release; });
    await checking.promise;
    exclusive.setRoot(3);
    checked.resolve(true);
    await reconsidered.promise;
    assert.equal(acquired, false, "permission under the former root does not admit work under the replacement");
    exclusive.release();
    (await waiting)();
});

test("turn cancellation is admission-scoped, not an implicit release of an already acquired workspace", async () => {
    const gate = new WorkspaceGate(async () => true);
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled before admission"));
    await assert.rejects(gate.acquireTurn(1, 1, aborted.signal), (error: unknown) => error === aborted.signal.reason);
    const live = new AbortController();
    const release = await gate.acquireTurn(1, 1, live.signal);
    live.abort();
    assert.equal(gate.tryExclusive(1), null, "the acquired turn keeps ownership until its caller releases it");
    release();
    const exclusive = gate.tryExclusive(1);
    assert.ok(exclusive !== null);
    exclusive.release();
});
