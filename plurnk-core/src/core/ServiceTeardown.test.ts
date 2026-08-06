import test from "node:test";
import assert from "node:assert/strict";
import ServiceTeardown from "./ServiceTeardown.ts";

test("service teardown stops the daemon before closing the database, exactly once", async () => {
    const calls: string[] = [];
    const teardown = new ServiceTeardown(
        async () => { calls.push("daemon.stop"); },
        async () => { calls.push("observability.shutdown"); },
        async () => { calls.push("db.close"); },
    );

    await Promise.all([teardown.close(), teardown.close()]);

    assert.deepEqual(calls, ["daemon.stop", "observability.shutdown", "db.close"]);
});

test("service teardown runs observability and database phases after daemon failure and preserves every failure", async () => {
    const daemonFailure = new Error("daemon stop failed");
    const observabilityFailure = new Error("observability shutdown failed");
    const databaseFailure = new Error("database close failed");
    const calls: string[] = [];
    const teardown = new ServiceTeardown(
        async () => { calls.push("daemon.stop"); throw daemonFailure; },
        async () => { calls.push("observability.shutdown"); throw observabilityFailure; },
        async () => { calls.push("db.close"); throw databaseFailure; },
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
        async () => { throw observabilityFailure; },
        async () => { throw databaseFailure; },
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
    const teardown = new ServiceTeardown(async () => {}, async () => {}, async () => {});

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
        async () => {},
        async () => { closes += 1; },
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
