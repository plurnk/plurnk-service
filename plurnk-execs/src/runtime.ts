// Spawn-argument recipes used internally by SubprocessExecutor.

import type { SpawnArgs } from "./types.ts";
import Shell from "./Shell.ts";
import { tokenizeArgv } from "./tokenizeArgv.ts";

export default class Runtime {
    static resolve(runtime: string, command: string, target: string | null = null): SpawnArgs {
        // {§executor-shell} `sh` runs the environment's shell.
        const shell = runtime === "" || runtime === "sh";
        const cmd = shell ? Shell.current().path : runtime === "js" ? "node" : runtime;
        // With a target the program IS the target and the body is its arguments,
        // tokenized by shell quoting ({§executor-subprocess-routing}, {§executor-argv-tokenizer}).
        // Every interpreter reads one script file; neither shell command parsing nor an executable bit is required.
        if (target !== null) {
            return { cmd, args: [target, ...tokenizeArgv(command)], useShell: false };
        }
        if (shell) return { cmd, args: ["-c", command], useShell: false };
        if (runtime === "js") return { cmd: "node", args: ["-e", command], useShell: false };
        if (runtime === "python3") return { cmd: "python3", args: ["-c", command], useShell: false };
        // Subclasses normally override spawnArgs for additional runtimes.
        return { cmd: runtime, args: ["-c", command], useShell: false };
    }
}
