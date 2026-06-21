import test from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import SubprocessExecutor from "./SubprocessExecutor.ts";
import type { ExecArgs, ExecResult } from "./types.ts";
import type { TelemetryEvent } from "./TelemetryEvent.ts";

// Drive a real subprocess and collect the sink activity. Resolves once run()
// settles.
const exec = async (runtime: string, command: string, opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}) => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const states: { channel: string; state: string }[] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime, command, cwd: null, env: opts.env,
        signal: opts.signal ?? new AbortController().signal,
        write: (channel, chunk) => { out[channel] = (out[channel] ?? "") + chunk; },
        setState: (channel, state) => states.push({ channel, state }),
        emit: (event) => events.push(event),
    };
    const result: ExecResult = await new SubprocessExecutor({ runtime, glyph: "🐚" }).run(args);
    return { result, out, states, events };
};

test("SubprocessExecutor declares stdout + stderr channels", () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.deepEqual(ex.channels, {
        stdout: { mimetype: "text/stream" },
        stderr: { mimetype: "text/stream" },
    });
});

test("probe: default (no binary) → available", async () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.deepEqual(await ex.probe(), { available: true });
});

test("effect: subprocess is always host (regardless of target)", () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.equal(ex.effect(null), "host");
    assert.equal(ex.effect("/work/dir"), "host");
});

test("env: a scoped env is handed to the child verbatim (#8)", async () => {
    const { result, out } = await exec("sh", 'echo "$FOO"', { env: { FOO: "scoped-value" } });
    assert.equal(result.status, 200);
    assert.equal(out.stdout.trim(), "scoped-value");
});

test("env: scoping hides host secrets; default inherits them (#8 back-compat)", async () => {
    process.env.PLURNK_TEST_SECRET = "leak-me";
    try {
        // Consumer-scoped env without the secret → the child cannot read it.
        const scoped = await exec("sh", 'echo "[${PLURNK_TEST_SECRET:-absent}]"', { env: { PATH: process.env.PATH } });
        assert.equal(scoped.out.stdout.trim(), "[absent]");
        // No env override → host env inherited (the pre-#8 behavior is preserved).
        const inherited = await exec("sh", 'echo "[${PLURNK_TEST_SECRET:-absent}]"');
        assert.equal(inherited.out.stdout.trim(), "[leak-me]");
    } finally {
        delete process.env.PLURNK_TEST_SECRET;
    }
});

// A subclass that overrides spawnArgs to feed the command via stdin — the
// extension point the common-REPL harness uses.
class StdinExec extends SubprocessExecutor {
    protected override spawnArgs(_runtime: string, command: string) {
        return { cmd: "cat", args: [] as string[], useShell: false, stdin: command };
    }
}

test("spawnArgs override + stdin: command fed via stdin reaches stdout", async () => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const args: ExecArgs = {
        runtime: "x", command: "piped-through-stdin", cwd: null,
        signal: new AbortController().signal,
        write: (c, chunk) => { out[c] = (out[c] ?? "") + chunk; },
        setState: () => {}, emit: () => {},
    };
    const result = await new StdinExec({ runtime: "x", glyph: "•" }).run(args);
    assert.deepEqual(result, { status: 200, exitCode: 0 });
    assert.equal(out.stdout, "piped-through-stdin");
});

// A SubprocessExecutor naming a real vs bogus binary, to exercise the probe path.
class BinExec extends SubprocessExecutor {
    #bin: string;
    constructor(bin: string) { super({ runtime: bin, glyph: "•" }); this.#bin = bin; }
    protected override get binary(): string { return this.#bin; }
}

test("probe: present binary → available with version detail", async () => {
    const { available, detail } = await new BinExec("node").probe();
    assert.equal(available, true);
    assert.match(String(detail), /^v?\d+\./);
});

test("probe: missing binary → unavailable with actionable detail", async () => {
    const { available, detail } = await new BinExec("definitely-not-a-real-binary-xyz").probe();
    assert.equal(available, false);
    assert.match(String(detail), /not found on PATH/);
});

test("sh: stdout streamed, channels closed, exit 0", async () => {
    const { result, out, states, events } = await exec("sh", "echo hello");
    assert.deepEqual(result, { status: 200, exitCode: 0 });
    assert.equal(out.stdout, "hello\n");
    assert.deepEqual(states, [
        { channel: "stdout", state: "closed" },
        { channel: "stderr", state: "closed" },
    ]);
    assert.equal(events.length, 0);
});

test("sh: nonzero exit → status 500, errored channels, no telemetry (program result, not framework failure)", async () => {
    const { result, states, events } = await exec("sh", "echo oops 1>&2; exit 3");
    assert.equal(result.status, 500);
    assert.equal(result.exitCode, 3);
    assert.deepEqual(states, [
        { channel: "stdout", state: "errored" },
        { channel: "stderr", state: "errored" },
    ]);
    assert.equal(events.length, 0);
});

test("sh: stderr captured into the stderr channel", async () => {
    const { out } = await exec("sh", "echo to-err 1>&2");
    assert.equal(out.stderr, "to-err\n");
});

test("spawn failure on a nonexistent binary emits spawn_failed telemetry", async () => {
    const { result, states, events } = await exec("definitely-not-a-real-binary-xyz", "noop");
    assert.equal(result.status, 500);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "exec:definitely-not-a-real-binary-xyz");
    assert.equal(events[0].kind, "spawn_failed");
    assert.equal(states.at(-1)?.state, "errored");
});

test("abort mid-run → status 499", async () => {
    const controller = new AbortController();
    const promise = exec("sh", "sleep 5", { signal: controller.signal });
    controller.abort();
    const { result, states } = await promise;
    assert.equal(result.status, 499);
    assert.equal(states.at(-1)?.state, "errored");
});

test("abort terminates the whole process group — no shell grandchild survives (plurnk-execs#4)", async () => {
    // Unique, long-lived duration so the spawned `sleep` is matchable via pgrep
    // and can't collide with another test's process.
    const dur = `9999.${process.hrtime.bigint().toString().slice(-9)}`;
    const controller = new AbortController();
    const promise = exec("sh", `sleep ${dur}`, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 300));   // let the group establish
    controller.abort();
    const { result } = await promise;
    assert.equal(result.status, 499);

    await new Promise((r) => setTimeout(r, 600));    // let SIGTERM land
    const survivors = spawnSync("pgrep", ["-f", dur]).stdout.toString().trim();
    if (survivors) spawnSync("pkill", ["-f", dur]);  // don't leak into other tests
    assert.equal(survivors, "", `leaked process(es) after abort: ${survivors}`);
});

test("KILL[code]: a signal on the abort reason delivers exactly that code, not the default SIGHUP", async () => {
    const controller = new AbortController();
    // Traps USR1 only — catching the echo proves SIGUSR1 was delivered; the
    // default SIGHUP would terminate it without firing the USR1 trap.
    const promise = exec("sh", "trap 'echo CAUGHT_USR1; exit 0' USR1; sleep 5", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));   // let the trap install
    controller.abort(Object.assign(new Error("killed"), { signal: "SIGUSR1" }));
    const { result, out } = await promise;
    assert.equal(result.status, 499);
    assert.match(out.stdout, /CAUGHT_USR1/, "the USR1 trap fired → the override code was delivered");
});

test("loop-end housekeeping marker: SIGHUP then SIGKILL after grace reaps a HUP-ignoring process", async () => {
    const controller = new AbortController();
    // node swallows SIGHUP and stays alive — so the run can only settle because
    // the grace-timed SIGKILL fired. A plain KILL (polite, no reap) would leave it.
    const promise = exec("node", "process.on('SIGHUP', () => {}); setInterval(() => {}, 1e9)", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort({ housekeeping: true, graceMs: 100 });
    const { result } = await promise;
    assert.equal(result.status, 499, "the housekeeping SIGKILL reaped the HUP-ignoring process");
});
