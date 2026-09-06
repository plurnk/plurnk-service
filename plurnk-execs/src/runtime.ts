// Spawn-argument recipes used internally by SubprocessExecutor.

import type { SpawnArgs } from "./types.ts";

export default class Runtime {
    static resolve(runtime: string, command: string, target: string | null = null): SpawnArgs {
        const shell = runtime === "" || runtime === "sh";
        // With a target the program IS the target and the body is its stdin
        // ({§executor-subprocess-routing}). Every interpreter reads one script
        // file; neither shell command parsing nor an executable bit is required.
        if (target !== null) {
            return { cmd: runtime || "sh", args: [target], useShell: false, stdin: command };
        }
        if (shell) return { cmd: runtime || "sh", args: ["-c", command], useShell: false };
        if (runtime === "node") return { cmd: "node", args: ["-e", command], useShell: false };
        if (runtime === "python3") return { cmd: "python3", args: ["-c", command], useShell: false };
        // Subclasses normally override spawnArgs for additional runtimes.
        return { cmd: runtime, args: ["-c", command], useShell: false };
    }
}
