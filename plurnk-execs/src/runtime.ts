// Spawn-argument recipes used internally by SubprocessExecutor.

import type { SpawnArgs } from "./types.ts";

export default class Runtime {
    static resolve(runtime: string, command: string, target: string | null = null): SpawnArgs {
        const shell = runtime === "" || runtime === "sh";
        // With a target the program IS the target and the body is its stdin
        // ({§executor-subprocess-routing}): a shell runs the target as a command line (`-c`, so
        // the shell tokenizes it — we don't); any other runtime runs it as a
        // single script-file positional. No target → the body is the program,
        // inline (`-c`/`-e`), as before.
        if (target !== null) {
            if (shell) return { cmd: runtime || "sh", args: ["-c", target], useShell: false, stdin: command };
            return { cmd: runtime, args: [target], useShell: false, stdin: command };
        }
        if (shell) return { cmd: command, args: [], useShell: true };
        if (runtime === "node") return { cmd: "node", args: ["-e", command], useShell: false };
        if (runtime === "python3") return { cmd: "python3", args: ["-c", command], useShell: false };
        // Subclasses normally override spawnArgs for additional runtimes.
        return { cmd: runtime, args: ["-c", command], useShell: false };
    }
}
