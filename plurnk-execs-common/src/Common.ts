import { spawnSync } from "node:child_process";
import { SubprocessExecutor } from "@plurnk/plurnk-execs";
import type { RuntimeAvailability, SpawnArgs } from "@plurnk/plurnk-execs";

// Per-interpreter spawn recipe. `bin` is the executable (probed for presence).
// The command is carried one of three ways:
//   - arg(command): eval-flag interpreters (perl -e, ruby -e, php -r, …)
//   - stdin:        filters that read their program from stdin (bc, tclsh)
//   - bare:         program as a positional arg with empty stdin → EOF (awk BEGIN)
interface Recipe {
    bin: string;
    arg?: (command: string) => string[];
    stdin?: boolean;
    bare?: boolean;
}

const RECIPES: Readonly<Record<string, Recipe>> = Object.freeze({
    perl: { bin: "perl", arg: (c) => ["-e", c] },
    ruby: { bin: "ruby", arg: (c) => ["-e", c] },
    php: { bin: "php", arg: (c) => ["-r", c] },
    lua: { bin: "lua", arg: (c) => ["-e", c] },
    deno: { bin: "deno", arg: (c) => ["eval", c] },
    bun: { bin: "bun", arg: (c) => ["-e", c] },
    tcl: { bin: "tclsh", stdin: true },
    bc: { bin: "bc", stdin: true },
    awk: { bin: "awk", bare: true },
});

// Exposed for tests / consumers wanting the candidate set.
export const RUNTIME_TAGS: readonly string[] = Object.freeze(Object.keys(RECIPES));

// Operator kill-switch: PLURNK_EXECS_<TAG>=0 (or "false") disables a tag even
// when its interpreter is installed. (Honored here locally; the cross-family
// equivalent is service registry policy.)
const isDisabled = (tag: string): boolean => {
    const v = process.env[`PLURNK_EXECS_${tag.toUpperCase()}`];
    return v === "0" || v?.toLowerCase() === "false";
};

// PATH presence via POSIX `command -v` — robust across interpreters that don't
// support `--version` (tclsh, bc, some awks). bin is from the fixed table above.
const onPath = (bin: string): boolean =>
    spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin]).status === 0;

// Detection harness: one package claiming the common-REPL tags. probe() lights
// up only the interpreters present on this host (and not operator-disabled), so
// the consumer offers the model exactly what the platform has — "plurnk supports
// the host's REPLs out of the box". All run arbitrary code → effect `host`
// (inherited, proposal-gated). Reuses SubprocessExecutor's run() (streaming +
// process-group abort) via the spawnArgs() hook.
export default class Common extends SubprocessExecutor {
    protected override spawnArgs(runtime: string, command: string): SpawnArgs {
        const r = RECIPES[runtime];
        if (r === undefined) throw new Error(`plurnk-execs-common received unclaimed runtime tag '${runtime}'`);
        // Trailing newline so line-oriented readers (bc, tclsh) evaluate the
        // final line before EOF rather than erroring on an unterminated line.
        if (r.stdin) return { cmd: r.bin, args: [], useShell: false, stdin: `${command}\n` };
        if (r.bare) return { cmd: r.bin, args: [command], useShell: false, stdin: "" };
        return { cmd: r.bin, args: r.arg!(command), useShell: false };
    }

    override async probe(): Promise<RuntimeAvailability> {
        const r = RECIPES[this.runtime];
        if (r === undefined) return { available: false, detail: `unknown runtime '${this.runtime}'` };
        if (isDisabled(this.runtime)) {
            return { available: false, detail: `disabled (PLURNK_EXECS_${this.runtime.toUpperCase()}=0)` };
        }
        return onPath(r.bin)
            ? { available: true, detail: r.bin }
            : { available: false, detail: `${r.bin} not on PATH` };
    }
}
