import test from "node:test";
import assert from "node:assert/strict";
import ExecAbort from "./exec-abort.ts";

// These shapes ARE the wire contract with @plurnk/plurnk-execs' SubprocessExecutor:
// it reads `reason.signal` (overrideSignal) and `reason.housekeeping`/`reason.graceMs`
// (housekeepingGrace). A drift here silently defaults the executor to its SIGHUP polite-ask.

test("killReason: a numeric override delivers exactly that signal (the executor wire contract)", () => {
    assert.deepEqual(ExecAbort.killReason(9), { signal: 9 });   // SIGKILL
    assert.deepEqual(ExecAbort.killReason(15), { signal: 15 }); // SIGTERM
});

test("killReason: a bare KILL (null) carries no override — the executor's SIGHUP polite default", () => {
    assert.deepEqual(ExecAbort.killReason(null), { signal: null });
});

test("teardownReason: a bounded housekeeping reap carrying the consumer's grace", () => {
    const r = ExecAbort.teardownReason();
    assert.equal(r.housekeeping, true);
    assert.equal(typeof r.graceMs, "number");
});

// {§operator-config-only-home} — the panel owns the value. This reader used to answer 2000 of its
// own accord when the key was unset; an unset key is a broken floor and crashes by name.
test("graceMs: the panel's value, read live; an unset or invalid key crashes by name", () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
    try {
        assert.equal(prior, "2000", "the suite runs on the package's own panel");
        assert.equal(ExecAbort.graceMs, 2000);
        process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = "150";
        assert.equal(ExecAbort.graceMs, 150);
        assert.equal(ExecAbort.teardownReason().graceMs, 150);
        delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        assert.throws(() => ExecAbort.graceMs, /PLURNK_SERVICE_EXEC_KILL_GRACE_MS is missing from the assembled environment floor/);
        process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = "soon";
        assert.throws(() => ExecAbort.graceMs, /must be a safe integer of at least 0; got "soon"/);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        else process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = prior;
    }
});
