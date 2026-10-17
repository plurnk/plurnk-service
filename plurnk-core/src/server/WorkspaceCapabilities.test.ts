import assert from "node:assert/strict";
import test from "node:test";

import WorkspaceCapabilities, {
    workspaceCapabilityPolicy,
} from "./WorkspaceCapabilities.ts";
import StopDeadline from "../core/StopDeadline.ts";

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

test("workspace Functionality policy accepts only explicit -1/non-negative bounds", () => {
    assert.deepEqual(workspaceCapabilityPolicy({
        PLURNK_SERVICE_WORKSPACE_WARM_MS: "900000",
        PLURNK_SERVICE_WORKSPACE_WARM_MAX: "2",
    }), { warmMs: 900000, warmMax: 2 });
    assert.deepEqual(workspaceCapabilityPolicy({
        PLURNK_SERVICE_WORKSPACE_WARM_MS: "-1",
        PLURNK_SERVICE_WORKSPACE_WARM_MAX: "0",
    }), { warmMs: -1, warmMax: 0 });
    assert.throws(
        () => workspaceCapabilityPolicy({ PLURNK_SERVICE_WORKSPACE_WARM_MS: "1" }),
        /PLURNK_SERVICE_WORKSPACE_WARM_MAX must be -1 or a non-negative safe integer/,
    );
    assert.throws(
        () => workspaceCapabilityPolicy({
            PLURNK_SERVICE_WORKSPACE_WARM_MS: "1.5",
            PLURNK_SERVICE_WORKSPACE_WARM_MAX: "2",
        }),
        /PLURNK_SERVICE_WORKSPACE_WARM_MS must be -1 or a non-negative safe integer/,
    );
});

test("concurrent demand coalesces activation and idempotent release leaves one warm workspace", async () => {
    const activation = deferred();
    let activations = 0;
    const residency = new WorkspaceCapabilities(
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
    assert.deepEqual(residency.activeWorkspaceIds(), [1]);
});

test("retained provider work prevents cooling after its initiating lease releases", async () => {
    const cooled: number[] = [];
    const residency = new WorkspaceCapabilities(
        { warmMs: 0, warmMax: -1 },
        {
            activate: async () => undefined,
            deactivate: async (workspaceId) => { cooled.push(workspaceId); return true; },
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
    assert.deepEqual(residency.activeWorkspaceIds(), []);
});

test("idle LRU cools only the least-recently-used lease-free workspace", async () => {
    const cooled: number[] = [];
    const residency = new WorkspaceCapabilities(
        { warmMs: -1, warmMax: 2 },
        {
            activate: async () => undefined,
            deactivate: async (workspaceId) => { cooled.push(workspaceId); return true; },
            report: () => assert.fail("no residency failure expected"),
        },
    );

    for (const workspaceId of [1, 2, 3]) {
        const release = await residency.acquire(workspaceId);
        release();
    }
    await waitFor(() => cooled.length === 1);
    assert.deepEqual(cooled, [1]);
    assert.deepEqual(residency.activeWorkspaceIds(), [2, 3]);
});

test("new demand waits for in-progress cooling and then reactivates", async () => {
    const cooling = deferred();
    let activations = 0;
    let coolingStarted = false;
    const residency = new WorkspaceCapabilities(
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
    const residency = new WorkspaceCapabilities(
        { warmMs: 20, warmMax: -1 },
        {
            activate: async () => undefined,
            deactivate: async (workspaceId) => { cooled.push(workspaceId); return true; },
            report: () => assert.fail("no residency failure expected"),
        },
    );
    const release = await residency.acquire(1);
    release();
    residency.beginStop();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(cooled, []);
    await assert.rejects(() => residency.acquire(2), /Workspace Functionality is stopping/);
});

for (const phase of ["activation", "cooling"] as const) {
    test(`{§module-shutdown-order} shutdown joins admitted ${phase} and refuses new leases`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const transition = async () => { entered.resolve(); await release.promise; };
        const residency = new WorkspaceCapabilities({ warmMs: 0, warmMax: -1 }, {
            activate: phase === "activation" ? transition : async () => {},
            deactivate: async () => { await transition(); return true; },
            report: () => assert.fail("no cleanup failure expected"),
        });
        const demand = residency.acquire(1);
        const acquired = phase === "activation" ? assert.rejects(demand, { name: "AbortError" })
            : demand.then((releaseLease) => { releaseLease(); });
        await entered.promise;
        residency.beginStop();
        let settled = false;
        const stopping = residency.settle().then(() => { settled = true; });
        try {
            await assert.rejects(residency.acquire(2), { name: "AbortError" });
            assert.throws(() => residency.retain(1), { name: "AbortError" });
            assert.equal(settled, false, "shutdown still owns the held transition");
        } finally { release.resolve(); }
        await Promise.all([stopping, acquired]);
        assert.equal(settled, true);
    });
}

test("{§module-shutdown-order} an activation failure cannot abandon another workspace's transition", async () => {
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const refusal = new Error("fixture activation failed");
    const residency = new WorkspaceCapabilities({ warmMs: -1, warmMax: -1 }, {
        activate: async (id) => { entered[id - 1]!.resolve(); await releases[id - 1]!.promise; if (id === 1) throw refusal; },
        deactivate: async () => true,
        report: () => assert.fail("no cooling failure expected"),
    });
    const first = assert.rejects(residency.acquire(1), (cause) => cause === refusal);
    const second = assert.rejects(residency.acquire(2), { name: "AbortError" });
    await Promise.all(entered.map(({ promise }) => promise));
    residency.beginStop();
    let settled = false;
    const stopping = assert.rejects(residency.settle(), (cause) => {
        assert.ok(cause instanceof AggregateError);
        assert.deepEqual(cause.errors, [refusal]);
        settled = true;
        return true;
    });
    try {
        releases[0]!.resolve();
        await first;
        assert.equal(settled, false, "a rejected transition is retained without short-circuiting its sibling");
    } finally { releases[1]!.resolve(); }
    await Promise.all([stopping, second]);
    assert.equal(settled, true);
});

test("{§module-shutdown-order} cooling failure is retained after its state returns to active", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = new Error("fixture cooling failed");
    const residency = new WorkspaceCapabilities({ warmMs: 0, warmMax: -1 }, {
        activate: async () => {},
        deactivate: async () => { entered.resolve(); await release.promise; throw cleanup; },
        report: () => assert.fail("shutdown owns this failure"),
    });
    (await residency.acquire(1))();
    await entered.promise;
    residency.beginStop();
    release.resolve();
    await assert.rejects(residency.settle(), (cause) => {
        assert.ok(cause instanceof AggregateError);
        assert.deepEqual(cause.errors, [cleanup]);
        return true;
    });
});

test("{§module-workspace-residency} demand joining failed cooling receives the cleanup failure, not a lease", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = new Error("fixture cooling failed");
    const reported: unknown[] = [];
    const residency = new WorkspaceCapabilities({ warmMs: 0, warmMax: -1 }, {
        activate: async () => {},
        deactivate: async () => { entered.resolve(); await release.promise; throw cleanup; },
        report: (workspaceId, cause) => { reported.push([workspaceId, cause]); },
    });
    (await residency.acquire(1))();
    await entered.promise;
    const demand = assert.rejects(residency.acquire(1), (cause) => cause === cleanup);
    release.resolve();
    try {
        await demand;
        assert.deepEqual(reported, [[1, cleanup]]);
    } finally { residency.beginStop(); }
    await residency.settle();
});

test("{§crash-only-stop} non-cooperative workspace preparation uses the existing stop deadline", async (t) => {
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "20";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const residency = new WorkspaceCapabilities({ warmMs: -1, warmMax: -1 }, {
        activate: async () => { entered.resolve(); await release.promise; },
        deactivate: async () => true,
        report: () => assert.fail("no cleanup failure expected"),
    });
    const demand = assert.rejects(residency.acquire(1), { name: "AbortError" });
    await entered.promise;
    residency.beginStop();
    try {
        const result = await new StopDeadline().settle("workspace Functionality transitions", () => residency.settle());
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.match(String(result.reason), /stop deadline exceeded waiting for workspace Functionality transitions/u);
    } finally { release.resolve(); }
    await Promise.all([demand, residency.settle()]);
});
