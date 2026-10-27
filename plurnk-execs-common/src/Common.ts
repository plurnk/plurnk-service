import { spawnSync } from "node:child_process";
import { isExecutionOp, type RuntimeTag } from "@plurnk/plurnk-contracts";
import { SubprocessExecutor, SpawnAccounts, Shell, tokenizeArgv } from "@plurnk/plurnk-execs";
import type { RuntimeAvailability, SpawnArgs } from "@plurnk/plurnk-execs";

// Per-interpreter spawn recipe. `bin` is the executable (probed for presence).
interface Recipe {
    bin: string;
    arg: (command: string) => string[];
    // node is guaranteed (the daemon IS node) — reported available without a
    // PATH probe. Everything else is detected.
    alwaysAvailable?: boolean;
}

const RECIPES: Readonly<Record<string, Recipe>> = Object.freeze({
    // Subprocess floor. `sh`'s bin is the shell the environment names ({§executor-subprocess}), resolved at use.
    sh: { bin: "sh", arg: (c) => ["-c", c] },
    js: { bin: "node", arg: (c) => ["-e", c], alwaysAvailable: true },
    python3: { bin: "python3", arg: (c) => ["-c", c] },
});

// Exposed for tests / consumers wanting the candidate set.
export const RUNTIME_TAGS: readonly RuntimeTag[] = Object.freeze(Object.keys(RECIPES).filter(isExecutionOp));

const onPath = (bin: string): boolean =>
    spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin], { ...SpawnAccounts.options() }).status === 0; // {§executor-policy}

export default class Common extends SubprocessExecutor {
    protected override spawnArgs(runtime: string, command: string, target: string | null = null): SpawnArgs {
        const r = Common.#recipe(runtime);
        if (r === undefined) throw new Error(`plurnk-execs-common received unclaimed runtime tag '${runtime}'`);
        // With a target the program IS the target and the body is its arguments,
        // tokenized by shell quoting ({§executor-subprocess}, {§executor-contract}).
        // The interpreter reads the file; no executable bit is consulted or changed.
        if (target !== null) {
            return { cmd: r.bin, args: [target, ...tokenizeArgv(command)], useShell: false };
        }
        return { cmd: r.bin, args: r.arg(command), useShell: false };
    }

    // {§executor-subprocess} `sh` runs the environment's shell; every other recipe is fixed.
    static #recipe(runtime: string): Recipe | undefined {
        const r = RECIPES[runtime];
        return runtime === "sh" && r !== undefined ? { ...r, bin: Shell.current().path } : r;
    }

    override async probe(): Promise<RuntimeAvailability> {
        const r = Common.#recipe(this.runtime);
        if (r === undefined) return { available: false, detail: `unknown runtime '${this.runtime}'` };
        if (r.alwaysAvailable) return { available: true, detail: r.bin === "node" ? process.version : r.bin };
        return onPath(r.bin)
            ? { available: true, detail: r.bin }
            : { available: false, detail: `${r.bin} not on PATH` };
    }
}
