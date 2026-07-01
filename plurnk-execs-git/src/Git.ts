import { spawn } from "node:child_process";
import { SubprocessExecutor } from "@plurnk/plurnk-execs";
import type { RuntimeAvailability, SpawnArgs } from "@plurnk/plurnk-execs";
import { tokenizeArgv } from "./tokenizeArgv.ts";

// git + GitHub-CLI executor. Claims the `git` and `gh` tags; the tag IS the
// binary, so it shells the system `git`/`gh` with the command tokenized into
// real argv (never a shell line — see tokenizeArgv). No third-party git/gh
// library: the system binaries are the source of truth.
//
// `effect` is `host` for every command (inherited) — proposal-gated. That's not
// a simplification, it's required: `effect(target)` classifies the TARGET only
// and must never inspect the command, so `git status` and `git push` are
// indistinguishable to it. Service owns the proposal/confirm/membership gating
// (plurnk-execs#5). All run/stream/abort behavior is inherited from
// SubprocessExecutor.
export default class Git extends SubprocessExecutor {
    protected override spawnArgs(runtime: string, command: string): SpawnArgs {
        // runtime is "git" or "gh" — the tag is the executable.
        return { cmd: runtime, args: tokenizeArgv(command), useShell: false };
    }

    // Per-tag availability: `git` needs the binary; `gh` needs the binary AND an
    // authenticated session. (Correct only once the consumer probes per-tag, not
    // per-package — plurnk-service#185.)
    override async probe(signal?: AbortSignal): Promise<RuntimeAvailability> {
        if (this.runtime === "gh") {
            return runProbe("gh", ["auth", "status"], "gh authenticated",
                "gh present but not authenticated — run `gh auth login`", "gh not on PATH", signal);
        }
        return runProbe("git", ["--version"], undefined, "git --version failed", "git not on PATH", signal);
    }
}

// Spawn a probe command; resolve availability from its exit. Async so the
// consumer's per-probe timeout can race it (a hung `gh auth status` mustn't
// wedge boot).
const runProbe = (
    bin: string,
    args: string[],
    okDetail: string | undefined,
    nonzeroDetail: string,
    missingDetail: string,
    signal?: AbortSignal,
): Promise<RuntimeAvailability> =>
    new Promise((resolve) => {
        if (signal?.aborted) { resolve({ available: false, detail: missingDetail }); return; }
        let out = "";
        // Honor the consumer's per-probe signal so a resolved/timed-out probe
        // reaps the child (plurnk-execs#16); /dev/null stdin+stderr.
        const child = spawn(bin, args, { signal, stdio: ["ignore", "pipe", "ignore"] });
        child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
        child.on("error", () => resolve({ available: false, detail: missingDetail }));
        child.on("close", (code) => resolve(code === 0
            ? { available: true, detail: okDetail ?? (out.trim().split("\n")[0] || undefined) }
            : { available: false, detail: nonzeroDetail }));
    });
