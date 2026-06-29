import { spawn } from "node:child_process";
import BaseExecutor from "./BaseExecutor.ts";
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

// Concrete BaseExecutor for subprocess runtimes (sh, node, python, …). Spawns
// via resolveRuntime, streams the process's stdout/stderr into the declared
// channels, honors cancellation, and reports the exit code. The sibling
// packages (plurnk-execs-sh / -node / -python) subclass this and differ only
// in which runtime tags they claim in their `plurnk.runtimes[]` manifest.
//
// This is the destination of plurnk-service's legacy `streamShellCommand`
// (service#174 Q2): the scheme migrates onto it on its own timeline; until
// then both paths coexist.
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

    override async probe(): Promise<RuntimeAvailability> {
        const bin = this.binary;
        if (bin === null) return { available: true };
        // No internal deadline. The per-probe timeout is the consumer's — set
        // once from its env and applied uniformly across the family (SPEC §2.2);
        // the executor stays oblivious to deadlines here exactly as it does for
        // run() (SPEC §2.5). A timed-out probe is surfaced consumer-side as the
        // rejection→unavailable it already treats any probe failure as.
        return new Promise<RuntimeAvailability>((resolve) => {
            let settled = false;
            const done = (r: RuntimeAvailability): void => { if (!settled) { settled = true; resolve(r); } };
            let out = "";
            const child = spawn(bin, ["--version"]);
            child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
            child.on("error", () => done({ available: false, detail: `${bin} not found on PATH` }));
            child.on("close", (code) => done(code === 0
                ? { available: true, detail: out.trim().split("\n")[0] || undefined }
                : { available: false, detail: `${bin} --version exited ${code}` }));
        });
    }

    // Translate the matched tag + command into spawn args. Default delegates to
    // Runtime.resolve (sh/node/python); subclasses with their own interpreter
    // table (e.g. the common-REPL harness) override this — and so inherit run()'s
    // streaming + process-group abort handling rather than reimplementing it.
    protected spawnArgs(runtime: string, command: string): SpawnArgs {
        return Runtime.resolve(runtime, command);
    }

    run({ runtime, command, cwd, env, signal, write, setState, emit }: ExecArgs): Promise<ExecResult> {
        const { cmd, args, useShell, stdin } = this.spawnArgs(runtime, command);
        return new Promise<ExecResult>((resolve) => {
            // Already cancelled before we start — don't launch a doomed process.
            if (signal.aborted) {
                setState("stdout", "errored");
                setState("stderr", "errored");
                resolve({ status: 499, exitCode: -1 });
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
            const child = spawn(cmd, args, { shell: useShell, cwd: cwd ?? undefined, env: env ?? process.env, detached: true });

            // Filter-style runtimes feed their program/input via stdin; closing
            // it also delivers EOF (awk BEGIN-only). Left untouched otherwise.
            if (stdin !== undefined) child.stdin?.end(stdin);

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
                // The process could not be started — a framework-level failure
                // the model benefits from seeing as telemetry (a nonzero exit,
                // by contrast, is the program's own result and lives on stderr).
                emit({ source: `exec:${runtime}`, kind: "spawn_failed", message: err.message });
                finish({ status: 500, exitCode: -1 }, "errored");
            });

            child.on("close", (code) => {
                if (signal.aborted) {
                    finish({ status: 499, exitCode: code ?? -1 }, "errored");
                    return;
                }
                const ok = code === 0;
                finish({ status: ok ? 200 : 500, exitCode: code ?? -1 }, ok ? "closed" : "errored");
            });
        });
    }
}
