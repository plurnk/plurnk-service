import assert from "node:assert/strict";
import test from "node:test";
import WorkspaceGate from "./WorkspaceGate.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("{§functionality-model-mutation} concurrent turns yield for publications and resume behind the same gate", async () => {
    const gate = new WorkspaceGate(async () => false);
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const events: string[] = [];
    const run = (worker: number) => gate.withTurn(1, worker, async () => {
        events.push(`turn:${worker}`);
        if (worker === 2) entered.resolve();
        await proceed.promise;
        await gate.atBoundary(1, async () => {
            const exclusive = gate.requestExclusive(1);
            try {
                await exclusive.acquired;
                events.push(`publish:${worker}`);
                assert.equal(gate.tryExclusive(1), null, "publication retains exclusivity");
            } finally { exclusive.release(); }
        });
        assert.equal(gate.tryExclusive(1), null, "the resumed program has its shared lease back");
        events.push(`resumed:${worker}`);
    });
    const first = run(1);
    const second = run(2);
    await entered.promise;
    proceed.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["turn:1", "turn:2", "publish:1", "publish:2", "resumed:1", "resumed:2"]);
    const available = gate.tryExclusive(1);
    assert.ok(available);
    available.release();
});

test("{§functionality-model-mutation} a failed publication reacquires the turn and no lease escapes its scope", async () => {
    const gate = new WorkspaceGate(async () => false);
    const failure = new Error("publication refused");
    const resume = Promise.withResolvers<void>();
    let delayed!: Promise<void>;
    await gate.withTurn(1, 1, async () => {
        await assert.rejects(gate.atBoundary(1, async () => { throw failure; }), (cause: unknown) => cause === failure);
        assert.equal(gate.tryExclusive(1), null);
        delayed = resume.promise.then(() => gate.atBoundary(1, async () => {}));
    });
    resume.resolve();
    await delayed;
    const available = gate.tryExclusive(1);
    assert.ok(available);
    available.release();
});

test("{§functionality-preparation-cancellation} cancelling a queued publisher neither releases another owner nor publishes later", async () => {
    const gate = new WorkspaceGate(async () => false);
    const first = gate.requestExclusive(1);
    await first.acquired;
    const controller = new AbortController();
    const second = gate.requestExclusive(1, controller.signal);
    const rejected = assert.rejects(second.acquired, (cause: unknown) => cause === controller.signal.reason);
    controller.abort(new Error("cancelled publication"));
    await rejected;
    second.release();
    assert.equal(gate.tryExclusive(1), null, "the first publisher still owns the workspace");
    first.release();
    const available = gate.tryExclusive(1);
    assert.ok(available, "the cancelled writer leaves no admission behind");
    available.release();
});

test("{§module-workspace-quiescence} a queued exclusive request blocks later ordinary turns", async () => {
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

test("{§module-workspace-quiescence} exclusive mode admits only its selected lineage and serializes those turns", async () => {
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

test("{§module-workspace-quiescence} a capability replacement acquires only at an immediately quiescent boundary", async () => {
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

test("{§loop-execution-allowance} cancelling a queued turn removes its request without waiting for the workspace", async () => {
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

test("{§loop-execution-allowance} cancellation during an asynchronous lineage check cannot admit the cancelled turn", async () => {
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

test("{§loop-execution-allowance} a changed exclusive root invalidates an asynchronous lineage permission", async () => {
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

test("{§loop-execution-allowance} turn cancellation is admission-scoped, not an implicit release of an already acquired workspace", async () => {
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
