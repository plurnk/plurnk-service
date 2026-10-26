import { errnoCode, isRecord } from "@plurnk/plurnk-contracts";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { Results } from "@plurnk/plurnk-schemes";
import BaseExecutor from "./BaseExecutor.ts";
import ErrorDetail from "./ErrorDetail.ts";
import Runtime from "./runtime.ts";
import InvocationMetadata from "./InvocationMetadata.ts";
import SpawnAccounts from "./SpawnAccount.ts";
import { CommandSyntaxError } from "./tokenizeArgv.ts";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, SpawnArgs } from "./types.ts";

// KILL signal: an abort reason carrying `{ signal }` (a Unix signal name or
// number) delivers exactly that signal, once, fire-and-forget — no escalation;
// the model asked for a specific code. Absent → null → the polite default.
const isSignalName = (value: string): value is NodeJS.Signals => Object.hasOwn(constants.signals, value);
const overrideSignal = (reason: unknown): NodeJS.Signals | number | null => {
    const sig = isRecord(reason) ? reason.signal : undefined;
    if (typeof sig === "number") return sig;
    return typeof sig === "string" && isSignalName(sig) ? sig : null;
};

// Loop-end housekeeping: an abort reason marked `{ housekeeping: true, graceMs }`
// (the consumer's loop-completion teardown) escalates the polite SIGHUP to a hard
// SIGKILL after `graceMs` — the consumer's grace, sourced from its config, never
// a magic number here. Absent → null → no reap (a plain KILL is fire-and-forget).
const housekeepingGrace = (reason: unknown): number | null => {
    const r = isRecord(reason) ? reason : undefined;
    return r?.housekeeping === true && typeof r.graceMs === "number" ? r.graceMs : null;
};

// Concrete BaseExecutor for subprocess runtimes. It streams stdout and stderr,
// honors cancellation, and reports the exit code. Runtime packages subclass it
// to claim tags and provide spawn recipes.
export default class SubprocessExecutor extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return {
            stdout: { mimetype: "text/stream" },
            stderr: { mimetype: "text/stream" },
        };
    }

    // The executable this runtime depends on, for probe(). `null` = nothing to
    // check (always available — e.g. js, where the daemon already IS the
    // runtime). Subclasses naming an external interpreter override this.
    protected get binary(): string | null {
        return null;
    }

    // Subprocess runtimes execute code on the host — always `host`.
    override effect(_target: string | null): Effect {
        return "host";
    }

    override async probe(signal?: AbortSignal): Promise<RuntimeAvailability> {
        const bin = this.binary;
        if (bin === null) return { available: true };
        if (signal?.aborted) return { available: false };
        // No internal deadline — the per-probe timeout is the consumer's
        // ({§executor-probe}), handed in as `signal`. We pass it to spawn so a
        // resolved or
        // timed-out probe REAPS its child at once; no in-flight `--version` write
        // can EPIPE after host teardown. stdin/stderr are
        // /dev/null'd — only stdout is read, for the version detail.
        return new Promise<RuntimeAvailability>((resolve) => {
            let settled = false;
            const done = (r: RuntimeAvailability): void => { if (!settled) { settled = true; resolve(r); } };
            let out = "";
            // {§executor-spawn-account} — probed as the account the runtime will run as.
            const child = spawn(bin, ["--version"], { signal, stdio: ["ignore", "pipe", "ignore"], ...SpawnAccounts.options() });
            child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
            child.on("error", (err) => done(errnoCode(err) === "ABORT_ERR"
                ? { available: false }
                : { available: false, detail: `${bin} not found on PATH` }));
            child.on("close", (code) => done(code === 0
                ? { available: true, detail: ErrorDetail.preview(out.trim().split("\n")[0]) || undefined }
                : { available: false, detail: `${bin} --version exited ${code}` }));
        });
    }

    // Translate the matched tag + command + target into spawn args. Default
    // delegates to Runtime.resolve (sh/js/python3); subclasses with their own
    // interpreter table (e.g. the common-REPL harness) override this — and so
    // inherit run()'s streaming + process-group abort handling rather than
    // reimplementing it. When `target` is set, the body is tokenized into argv
    // ({§executor-subprocess-routing}, {§executor-argv-tokenizer}).
    protected spawnArgs(runtime: string, command: string, target: string | null): SpawnArgs {
        return Runtime.resolve(runtime, command, target);
    }

    run({ runtime, body, metadata, cwd, target, env, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        const parsed = InvocationMetadata.parse({ runtime, body, metadata, cwd, target });
        if ("failure" in parsed) {
            setState("stdout", "errored");
            setState("stderr", "errored");
            return Promise.resolve(parsed.failure);
        }
        let spawnArgs: SpawnArgs;
        try {
            spawnArgs = this.spawnArgs(runtime, body, target);
        } catch (cause) {
            if (!(cause instanceof CommandSyntaxError)) throw cause;
            setState("stdout", "errored");
            setState("stderr", "errored");
            return Promise.resolve(Results.failure(
                "executor:subprocess",
                "invalid-command",
                400,
                `Could not parse the '${runtime}' command: ${ErrorDetail.preview(cause)}.`,
                { exitCode: -1 },
                {
                    runtime,
                    stage: "input-validation",
                    ...(cause.recovery === null ? {} : { recovery: cause.recovery }),
                    retryable: false,
                },
            ));
        }
        const { cmd, args, useShell, stdin } = spawnArgs;
        return new Promise<ExecResult>((resolve) => {
            // Already cancelled before we start — don't launch a doomed process.
            if (signal.aborted) {
                setState("stdout", "errored");
                setState("stderr", "errored");
                resolve(Results.failure(
                    "executor:subprocess",
                    "cancelled",
                    499,
                    `Execution of '${runtime}' was cancelled before it started.`,
                    { exitCode: -1 },
                    {
                        runtime,
                        stage: "execution",
                        retryable: false,
                    },
                ));
                return;
            }

            let settled = false;
            let killTimer: NodeJS.Timeout | undefined;

            // `detached` makes the child its own process-group leader, so abort
            // can signal the WHOLE group (`-pid`) — reaching shell grandchildren
            // (e.g. the `sleep` in `sh -c "sleep 30"`) that a bare SIGTERM to the
            // direct child orphans, leaking the process and its stdout pipe. We
            // drive cancellation manually rather than via spawn's `signal`
            // option, which only kills the direct child ({§executor-cancellation}).
            // env: consumer-scoped when provided (drops plurnk's own secrets,
            // {§exec-env-scoped}); host env inherited when absent.
            // fd0: a provided stdin body gets a pipe (written + EOF'd below); NO
            // stdin body gets /dev/null, never a dangling open pipe. A bare
            // interpreter reached through a generic runtime reads its program from
            // fd0 — an unclosed pipe there
            // never EOFs, so the child blocks in the kernel (unix_stream_read) and
            // the exec obligation never resolves: the loop hangs until a client
            // cancel. /dev/null delivers immediate EOF, so it fails fast instead.
            // (The probe path already uses this discipline; matches it.)
            // {§executor-spawn-account} — the child runs as the configured account, with its name in its environment.
            const child = spawn(cmd, args, {
                stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
                shell: useShell, cwd: cwd ?? undefined, env: SpawnAccounts.environment(env ?? process.env), detached: true,
                ...SpawnAccounts.options(),
            });

            // Filter-style runtimes feed their program/input via stdin; closing
            // it also delivers EOF (awk BEGIN-only). Left untouched otherwise.
            // A fast-exiting child (dead in milliseconds)
            // can already be gone when this write lands; the end() then EPIPEs,
            // and with no 'error' listener the rejection escapes and fails the
            // consumer even though the exec succeeded. The child's exit code is
            // the truth; a
            // stdin write racing child exit is expected noise, not a failure.
            if (stdin !== undefined && child.stdin) {
                child.stdin.on("error", () => { /* EPIPE-class race with exit — outcome is the exit code */ });
                child.stdin.end(stdin);
            }

            const killGroup = (sig: NodeJS.Signals | number): void => {
                if (child.pid === undefined) return;
                try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
            };
            const onAbort = (): void => {
                const reason = signal.reason;
                // A KILL signal delivers exactly that signal once, fire-and-forget.
                const override = overrideSignal(reason);
                if (override !== null) { killGroup(override); return; }
                // Default KILL is the polite ask — SIGHUP, once. We trust the
                // model; whether the process then dies is its concern, not ours.
                killGroup("SIGHUP");
                // Loop-end housekeeping ONLY: hard-kill the straggler after the
                // consumer's grace. `close` fires once the group's pipes drain.
                const graceMs = housekeepingGrace(reason);
                if (graceMs !== null) killTimer = setTimeout(() => killGroup("SIGKILL"), graceMs);
            };
            const finish = (result: ExecResult, state: "closed" | "errored"): void => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                signal.removeEventListener("abort", onAbort);
                setState("stdout", state);
                setState("stderr", state);
                resolve(result);
            };

            signal.addEventListener("abort", onAbort, { once: true });
            child.stdout?.on("data", (chunk: Buffer) => write("stdout", chunk.toString("utf8")));
            child.stderr?.on("data", (chunk: Buffer) => write("stderr", chunk.toString("utf8")));

            child.on("error", (err) => {
                finish(Results.failure(
                    "executor:subprocess",
                    "spawn-failed",
                    500,
                    `Could not start '${runtime}': ${ErrorDetail.preview(err)}`,
                    { exitCode: -1 },
                    {
                        runtime,
                        stage: "spawn",
                        errorCode: errnoCode(err),
                        retryable: false,
                    },
                ), "errored");
            });

            child.on("close", (code, terminatedBy) => {
                if (signal.aborted) {
                    finish(Results.failure(
                        "executor:subprocess",
                        "cancelled",
                        499,
                        `Execution of '${runtime}' was cancelled.`,
                        { exitCode: code ?? -1 },
                        {
                            runtime,
                            stage: "execution",
                            retryable: false,
                        },
                    ), "errored");
                    return;
                }
                // {§executor-results} — an exit code is the command's answer, whatever its value.
                if (code !== null) { finish({ status: 200, exitCode: code }, "closed"); return; }
                finish(Results.failure(
                    "executor:subprocess",
                    "terminated-by-signal",
                    500,
                    `'${runtime}' was terminated by ${terminatedBy ?? "a signal"}.`,
                    { exitCode: -1 },
                    {
                        runtime,
                        stage: "execution",
                        ...(terminatedBy === null ? {} : { signal: terminatedBy }),
                        retryable: false,
                    },
                ), "errored");
            });
        });
    }
}
