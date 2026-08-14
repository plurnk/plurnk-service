import { spawn } from "node:child_process";
import { BaseExecutor, ErrorDetail, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

// jq executor — shells the system `jq` binary (no third-party JSON-filter lib).
// Invocation model:
//   body = the jq program (defaults to `.` identity if empty)
//   target = optional data source; present → jq reads that file; absent → `-n`
//            (null input) so the body is self-contained.
// So `## EXEC0 [jq] (data.json)` filters a file with its body, while a targetless
// `## EXEC0 [jq]` runs its body against null input. A tag-addressed prior stream can be the target
// once the consumer resolves it to a path ({§executor-output-address}).
//
// jq is a leaf process (no shell, no grandchildren), so a plain signal-based
// spawn is sufficient — no process-group machinery needed. It's a pure filter
// (no host writes / exec), so `effect` is `pure`/`read` and bypasses proposal
// admission; output still follows the universal background stream path
// ({§executor-effect}).
export default class Jq extends BaseExecutor {
    // jq is a streaming filter: a multi-value program emits one value per line.
    // run() spawns with -c so each value stays compact on its own line, making
    // {§executor-channels} The channel is honest JSONL; a single value is a valid
    // one-line JSONL document too.
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/jsonl" } };
    }

    // Inline/`-n` → pure; a target data source → read ({§executor-effect}).
    override effect(target: string | null): Effect {
        return target ? "read" : "pure";
    }

    override async probe(signal?: AbortSignal): Promise<RuntimeAvailability> {
        if (signal?.aborted) return { available: false };
        return new Promise((resolve) => {
            let out = "";
            // Honor the consumer's per-probe signal so a resolved/timed-out probe
            // reaps the child ({§executor-probe}); /dev/null stdin+stderr.
            const child = spawn("jq", ["--version"], { signal, stdio: ["ignore", "pipe", "ignore"] });
            child.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
            child.on("error", (err) => resolve((err as NodeJS.ErrnoException).code === "ABORT_ERR"
                ? { available: false }
                : { available: false, detail: "jq not on PATH" }));
            child.on("close", (code) => resolve(code === 0
                ? { available: true, detail: out.trim() || "jq" }
                : { available: false, detail: `jq --version exited ${code}` }));
        });
    }

    async run({ body, cwd, target, env, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:jq");
        }
        const program = body.trim() || ".";
        // target = the data-source file; spawn resolves a relative one against cwd
        // (the workspace). Absent → -n, the program stands alone
        // ({§executor-sinks}).
        // -c keeps each value compact on its own line so multi-value output is
        // honest JSONL.
        const args = target !== null ? ["-c", program, target] : ["-c", "-n", program];

        return new Promise<ExecResult>((resolve) => {
            let settled = false;
            const finish = (result: ExecResult, state: "closed" | "errored"): void => {
                if (settled) return;
                settled = true;
                setState("results", state);
                resolve(result);
            };
            let err = "";
            // jq can read the environment (`env`, `$ENV`), so honor the
            // consumer's scoped env when provided ({§exec-env-scoped}).
            const child = spawn("jq", args, { signal, cwd: cwd ?? undefined, env: env ?? process.env });
            child.stdout?.on("data", (c: Buffer) => write("results", c.toString("utf8")));
            child.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
            child.on("error", (e) => {
                if ((e as NodeJS.ErrnoException).code === "ABORT_ERR") {
                    finish(Results.failure(
                        "executor:jq",
                        "cancelled",
                        499,
                        "jq execution was cancelled.",
                        {},
                        {
                            stage: "execution",
                            retryable: false,
                        },
                    ), "errored");
                    return;
                }
                finish(Results.failure(
                    "executor:jq",
                    "spawn-failed",
                    500,
                    `Could not start jq: ${ErrorDetail.preview(e, detailLimit)}`,
                    {},
                    {
                        stage: "spawn",
                        errorCode: (e as NodeJS.ErrnoException).code,
                        retryable: false,
                    },
                ), "errored");
            });
            child.on("close", (code) => {
                if (signal.aborted) {
                    finish(Results.failure(
                        "executor:jq",
                        "cancelled",
                        499,
                        "jq execution was cancelled.",
                        {},
                        {
                            stage: "execution",
                            retryable: false,
                        },
                    ), "errored");
                    return;
                }
                if (code === 0) { finish({ status: 200 }, "closed"); return; }
                finish(Results.failure(
                    "executor:jq",
                    "jq-error",
                    500,
                    err.trim() === ""
                        ? `jq exited with code ${code ?? -1}.`
                        : ErrorDetail.preview(err.trim(), detailLimit),
                    { exitCode: code ?? -1 },
                    {
                        stage: "execution",
                        recovery: "Correct the jq program or its input.",
                        retryable: false,
                    },
                ), "errored");
            });
        });
    }
}
