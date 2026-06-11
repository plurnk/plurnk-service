import { spawn } from "node:child_process";
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

// jq executor — shells the system `jq` binary (no third-party JSON-filter lib).
// Invocation model:
//   body = the jq program (defaults to `.` identity if empty)
//   target = optional data source; present → jq reads that file; absent → `-n`
//            (null input) so the body is self-contained.
// So `EXEC[jq](data.json):.users[].name` filters a file, `EXEC[jq]:[1,2,3]|add`
// computes inline, `EXEC[jq](exec://…):.items[]` filters a prior op's output once
// the service resolves the scheme target to a path (plurnk-service#201).
//
// jq is a leaf process (no shell, no grandchildren), so a plain signal-based
// spawn is sufficient — no process-group machinery needed. It's a pure filter
// (no host writes / exec), so `effect` is `pure`/`read` — always auto-run.
export default class Jq extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // Inline/`-n` → pure; a file-path data source → read (filesystem). Both auto-run.
    override effect(target: string | null): Effect {
        return target ? "read" : "pure";
    }

    override async probe(): Promise<RuntimeAvailability> {
        return new Promise((resolve) => {
            let out = "";
            const child = spawn("jq", ["--version"], { signal: AbortSignal.timeout(3000) });
            child.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
            child.on("error", () => resolve({ available: false, detail: "jq not on PATH" }));
            child.on("close", (code) => resolve(code === 0
                ? { available: true, detail: out.trim() || "jq" }
                : { available: false, detail: `jq --version exited ${code}` }));
        });
    }

    async run({ command, cwd, signal, write, setState, emit }: ExecArgs): Promise<ExecResult> {
        const program = command.trim() || ".";
        const path = cwd && cwd.length > 0 ? cwd : null;
        // Target present → jq reads the file; absent → -n, the program stands alone.
        const args = path !== null ? [program, path] : ["-n", program];

        return new Promise<ExecResult>((resolve) => {
            let settled = false;
            const finish = (result: ExecResult, state: "closed" | "errored"): void => {
                if (settled) return;
                settled = true;
                setState("results", state);
                resolve(result);
            };
            let err = "";
            const child = spawn("jq", args, { signal });
            child.stdout?.on("data", (c: Buffer) => write("results", c.toString("utf8")));
            child.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
            child.on("error", (e) => {
                if ((e as NodeJS.ErrnoException).code === "ABORT_ERR") { finish({ status: 499 }, "errored"); return; }
                emit({ source: "exec:jq", kind: "jq_spawn_failed", message: e.message });
                finish({ status: 500 }, "errored");
            });
            child.on("close", (code) => {
                if (signal.aborted) { finish({ status: 499 }, "errored"); return; }
                if (code === 0) { finish({ status: 200 }, "closed"); return; }
                emit({ source: "exec:jq", kind: "jq_error", message: err.trim() || `jq exited ${code}` });
                finish({ status: 500 }, "errored");
            });
        });
    }
}
