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
