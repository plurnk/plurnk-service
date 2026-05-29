// Runtime tag → spawn-args dispatch. Hardcoded v0 multiplexer; plugin
// discovery (one runtime per `@plurnk/plurnk-execs-*` sibling) is the
// forward-spec path documented in SPEC.md.

import type { SpawnArgs } from "./types.ts";

// Runtimes plurnk-service's `Exec` scheme accepts at v0. Unknown runtimes
// must return 501 from the scheme; `resolveRuntime` itself never throws.
export const KNOWN_RUNTIMES: ReadonlySet<string> = new Set([
    "", "sh", "bash", "node", "python", "python3",
]);

export const isKnownRuntime = (runtime: string): boolean => KNOWN_RUNTIMES.has(runtime);

export const resolveRuntime = (runtime: string, command: string): SpawnArgs => {
    if (runtime === "" || runtime === "sh" || runtime === "bash") {
        return { cmd: command, args: [], useShell: true };
    }
    if (runtime === "node") {
        return { cmd: "node", args: ["-e", command], useShell: false };
    }
    if (runtime === "python" || runtime === "python3") {
        return { cmd: "python3", args: ["-c", command], useShell: false };
    }
    // Unknown runtime: conservative `<runtime> -c <command>` fallback.
    // Schemes should gate this off with `isKnownRuntime` and return 501,
    // but the resolver itself stays total.
    return { cmd: runtime, args: ["-c", command], useShell: false };
};
