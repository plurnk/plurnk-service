import { spawn } from "node:child_process";
import { Results } from "@plurnk/plurnk-schemes";
import BaseExecutor from "./BaseExecutor.ts";
import ErrorDetail, { ERROR_DETAIL_LIMIT } from "./ErrorDetail.ts";
import Runtime from "./runtime.ts";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, SpawnArgs } from "./types.ts";

// KILL[code]: an abort reason carrying `{ signal }` (a Unix signal name or
// number) delivers exactly that signal, once, fire-and-forget — no escalation;
// the model asked for a specific code. Absent → null → the polite default.
const overrideSignal = (reason: unknown): NodeJS.Signals | number | null => {
    const sig = (reason as { signal?: unknown } | null | undefined)?.signal;
    if (typeof sig === "number") return sig;
    return typeof sig === "string" && sig.startsWith("SIG") ? sig as NodeJS.Signals : null;
};

// Loop-end housekeeping: an abort reason marked `{ housekeeping: true, graceMs }`
// (the consumer's run-completion teardown) escalates the polite SIGHUP to a hard
// SIGKILL after `graceMs` — the consumer's grace, sourced from its config, never
// a magic number here. Absent → null → no reap (a plain KILL is fire-and-forget).
const housekeepingGrace = (reason: unknown): number | null => {
    const r = reason as { housekeeping?: unknown; graceMs?: unknown } | null | undefined;
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
    // check (always available — e.g. node, where the daemon already IS the
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
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            return { available: false, detail: `${ERROR_DETAIL_LIMIT} must be set to a non-negative integer.` };
        }
        // No internal deadline — the per-probe timeout is the consumer's (SPEC
        // §2.2), handed in as `signal`. We pass it to spawn so a resolved or
        // timed-out probe REAPS its child at once; no in-flight `--version` write
        // can EPIPE after host teardown (plurnk-execs#16). stdin/stderr are
        // /dev/null'd — only stdout is read, for the version detail.
        return new Promise<RuntimeAvailability>((resolve) => {
            let settled = false;
            const done = (r: RuntimeAvailability): void => { if (!settled) { settled = true; resolve(r); } };
            let out = "";
            const child = spawn(bin, ["--version"], { signal, stdio: ["ignore", "pipe", "ignore"] });
            child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
            child.on("error", (err) => done((err as NodeJS.ErrnoException).code === "ABORT_ERR"
                ? { available: false }
                : { available: false, detail: `${bin} not found on PATH` }));
            child.on("close", (code) => done(code === 0
                ? { available: true, detail: ErrorDetail.preview(out.trim().split("\n")[0], detailLimit) || undefined }
                : { available: false, detail: `${bin} --version exited ${code}` }));
        });
    }

    // Translate the matched tag + command + target into spawn args. Default
    // delegates to Runtime.resolve (sh/node/python); subclasses with their own
    // interpreter table (e.g. the common-REPL harness) override this — and so
    // inherit run()'s streaming + process-group abort handling rather than
    // reimplementing it. When `target` is set, the body becomes the program's
    // stdin (plurnk-execs#15) — the plugin maps it; the parent parses nothing.
    protected spawnArgs(runtime: string, command: string, target: string | null): SpawnArgs {
        return Runtime.resolve(runtime, command, target);
    }

    run({ runtime, command, cwd, target, env, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState("stdout", "errored");
            setState("stderr", "errored");
            return Promise.resolve(ErrorDetail.invalidConfiguration("executor:subprocess"));
        }
        const { cmd, args, useShell, stdin } = this.spawnArgs(runtime, command, target);
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
            // option, which only kills the direct child (plurnk-execs#4).
            // env: consumer-scoped when provided (drops plurnk's own secrets,
            // plurnk-execs#8); host env inherited by default for back-compat.
            // fd0: a provided stdin body gets a pipe (written + EOF'd below); NO
            // stdin body gets /dev/null, never a dangling open pipe (#519). A bare
            // interpreter reached via the sh fallthrough (`EXEC[python3]` → `sh -c
            // "python3 …"`) reads its program from fd0 — an unclosed pipe there
            // never EOFs, so the child blocks in the kernel (unix_stream_read) and
            // the exec obligation never resolves: the loop hangs until a client
            // cancel. /dev/null delivers immediate EOF, so it fails fast instead.
            // (The probe path already uses this discipline; matches it.)
            const child = spawn(cmd, args, {
                stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
                shell: useShell, cwd: cwd ?? undefined, env: env ?? process.env, detached: true,
            });

            // Filter-style runtimes feed their program/input via stdin; closing
            // it also delivers EOF (awk BEGIN-only). Left untouched otherwise.
            // A fast-exiting child (`jq` on a small file — dead in milliseconds)
            // can already be gone when this write lands; the end() then EPIPEs,
            // and with no 'error' listener the rejection escapes and fails the
            // consumer even though the exec succeeded (#23 — the probe lane got
            // the same guard in #16). The child's exit code is the truth; a
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
                // KILL[code]: deliver exactly that signal, once, fire-and-forget.
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
                    `Could not start '${runtime}': ${ErrorDetail.preview(err, detailLimit)}`,
                    { exitCode: -1 },
                    {
                        runtime,
                        stage: "spawn",
                        errorCode: (err as NodeJS.ErrnoException).code,
                        retryable: false,
                    },
                ), "errored");
            });

            child.on("close", (code) => {
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
                const ok = code === 0;
                finish(ok
                    ? { status: 200, exitCode: 0 }
                    : Results.failure(
                        "executor:subprocess",
                        "nonzero-exit",
                        500,
                        `'${runtime}' exited with code ${code ?? -1}.`,
                        { exitCode: code ?? -1 },
                        {
                            runtime,
                            stage: "execution",
                            recovery: "Inspect the stdout and stderr channels before correcting the command.",
                            retryable: false,
                        },
                    ), ok ? "closed" : "errored");
            });
        });
    }
}
