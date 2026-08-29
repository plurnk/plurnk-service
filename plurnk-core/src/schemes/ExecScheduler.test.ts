import assert from "node:assert/strict";
import test from "node:test";
import ExecScheduler, { readExecConcurrency } from "./ExecScheduler.ts";

test("{§exec-concurrency}: configuration accepts only a positive bound or -1", () => {
    for (const [raw, expected] of [["1", 1], ["12", 12], [" 32 ", 32], ["-1", -1]] as const) {
        assert.equal(readExecConcurrency({ PLURNK_SERVICE_EXEC_CONCURRENCY: raw }), expected);
    }
    for (const raw of [undefined, "", " ", "0", "-2", "1.5", "Infinity", "oops"]) {
        assert.throws(
            () => readExecConcurrency({ PLURNK_SERVICE_EXEC_CONCURRENCY: raw }),
            /PLURNK_SERVICE_EXEC_CONCURRENCY must be -1 .* or a positive safe integer/,
        );
    }
});

test("{§exec-concurrency}: an aborted waiter never takes a FIFO slot", async () => {
    const scheduler = new ExecScheduler(1);
    const running = scheduler.admit(1, new AbortController().signal);
    const cancelledController = new AbortController();
    const cancelled = scheduler.admit(1, cancelledController.signal);
    const next = scheduler.admit(1, new AbortController().signal);
    const admissions: string[] = [];
    cancelled.ready.then(() => admissions.push("cancelled"));
    next.ready.then(() => admissions.push("next"));

    assert.equal(running.queued, false);
    assert.equal(cancelled.executionsAhead, 1);
    assert.equal(next.executionsAhead, 2);
    cancelledController.abort();
    await cancelled.ready;
    assert.deepEqual(admissions, ["cancelled"]);

    const releaseRunning = await running.ready;
    releaseRunning();
    const releaseNext = await next.ready;
    assert.deepEqual(admissions, ["cancelled", "next"]);
    releaseNext();

    const reused = scheduler.admit(1, new AbortController().signal);
    assert.equal(reused.queued, false, "the empty workspace scheduler releases its capacity");
    (await reused.ready)();
});
