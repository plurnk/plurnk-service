// The abort-reason protocol @plurnk/plurnk-execs' SubprocessExecutor reads off `signal.reason`:
//   { signal }                       → deliver exactly that Unix signal, once, no escalation.
//   { housekeeping: true, graceMs }  → loop/worker teardown: the polite signal, then SIGKILL after graceMs.
// A { signal: null } reason (a bare KILL) carries no override, so the executor applies its own
// polite default, SIGHUP — the gentlest rung; the model escalates with explicit codes.
export default class ExecAbort {
    // The grace a teardown straggler gets before the hard SIGKILL. The executor refuses to bake a
    // number (it'd be a magic literal there); the consumer owns it — env-tunable, 2s default. A
    // getter, not a static field, so a test can set the env at runtime. {§worker-lifecycle-total-reap}
    static get graceMs(): number {
        return Number(process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS ?? "2000");
    }

    // Loop/worker teardown — a bounded reap, so Exec.idle() can't wedge on a signal-ignoring spawn.
    static teardownReason(): { housekeeping: true; graceMs: number } {
        return { housekeeping: true, graceMs: ExecAbort.graceMs };
    }

    // The model's KILL[code] → exactly that signal, once (the model owns escalation: KILL[15] SIGTERM,
    // KILL[9] SIGKILL). A bare KILL (null) carries no override — the executor's SIGHUP polite default.
    static killReason(signal: number | null): { signal: number | null } {
        return { signal };
    }

    // grammar 0.74.20 EXEC `<T>` timeout — the spawn outlived its T-second budget. A BOUNDED reap
    // (polite signal then SIGKILL after graceMs), same protocol as teardown so a signal-ignoring
    // spawn still dies; the caller stamps the distinct 504 close status (a timeout, not a plain kill).
    static timeoutReason(): { housekeeping: true; graceMs: number } {
        return { housekeeping: true, graceMs: ExecAbort.graceMs };
    }
}
