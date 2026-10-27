import test from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir, userInfo } from "node:os";
import Policy from "./policy.ts";
import Runtime from "./runtime.ts";
import Shell from "./Shell.ts";
import SpawnAccounts, { SPAWN_USER } from "./SpawnAccount.ts";
import SubprocessExecutor from "./SubprocessExecutor.ts";
import { tokenizeArgv } from "./tokenizeArgv.ts";
import type { ExecArgs, ExecResult } from "./types.ts";
import type { Notice } from "./Notice.ts";

// A condition the test waits on, polled until it holds; the bound only keeps a hang from outliving the test.
const until = async (what: string, predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};
// The processes whose command line names `marker`, a test's unique duration.
const running = (marker: string): string => spawnSync("pgrep", ["-f", marker]).stdout.toString().trim();

// Drive a real subprocess and collect the sink activity. Resolves once run()
// settles.
const exec = async (runtime: string, command: string, opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string; target?: string } = {}) => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const states: { channel: string; state: string }[] = [];
    const events: Notice[] = [];
    const args: ExecArgs = {
        metadata: null,
        runtime, body: command, cwd: opts.cwd ?? null, target: opts.target ?? null, env: opts.env,
        signal: opts.signal ?? new AbortController().signal,
        write: (channel, chunk) => { out[channel] = (out[channel] ?? "") + chunk; },
        setState: (channel, state) => states.push({ channel, state }),
        emit: (event) => events.push(event),
        interact: async () => ({ action: "cancel" }),
    };
    const result: ExecResult = await new SubprocessExecutor({ runtime, glyph: "🐚" }).run(args);
    return { result, out, states, events };
};

test("{§executor-contract} SubprocessExecutor declares stdout + stderr channels", () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.deepEqual(ex.channels, {
        stdout: { mimetype: "text/stream" },
        stderr: { mimetype: "text/stream" },
    });
});

test("{§executor-results} probe: default (no binary) → available", async () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.deepEqual(await ex.probe(), { available: true });
});

test("{§executor-results} effect: subprocess is always host (regardless of target)", () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.equal(ex.effect(null), "host");
    assert.equal(ex.effect("/work/dir"), "host");
});

test("{§executor-subprocess} cwd is the process working dir when there is no target", async () => {
    const dir = realpathSync(tmpdir());
    const { result, out } = await exec("js", "process.stdout.write(process.cwd())", { cwd: dir });
    assert.equal(result.status, 200);
    assert.equal(realpathSync(out.stdout.trim()), dir);
});

test("{§executor-subprocess} a shell target is one script file, without executable permission, with body tokenized into argv", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "executor-script-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = join(directory, "script with spaces;literal.sh");
    await writeFile(target, 'printf "%s|" "$@"\n', { mode: 0o600 });
    const { result, out } = await exec("sh", '--flag "two words"', { target });
    assert.equal(result.status, 200);
    assert.equal(out.stdout, "--flag|two words|");
});

test("{§executor-subprocess} a stdin-reading program with no stdin body gets /dev/null (EOF) and never hangs", async () => {
    // `cat` with no argument reads fd0 to EOF. With a dangling pipe this blocks
    // forever and parks the loop until a client cancel; /dev/null delivers
    // immediate EOF, so it exits 0 cleanly. If the fix regresses, this test
    // hangs to timeout — the positive assertion is that it resolves at all.
    const { result, out } = await exec("sh", "cat");
    assert.equal(result.status, 200, "the stdin-reader exited cleanly on EOF, not blocked");
    assert.equal(out.stdout, "", "/dev/null yields no bytes");
});

test("{§executor-contract} env: a scoped env is handed to the child verbatim", async () => {
    const { result, out } = await exec("sh", 'echo "$FOO"', { env: { FOO: "scoped-value" } });
    assert.equal(result.status, 200);
    assert.equal(out.stdout.trim(), "scoped-value");
});

test("{§executor-contract} env: scoping hides host secrets; default inherits them", async () => {
    process.env.PLURNK_TEST_SECRET = "leak-me";
    try {
        // Consumer-scoped env without the secret → the child cannot read it.
        const scoped = await exec("sh", 'echo "[${PLURNK_TEST_SECRET:-absent}]"', { env: { PATH: process.env.PATH } });
        assert.equal(scoped.out.stdout.trim(), "[absent]");
        // No env override means the host environment is inherited.
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

class DirectArgvExec extends SubprocessExecutor {
    protected override spawnArgs(_runtime: string, command: string) {
        return { cmd: "printf", args: tokenizeArgv(command), useShell: false };
    }
}

test("{§executor-results} command-tokenization failures return a durable input Problem", async () => {
    const states: { channel: string; state: string }[] = [];
    const result = await new DirectArgvExec({ runtime: "direct", glyph: "d" }).run({
        metadata: null,
        runtime: "direct", body: '"unterminated', cwd: null, target: null,
        signal: new AbortController().signal,
        write: () => {},
        setState: (channel, state) => states.push({ channel, state }),
        emit: () => {},
        interact: async () => ({ action: "cancel" }),
    });
    assert.equal(result.status, 400);
    assert.equal(result.exitCode, -1);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/subprocess/invalid-command");
    assert.equal(result.problem?.detail, "Could not parse the 'direct' command: unterminated double quote.");
    assert.equal(result.problem?.recovery, undefined, "the exact parser cause needs no guessed recovery");
    assert.deepEqual(states, [
        { channel: "stdout", state: "errored" },
        { channel: "stderr", state: "errored" },
    ]);
});

test("{§executor-subprocess} spawnArgs override + stdin: command fed via stdin reaches stdout", async () => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const args: ExecArgs = {
        metadata: null,
        runtime: "x", body: "piped-through-stdin", cwd: null, target: null,
        signal: new AbortController().signal,
        write: (c, chunk) => { out[c] = (out[c] ?? "") + chunk; },
        setState: () => {}, emit: () => {},
        interact: async () => ({ action: "cancel" }),
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

test("{§executor-results} probe: present binary → available with version detail", async () => {
    const { available, detail } = await new BinExec("node").probe();
    assert.equal(available, true);
    assert.match(String(detail), /^v?\d+\./);
});

test("{§executor-results} probe: missing binary → unavailable with actionable detail", async () => {
    const { available, detail } = await new BinExec("definitely-not-a-real-binary-xyz").probe();
    assert.equal(available, false);
    assert.match(String(detail), /not found on PATH/);
});

test("{§executor-results} probe honors a pre-aborted signal → unavailable, no child spawned", async () => {
    const ac = new AbortController();
    ac.abort();
    const { available } = await new BinExec("node").probe(ac.signal);
    assert.equal(available, false);
});

test("{§executor-results} probe accepts a live signal and still reports version when not aborted", async () => {
    const { available, detail } = await new BinExec("node").probe(new AbortController().signal);
    assert.equal(available, true);
    assert.match(String(detail), /^v?\d+\./);
});

test("{§executor-results} sh: stdout streamed, channels closed, exit 0", async () => {
    const { result, out, states, events } = await exec("sh", "echo hello");
    assert.deepEqual(result, { status: 200, exitCode: 0 });
    assert.equal(out.stdout, "hello\n");
    assert.deepEqual(states, [
        { channel: "stdout", state: "closed" },
        { channel: "stderr", state: "closed" },
    ]);
    assert.equal(events.length, 0);
});

test("{§executor-results} an exit code is the command's answer: 200, its exitCode, closed channels, no Problem", async () => {
    const { result, states, events } = await exec("sh", "echo oops 1>&2; exit 3");
    assert.deepEqual(result, { status: 200, exitCode: 3 });
    assert.deepEqual(states, [
        { channel: "stdout", state: "closed" },
        { channel: "stderr", state: "closed" },
    ]);
    assert.equal(events.length, 0);
});

test("{§executor-results} a signal the consumer did not send is a terminated-by-signal failure", async () => {
    const { result, states } = await exec("sh", "kill -KILL $$");
    assert.equal(result.status, 500);
    assert.equal(result.exitCode, -1);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/subprocess/terminated-by-signal");
    assert.equal(result.problem?.detail, "'sh' was terminated by SIGKILL.");
    assert.equal(result.problem?.signal, "SIGKILL");
    assert.deepEqual(states, [
        { channel: "stdout", state: "errored" },
        { channel: "stderr", state: "errored" },
    ]);
});

test("{§executor-contract} sh: stderr captured into the stderr channel", async () => {
    const { out } = await exec("sh", "echo to-err 1>&2");
    assert.equal(out.stderr, "to-err\n");
});

test("{§executor-results} spawn failure returns a durable Problem instead of transient notices", async () => {
    const { result, states, events } = await exec("definitely-not-a-real-binary-xyz", "noop");
    assert.equal(result.status, 500);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/subprocess/spawn-failed");
    assert.match(result.problem?.detail ?? "", /Could not start 'definitely-not-a-real-binary-xyz'/);
    assert.equal(events.length, 0);
    assert.equal(states.at(-1)?.state, "errored");
});

test("{§executor-subprocess} abort mid-run → status 499", async () => {
    const controller = new AbortController();
    const promise = exec("sh", "sleep 5", { signal: controller.signal });
    controller.abort();
    const { result, states } = await promise;
    assert.equal(result.status, 499);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/subprocess/cancelled");
    assert.equal(states.at(-1)?.state, "errored");
});

test("{§executor-subprocess} abort terminates the whole process group — no shell grandchild survives", async () => {
    // Unique, long-lived duration so the spawned `sleep` is matchable via pgrep
    // and can't collide with another test's process.
    const dur = `9999.${process.hrtime.bigint().toString().slice(-9)}`;
    const controller = new AbortController();
    const promise = exec("sh", `sleep ${dur}`, { signal: controller.signal });
    await until("the command's process to run", () => running(dur) !== "");
    controller.abort();
    const { result } = await promise;
    assert.equal(result.status, 499);

    // SIGTERM reaches the whole group: every member goes, within a bound that only stops a leak hanging the test.
    let survivors = running(dur);
    await until("the group to exit", () => (survivors = running(dur)) === "").catch(() => undefined);
    if (survivors) spawnSync("pkill", ["-f", dur]);  // don't leak into other tests
    assert.equal(survivors, "", `leaked process(es) after abort: ${survivors}`);
});

test("{§executor-subprocess} KILL[code]: a signal on the abort reason delivers exactly that code, not the default SIGHUP", async () => {
    const controller = new AbortController();
    // Traps USR1 only — catching the echo proves SIGUSR1 was delivered; the
    // default SIGHUP would terminate it without firing the USR1 trap.
    const dir = await mkdtemp(join(tmpdir(), "executor-usr1-"));
    const trapped = join(dir, "trapped");
    try {
        const promise = exec("sh", `trap 'echo CAUGHT_USR1; exit 0' USR1; : > ${trapped}; sleep 5`, { signal: controller.signal });
        await until("the trap to install", () => existsSync(trapped));
        controller.abort(Object.assign(new Error("killed"), { signal: "SIGUSR1" }));
        const { result, out } = await promise;
        assert.equal(result.status, 499);
        assert.match(out.stdout, /CAUGHT_USR1/, "the USR1 trap fired → the override code was delivered");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§executor-subprocess} loop-end housekeeping marker: SIGHUP then SIGKILL after grace reaps a HUP-ignoring process", async () => {
    const controller = new AbortController();
    // node swallows SIGHUP and stays alive — so the session can only settle because
    // the grace-timed SIGKILL fired. A plain KILL (polite, no reap) would leave it.
    const dir = await mkdtemp(join(tmpdir(), "executor-hup-"));
    const ignoring = join(dir, "ignoring");
    try {
        const promise = exec("js", `process.on('SIGHUP', () => {}); process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(ignoring)}, ''); setInterval(() => {}, 1e9)`, { signal: controller.signal });
        await until("the process to ignore SIGHUP", () => existsSync(ignoring));
        controller.abort({ housekeeping: true, graceMs: 100 });
        const { result } = await promise;
        assert.equal(result.status, 499, "the housekeeping SIGKILL reaped the HUP-ignoring process");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§executor-results} stdin end() racing a fast-exiting child never escapes as EPIPE; outcome is the exit code", async () => {
    // `head -c 0` exits without reading; a large stdin payload forces the write
    // to land after death often enough that an unguarded end() EPIPEs uncaught.
    // With the guard, every iteration settles on the child's own exit.
    class HeadC0 extends SubprocessExecutor {
        protected override spawnArgs() {
            return { cmd: "head", args: ["-c", "0"] as string[], useShell: false, stdin: "x".repeat(1 << 20) };
        }
    }
    for (let i = 0; i < 10; i++) {
        const args: ExecArgs = {
            metadata: null,
            runtime: "x", body: "ignored", cwd: null, target: null,
            signal: new AbortController().signal,
            write: () => {}, setState: () => {}, emit: () => {},
            interact: async () => ({ action: "cancel" }),
        };
        const result = await new HeadC0({ runtime: "x", glyph: "•" }).run(args);
        assert.equal(result.status, 200, `iteration ${i}: settled on the exit code, no escaped EPIPE`);
    }
});

test("{§executor-subprocess} C3: a command aborted before launch never spawns and settles 499", async () => {
    const c = new AbortController();
    c.abort();
    const { result } = await exec("sh", "echo should-not-run", { signal: c.signal });
    assert.equal(result.status, 499);
});

const currentShell = Shell.current().path;

test("{§executor-subprocess} Runtime.resolve maps sh, js, python3, and script targets", () => {
    assert.deepEqual(Runtime.resolve("", "echo hi"), { cmd: currentShell, args: ["-c", "echo hi"], useShell: false });
    assert.deepEqual(Runtime.resolve("sh", "ls -la"), { cmd: currentShell, args: ["-c", "ls -la"], useShell: false });
    assert.deepEqual(Runtime.resolve("js", "console.log(1)"), { cmd: "node", args: ["-e", "console.log(1)"], useShell: false });
    assert.deepEqual(Runtime.resolve("python3", "print(1)"), { cmd: "python3", args: ["-c", "print(1)"], useShell: false });
    assert.deepEqual(Runtime.resolve("perl", "say 1"), { cmd: "perl", args: ["-c", "say 1"], useShell: false });
    assert.deepEqual(Runtime.resolve("sh", '--flag "two words"', "./run.sh"), {
        cmd: currentShell, args: ["./run.sh", "--flag", "two words"], useShell: false,
    });
    assert.deepEqual(Runtime.resolve("python3", '--flag "two words"', "t.py"), {
        cmd: "python3", args: ["t.py", "--flag", "two words"], useShell: false,
    });
    assert.deepEqual(Runtime.resolve("js", '--flag "two words"', "t.js"), {
        cmd: "node", args: ["t.js", "--flag", "two words"], useShell: false,
    });
    for (const runtime of ["", "sh", "js", "python3", "ruby", "🐍", "with spaces"]) {
        for (const command of ["", "echo hi", "rm -rf /", "1 && 2"]) {
            assert.doesNotThrow(() => Runtime.resolve(runtime, command));
        }
    }
});

const shellFixture = async (t: test.TestContext): Promise<{ dir: string; shell: (name: string, script: string, mode?: number) => Promise<string> }> => {
    const dir = await mkdtemp(join(tmpdir(), "execs-shell-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return {
        dir,
        shell: async (name, script, mode = 0o755) => {
            const file = join(dir, name);
            await writeFile(file, `#!/bin/sh\n${script}\n`, { mode });
            return file;
        },
    };
};

test("{§executor-subprocess}: an executable $SHELL is the shell, named with the version it reports", async (t) => {
    const { shell } = await shellFixture(t);
    const declared = await shell("fakesh", 'printf "fakesh, version 4.2.1(1)-release (x86_64)\\n"');
    const choice = Shell.resolve({ SHELL: declared });
    assert.deepEqual(choice, { path: declared, program: "fakesh", version: "4.2.1" });
    assert.equal(Shell.summary(choice), `Run shell commands and scripts with fakesh 4.2.1 (${declared}).`);
});

test("{§executor-subprocess}: a shell that reports no version is named without one", async (t) => {
    const { shell } = await shellFixture(t);
    const declared = await shell("quietsh", "exit 2");
    const choice = Shell.resolve({ SHELL: declared });
    assert.deepEqual(choice, { path: declared, program: "quietsh", version: null });
    assert.equal(Shell.summary(choice), `Run shell commands and scripts with quietsh (${declared}).`);
});

test("{§executor-subprocess}: a $SHELL that names no executable file leaves the system shell", async (t) => {
    const { dir, shell } = await shellFixture(t);
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
        ["unset", {}],
        ["empty", { SHELL: "" }],
        ["relative", { SHELL: "bash" }],
        ["missing", { SHELL: join(dir, "absent") }],
        ["a directory", { SHELL: dir }],
        ["not executable", { SHELL: await shell("plainsh", "exit 0", 0o644) }],
    ];
    for (const [label, env] of cases) {
        assert.equal(Shell.resolve(env).path, Shell.SYSTEM, `${label} $SHELL runs ${Shell.SYSTEM}`);
    }
    assert.equal(Shell.current(), Shell.current());
    assert.ok(isAbsolute(Shell.current().path), "the shell is spawned by its path");
});

const me = userInfo();
const answered = (stdout: string) => () => ({ status: 0, stdout });

test("{§executor-policy}: unset, bare uid[:gid], and named account resolution", () => {
    const emptyEnv = { [SPAWN_USER]: "" };
    assert.equal(SpawnAccounts.configured(emptyEnv), null);
    assert.deepEqual(SpawnAccounts.options(emptyEnv), {});
    assert.deepEqual(SpawnAccounts.environment({ HOME: "/h", USER: "u" }, emptyEnv), { HOME: "/h", USER: "u" });

    assert.deepEqual(SpawnAccounts.configured({ [SPAWN_USER]: "60007" }), { name: null, uid: 60007, gid: 60007, home: null });
    assert.deepEqual(SpawnAccounts.options({ [SPAWN_USER]: "60007:60008" }), { uid: 60007, gid: 60008 });
    assert.deepEqual(SpawnAccounts.environment({ HOME: "/h" }, { [SPAWN_USER]: "60007" }), { HOME: "/h" });

    const env = { [SPAWN_USER]: me.username };
    const account = SpawnAccounts.configured(env);
    assert.ok(account !== null);
    assert.equal(account.name, me.username);
    assert.equal(account.uid, me.uid);
    assert.equal(account.gid, me.gid);
    assert.deepEqual(SpawnAccounts.options(env), { uid: me.uid, gid: me.gid });
    const composed = SpawnAccounts.environment({ HOME: "/elsewhere", PATH: "/bin" }, env);
    assert.equal(composed.USER, me.username);
    assert.equal(composed.LOGNAME, me.username);
    assert.equal(composed.HOME, account.home ?? "/elsewhere");
    assert.equal(composed.PATH, "/bin");

    assert.throws(() => SpawnAccounts.configured({ [SPAWN_USER]: "no-such-account-9c1f" }), new RegExp(`${SPAWN_USER}='no-such-account-9c1f' names no account`, "u"));
    assert.equal(Policy.isKey(SPAWN_USER), false);
});

test("{§executor-policy}: getent lookup error vs absent account vs valid record", () => {
    const missing = Object.assign(new Error("spawnSync getent ENOENT"), { code: "ENOENT" });
    const thrown = (() => { try { SpawnAccounts.resolve("alice", () => ({ error: missing, status: null, stdout: "" })); } catch (cause) { return cause as Error; } return null; })();
    assert.ok(thrown !== null);
    assert.equal(thrown.message, `${SPAWN_USER}='alice' was not resolved: the host's account lookup, \`getent passwd\`, did not run (spawnSync getent ENOENT); write uid[:gid] to name the account without a lookup.`);
    assert.equal(thrown.cause, missing);
    const failures: ReadonlyArray<readonly [string, ReturnType<Parameters<typeof SpawnAccounts.resolve>[1] & {}>, RegExp]> = [
        ["exited otherwise", { status: 1, stdout: "" }, /was not resolved: .* exited 1;/u],
        ["ended by a signal", { status: null, signal: "SIGKILL", stdout: "" }, /was not resolved: .* was ended by SIGKILL;/u],
        ["empty answer", { status: 0, stdout: "" }, /answered a record that is not this account's/u],
        ["another account's record", { status: 0, stdout: "bob:x:1001:1001::/home/bob:/bin/sh\n" }, /answered a record that is not this account's/u],
        ["a record without numeric ids", { status: 0, stdout: "alice:x:uid:gid::/home/alice:/bin/sh\n" }, /answered a record that is not this account's/u],
        ["a short record", { status: 0, stdout: "alice:x:1001\n" }, /answered a record that is not this account's/u],
    ];
    for (const [label, answer, expected] of failures) {
        assert.throws(() => SpawnAccounts.resolve("alice", () => answer), (error: unknown) =>
            error instanceof Error && expected.test(error.message) && !/names no account/u.test(error.message), label);
    }
    assert.throws(() => SpawnAccounts.resolve("alice", () => ({ status: 2, stdout: "" })),
        new RegExp(`^Error: ${SPAWN_USER}='alice' names no account on this host; write an account name or uid\\[:gid\\]\\.$`, "u"));
    assert.deepEqual(SpawnAccounts.resolve("alice", answered("alice:x:1001:1002:Alice A:/home/alice:/bin/sh\n")), { name: "alice", uid: 1001, gid: 1002, home: "/home/alice" });
    assert.deepEqual(SpawnAccounts.resolve("svc", answered("svc:*:498:498:::/usr/sbin/nologin\n")), { name: "svc", uid: 498, gid: 498, home: null });
    const never = (): never => { throw new Error("a bare id was looked up"); };
    assert.deepEqual(SpawnAccounts.resolve("60007:60008", never), { name: null, uid: 60007, gid: 60008, home: null });
});

test("{§executor-contract} splits words, preserves quotes/escapes, and rejects unterminated quoting", () => {
    assert.deepEqual(tokenizeArgv("status --short"), ["status", "--short"]);
    assert.deepEqual(tokenizeArgv("  log   -n  5 "), ["log", "-n", "5"]);
    assert.deepEqual(tokenizeArgv('commit -m "fix: the bug"'), ["commit", "-m", "fix: the bug"]);
    assert.deepEqual(tokenizeArgv("commit -m 'single quoted msg'"), ["commit", "-m", "single quoted msg"]);
    assert.deepEqual(tokenizeArgv('commit -m "costs $5 and `cmd`"'), ["commit", "-m", "costs $5 and `cmd`"]);
    assert.deepEqual(tokenizeArgv("status; rm -rf /"), ["status;", "rm", "-rf", "/"]);
    assert.deepEqual(tokenizeArgv("a\\ b"), ["a b"]);
    assert.deepEqual(tokenizeArgv('--title "a \\"quoted\\" title"'), ["--title", 'a "quoted" title']);
    assert.deepEqual(tokenizeArgv('commit --cleanup=""'), ["commit", "--cleanup="]);
    assert.throws(() => tokenizeArgv('commit -m "unterminated'), /unterminated double quote/);
    assert.throws(() => tokenizeArgv("commit -m 'unterminated"), /unterminated single quote/);
    assert.throws(() => tokenizeArgv("status\\"), /trailing backslash/);
});
