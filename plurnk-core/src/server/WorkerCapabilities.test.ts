import assert from "node:assert/strict";
import test from "node:test";

import WorkerCapabilities, {
    workerCapabilityPolicy,
} from "./WorkerCapabilities.ts";

const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return { promise, resolve, reject };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.fail("condition did not settle");
};

test("worker Functionality policy accepts only explicit -1/non-negative bounds", () => {
    assert.deepEqual(workerCapabilityPolicy({
        PLURNK_SERVICE_WORKER_WARM_MS: "900000",
        PLURNK_SERVICE_WORKER_WARM_MAX: "2",
    }), { warmMs: 900000, warmMax: 2 });
    assert.deepEqual(workerCapabilityPolicy({
        PLURNK_SERVICE_WORKER_WARM_MS: "-1",
        PLURNK_SERVICE_WORKER_WARM_MAX: "0",
    }), { warmMs: -1, warmMax: 0 });
    assert.throws(
        () => workerCapabilityPolicy({ PLURNK_SERVICE_WORKER_WARM_MS: "1" }),
        /PLURNK_SERVICE_WORKER_WARM_MAX must be -1 or a non-negative safe integer/,
    );
    assert.throws(
        () => workerCapabilityPolicy({
            PLURNK_SERVICE_WORKER_WARM_MS: "1.5",
            PLURNK_SERVICE_WORKER_WARM_MAX: "2",
        }),
        /PLURNK_SERVICE_WORKER_WARM_MS must be -1 or a non-negative safe integer/,
    );
});

test("concurrent demand coalesces activation and idempotent release leaves one warm worker", async () => {
    const activation = deferred();
    let activations = 0;
    const residency = new WorkerCapabilities(
        { warmMs: -1, warmMax: -1 },
        {
            activate: async () => { activations++; await activation.promise; },
            deactivate: async () => true,
            report: () => assert.fail("no residency failure expected"),
        },
    );

    const first = residency.acquire(1);
    const second = residency.acquire(1);
    await waitFor(() => activations === 1);
    activation.resolve();
    const releaseFirst = await first;
    const releaseSecond = await second;
    releaseFirst();
    releaseFirst();
    releaseSecond();

    assert.equal(activations, 1);
    assert.deepEqual(residency.activeWorkerIds(), [1]);
});

test("retained provider work prevents cooling after its initiating lease releases", async () => {
    const cooled: number[] = [];
    const residency = new WorkerCapabilities(
        { warmMs: 0, warmMax: -1 },
        {
            activate: async () => undefined,
            deactivate: async (workerId) => { cooled.push(workerId); return true; },
            report: () => assert.fail("no residency failure expected"),
        },
    );

    const releaseDemand = await residency.acquire(1);
    const releaseProvider = residency.retain(1);
    releaseDemand();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(cooled, []);
    releaseProvider();
    await waitFor(() => cooled.length === 1);
    assert.deepEqual(residency.activeWorkerIds(), []);
});

test("idle LRU cools only the least-recently-used lease-free worker", async () => {
    const cooled: number[] = [];
    const residency = new WorkerCapabilities(
        { warmMs: -1, warmMax: 2 },
        {
            activate: async () => undefined,
            deactivate: async (workerId) => { cooled.push(workerId); return true; },
            report: () => assert.fail("no residency failure expected"),
        },
    );

    for (const workerId of [1, 2, 3]) {
        const release = await residency.acquire(workerId);
        release();
    }
    await waitFor(() => cooled.length === 1);
    assert.deepEqual(cooled, [1]);
    assert.deepEqual(residency.activeWorkerIds(), [2, 3]);
});

test("new demand waits for in-progress cooling and then reactivates", async () => {
    const cooling = deferred();
    let activations = 0;
    let coolingStarted = false;
    const residency = new WorkerCapabilities(
        { warmMs: 0, warmMax: -1 },
        {
            activate: async () => { activations++; },
            deactivate: async () => {
                coolingStarted = true;
                await cooling.promise;
                return true;
            },
            report: () => assert.fail("no residency failure expected"),
        },
    );

    const releaseFirst = await residency.acquire(1);
    releaseFirst();
    await waitFor(() => coolingStarted);
    let acquiredAgain = false;
    const second = residency.acquire(1).then((release) => {
        acquiredAgain = true;
        return release;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(acquiredAgain, false);
    cooling.resolve();
    const releaseSecond = await second;
    assert.equal(activations, 2);
    releaseSecond();
});

test("beginStop cancels pending cooling and refuses new residency", async () => {
    const cooled: number[] = [];
    const residency = new WorkerCapabilities(
        { warmMs: 20, warmMax: -1 },
        {
            activate: async () => undefined,
            deactivate: async (workerId) => { cooled.push(workerId); return true; },
            report: () => assert.fail("no residency failure expected"),
        },
    );
    const release = await residency.acquire(1);
    release();
    residency.beginStop();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(cooled, []);
    await assert.rejects(() => residency.acquire(2), /Worker Functionality is stopping/);
});
