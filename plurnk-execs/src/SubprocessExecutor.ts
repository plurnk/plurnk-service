import { spawn } from "node:child_process";
import BaseExecutor from "./BaseExecutor.ts";
import { resolveRuntime } from "./runtime.ts";
import type { ChannelDecl, ExecArgs, ExecResult, RuntimeAvailability } from "./types.ts";

// Grace period between SIGTERM and SIGKILL when tearing down an aborted process
// group — long enough for a well-behaved process to clean up, bounded so a
// process ignoring SIGTERM can't wedge cancellation.
const ABORT_GRACE_MS = 2000;

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

    override async probe(): Promise<RuntimeAvailability> {
        const bin = this.binary;
        if (bin === null) return { available: true };
        return new Promise<RuntimeAvailability>((resolve) => {
            let settled = false;
            const done = (r: RuntimeAvailability): void => { if (!settled) { settled = true; resolve(r); } };
            let out = "";
            const child = spawn(bin, ["--version"], { signal: AbortSignal.timeout(3000) });
            child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
            child.on("error", (err) => done({
                available: false,
                detail: (err as NodeJS.ErrnoException).code === "ABORT_ERR"
                    ? `${bin} probe timed out`
                    : `${bin} not found on PATH`,
            }));
            child.on("close", (code) => done(code === 0
                ? { available: true, detail: out.trim().split("\n")[0] || undefined }
                : { available: false, detail: `${bin} --version exited ${code}` }));
        });
    }

    run({ runtime, command, cwd, signal, write, setState, emit }: ExecArgs): Promise<ExecResult> {
        const { cmd, args, useShell } = resolveRuntime(runtime, command);
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
            const child = spawn(cmd, args, { shell: useShell, cwd: cwd ?? undefined, detached: true });

            const killGroup = (sig: NodeJS.Signals): void => {
                if (child.pid === undefined) return;
                try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
            };
            const onAbort = (): void => {
                killGroup("SIGTERM");
                // Escalate if the group ignores SIGTERM. `close` fires once the
                // pipes drain, which now happens because the grandchildren die.
                killTimer = setTimeout(() => killGroup("SIGKILL"), ABORT_GRACE_MS);
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
