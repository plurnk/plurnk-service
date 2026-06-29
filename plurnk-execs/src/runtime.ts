// Runtime tag → spawn-args dispatch. Hardcoded v0 multiplexer; plugin
// discovery (one runtime per `@plurnk/plurnk-execs-*` sibling) is the
// forward-spec path documented in SPEC.md. The public `KNOWN_RUNTIMES` /
// `isKnownRuntime` / `resolveRuntime` surface (SPEC §4) is re-exported from
// index.ts over these statics; cross-refs use the explicit `Runtime.` binding
// so a detached re-export stays callable.

import type { SpawnArgs } from "./types.ts";

export default class Runtime {
    // Runtimes plurnk-service's `Exec` scheme accepts at v0. Unknown runtimes
    // must return 501 from the scheme; `resolve` itself never throws.
    static readonly KNOWN: ReadonlySet<string> = new Set([
        "", "sh", "bash", "node", "python", "python3",
    ]);

    static isKnown(runtime: string): boolean {
        return Runtime.KNOWN.has(runtime);
    }

    static resolve(runtime: string, command: string): SpawnArgs {
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
        // Schemes should gate this off with `isKnown` and return 501, but the
        // resolver itself stays total.
        return { cmd: runtime, args: ["-c", command], useShell: false };
    }
}
