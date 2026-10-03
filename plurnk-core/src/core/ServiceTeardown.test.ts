import test from "node:test";
import assert from "node:assert/strict";
import ServiceTeardown from "./ServiceTeardown.ts";

test("service teardown releases admitted resources in reverse ownership order, exactly once", async () => {
    const calls: string[] = [];
    const teardown = new ServiceTeardown(
        async () => { calls.push("daemon.stop"); },
        ["observability shutdown", async () => { calls.push("observability.shutdown"); }],
        ["database close", async () => { calls.push("db.close"); }],
        ["HTTP listener close", async () => { calls.push("listener.close"); }],
    );

    await Promise.all([teardown.close(), teardown.close()]);

    assert.deepEqual(calls, ["daemon.stop", "observability.shutdown", "db.close", "listener.close"]);
});

test("service teardown runs observability and database phases after daemon failure and preserves every failure", async () => {
    const daemonFailure = new Error("daemon stop failed");
    const observabilityFailure = new Error("observability shutdown failed");
    const databaseFailure = new Error("database close failed");
    const calls: string[] = [];
    const teardown = new ServiceTeardown(
        async () => { calls.push("daemon.stop"); throw daemonFailure; },
        ["observability shutdown", async () => { calls.push("observability.shutdown"); throw observabilityFailure; }],
        ["database close", async () => { calls.push("db.close"); throw databaseFailure; }],
    );

    await assert.rejects(
        () => teardown.close(),
        (cause: unknown) => {
            assert.ok(cause instanceof AggregateError);
            assert.equal(cause.message, "service shutdown failed");
            assert.deepEqual(cause.errors, [daemonFailure, observabilityFailure, databaseFailure]);
            return true;
        },
    );
    assert.deepEqual(calls, ["daemon.stop", "observability.shutdown", "db.close"]);
});

test("failed startup preserves the originating failure and every teardown failure", async () => {
    const startupFailure = new Error("daemon start failed");
    const daemonFailure = new Error("daemon stop failed");
    const observabilityFailure = new Error("observability shutdown failed");
    const databaseFailure = new Error("database close failed");
    const teardown = new ServiceTeardown(
        async () => { throw daemonFailure; },
        ["observability shutdown", async () => { throw observabilityFailure; }],
        ["database close", async () => { throw databaseFailure; }],
    );

    await assert.rejects(
        () => teardown.fail(startupFailure),
        (cause: unknown) => {
            assert.ok(cause instanceof AggregateError);
            assert.equal(cause.message, "service startup and shutdown failed");
            assert.deepEqual(cause.errors, [startupFailure, daemonFailure, observabilityFailure, databaseFailure]);
            return true;
        },
    );
});

test("failed startup rethrows its exact failure when teardown succeeds", async () => {
    const startupFailure = new Error("daemon start failed");
    const teardown = new ServiceTeardown(async () => {});

    await assert.rejects(
        () => teardown.fail(startupFailure),
        (cause: unknown) => cause === startupFailure,
    );
});

test("a repeated signal request performs and reports failed teardown once", async () => {
    const failure = new Error("daemon stop failed");
    let stops = 0;
    let closes = 0;
    const reported: unknown[] = [];
    let resolveReport: (() => void) | undefined;
    const reportReceived = new Promise<void>((resolve) => { resolveReport = resolve; });
    const teardown = new ServiceTeardown(
        async () => { stops += 1; throw failure; },
        ["observability shutdown", async () => {}],
        ["database close", async () => { closes += 1; }],
    );
    const report = (cause: unknown): void => {
        reported.push(cause);
        resolveReport?.();
    };

    teardown.request(report);
    teardown.request(report);
    await reportReceived;

    assert.equal(stops, 1);
    assert.equal(closes, 1);
    assert.deepEqual(reported, [failure]);
});

test("{§crash-only-stop} a clean request reports its settlement once, to the closed callback alone", async () => {
    let closes = 0;
    let closed = 0;
    const reported: unknown[] = [];
    let resolveClosed: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const teardown = new ServiceTeardown(async () => { closes += 1; });
    const onClosed = (): void => { closed += 1; resolveClosed?.(); };
    teardown.request((cause) => { reported.push(cause); }, onClosed);
    teardown.request((cause) => { reported.push(cause); }, onClosed);
    await settled;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes, 1, "the teardown ran once");
    assert.equal(closed, 1, "settlement was reported once");
    assert.deepEqual(reported, [], "nothing failed, so nothing was reported as a failure");
});

test("service teardown diagnostics enumerate aggregate failures", () => {
    const cause = new AggregateError([
        new Error("daemon stop failed"),
        new Error("database close failed"),
    ], "service shutdown failed");

    assert.equal(
        ServiceTeardown.diagnostic("shutdown", cause),
        "shutdown: service shutdown failed\n"
        + "  1. daemon stop failed\n"
        + "  2. database close failed\n",
    );
});

for (const phase of ["observability shutdown", "database close", "HTTP listener close"]) {
test(`{§crash-only-stop} ${phase} cannot outlive the enclosing shutdown budget`, async (t) => {
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "20";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const pending = Promise.withResolvers<void>();
    let laterCleanup = false;
    const teardown = new ServiceTeardown(
        async () => {},
        [phase, async () => pending.promise],
        ["later cleanup", async () => { laterCleanup = true; }],
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
        await assert.rejects(Promise.race([
            teardown.close(),
            new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("test guard: service cleanup remained unbounded")), 200); }),
        ]), { message: `stop deadline exceeded waiting for ${phase}` });
        assert.equal(laterCleanup, true, "later cleanup is attempted even after the deadline");
    } finally {
        clearTimeout(guard);
        pending.resolve();
        await teardown.close().catch((cause) => { assert.match(String(cause), /stop deadline exceeded/); });
    }
});
}

test("{§crash-only-stop} nested drains and later cleanup share the original deadline", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "100";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const nested = Promise.withResolvers<void>();
    const later = Promise.withResolvers<void>();
    const stuck = Promise.withResolvers<void>();
    const teardown = new ServiceTeardown(
        async (deadline) => {
            const result = deadline.settle("nested drain", () => new Promise<void>((resolve) => setTimeout(resolve, 60)));
            nested.resolve();
            assert.equal((await result).status, "fulfilled");
        },
        ["database close", async () => { later.resolve(); await stuck.promise; }],
    );
    const closed = assert.rejects(teardown.close(), { message: "stop deadline exceeded waiting for database close" });
    await nested.promise;
    t.mock.timers.tick(60);
    await later.promise;
    t.mock.timers.tick(40);
    await closed;
    stuck.resolve();
});

test("{§module-shutdown-order} an expired producer drain still closes observers before enclosing resources", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const prior = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "20";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = prior;
    });
    const events: string[] = [];
    const stuck = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const teardown = new ServiceTeardown(
        async (deadline) => {
            const waiting = deadline.settle("producer drain", () => stuck.promise);
            entered.resolve();
            const result = await waiting;
            events.push("observers closed");
            if (result.status === "rejected") throw result.reason;
        },
        ["database close", async () => { events.push("database closed"); }],
    );
    try {
        const closed = assert.rejects(teardown.close(), { message: "stop deadline exceeded waiting for producer drain" });
        await entered.promise;
        t.mock.timers.tick(20);
        await closed;
        assert.deepEqual(events, ["observers closed", "database closed"]);
    } finally { stuck.resolve(); }
});
