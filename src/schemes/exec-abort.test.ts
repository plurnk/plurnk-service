import test from "node:test";
import assert from "node:assert/strict";
import ExecAbort from "./exec-abort.ts";

// These shapes ARE the wire contract with @plurnk/plurnk-execs' SubprocessExecutor:
// it reads `reason.signal` (overrideSignal) and `reason.housekeeping`/`reason.graceMs`
// (housekeepingGrace). A drift here silently defaults the executor to its SIGHUP polite-ask.

test("killReason: a numeric KILL[code] delivers exactly that signal", () => {
    assert.deepEqual(ExecAbort.killReason(9), { signal: 9 });   // KILL[9] → SIGKILL
    assert.deepEqual(ExecAbort.killReason(15), { signal: 15 }); // KILL[15] → SIGTERM
});

test("killReason: a bare KILL (null) carries no override — the executor's SIGHUP polite default", () => {
    assert.deepEqual(ExecAbort.killReason(null), { signal: null });
});

test("teardownReason: a bounded housekeeping reap carrying the consumer's grace", () => {
    const r = ExecAbort.teardownReason();
    assert.equal(r.housekeeping, true);
    assert.equal(typeof r.graceMs, "number");
});

test("graceMs: env-tunable, defaulting to 2000ms; teardownReason carries the live value", () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
    try {
        delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        assert.equal(ExecAbort.graceMs, 2000);
        process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = "150";
        assert.equal(ExecAbort.graceMs, 150);
        assert.equal(ExecAbort.teardownReason().graceMs, 150);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        else process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = prior;
    }
});
