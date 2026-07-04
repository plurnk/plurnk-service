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
    // node is guaranteed (the daemon IS node) — reported available without a
    // PATH probe. Everything else is detected.
    alwaysAvailable?: boolean;
}

const RECIPES: Readonly<Record<string, Recipe>> = Object.freeze({
    // Subprocess floor (folded in from the former -sh / -node / -python packages).
    sh: { bin: "sh", arg: (c) => ["-c", c] },
    bash: { bin: "bash", arg: (c) => ["-c", c] },
    node: { bin: "node", arg: (c) => ["-e", c], alwaysAvailable: true },
    // `python` IS python3 — the only Python we offer. No `python` (2.x) bin and
    // no `python3` alias: the model gets no path to an obsolete interpreter.
    python: { bin: "python3", arg: (c) => ["-c", c] },
    // Detected host interpreters.
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

// PATH presence via POSIX `command -v` — robust across interpreters that don't
// support `--version` (tclsh, bc, some awks). bin is from the fixed table above.
const onPath = (bin: string): boolean =>
    spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin]).status === 0;

// Detection harness: one package claiming the common-REPL tags. probe() lights
// up only the interpreters present on this host, so the consumer offers the
// model exactly what the platform has — "plurnk supports the host's REPLs out
// of the box". The operator kill-switch (PLURNK_EXECS_<tag>=0 / _ONLY) is no
// longer honored here — the framework's discover() applies it uniformly across
// every daughter (SPEC §3.3), so a disabled tag never reaches probe(). All run
// arbitrary code → effect `host` (inherited, proposal-gated). Reuses
// SubprocessExecutor's run() (streaming + process-group abort) via spawnArgs().
export default class Common extends SubprocessExecutor {
    protected override spawnArgs(runtime: string, command: string, target: string | null = null): SpawnArgs {
        const r = RECIPES[runtime];
        if (r === undefined) throw new Error(`plurnk-execs-common received unclaimed runtime tag '${runtime}'`);
        // With a target the program IS the target and the body is its stdin
        // (plurnk-execs#15): a shell runs it as a command line (`-c`, so the shell
        // tokenizes — we don't); every other runtime runs it as a single
        // script-file positional.
        if (target !== null) {
            const shell = runtime === "sh" || runtime === "bash";
            return { cmd: r.bin, args: shell ? ["-c", target] : [target], useShell: false, stdin: command };
        }
        // Trailing newline so line-oriented readers (bc, tclsh) evaluate the
        // final line before EOF rather than erroring on an unterminated line.
        if (r.stdin) return { cmd: r.bin, args: [], useShell: false, stdin: `${command}\n` };
        if (r.bare) return { cmd: r.bin, args: [command], useShell: false, stdin: "" };
        return { cmd: r.bin, args: r.arg!(command), useShell: false };
    }

    override async probe(): Promise<RuntimeAvailability> {
        const r = RECIPES[this.runtime];
        if (r === undefined) return { available: false, detail: `unknown runtime '${this.runtime}'` };
        if (r.alwaysAvailable) return { available: true, detail: r.bin === "node" ? process.version : r.bin };
        return onPath(r.bin)
            ? { available: true, detail: r.bin }
            : { available: false, detail: `${r.bin} not on PATH` };
    }
}
