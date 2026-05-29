// Runtime executor contract. Each `@plurnk/plurnk-execs-*` sibling declares
// one or more runtime tags (`sh`, `bash`, `python`, `search`, etc.) and
// provides the dispatch logic for those tags.
//
// v0 surface: runtime tag → spawn-args translator (the only piece
// plurnk-service's exec scheme needs migrated out of its own codebase).
// Plugin discovery / framework registry is forward-spec — see SPEC.md.

export interface SpawnArgs {
    /** Command to invoke (e.g. "node", "python3", or — when useShell — the raw command). */
    cmd: string;
    /** Args passed to the command. */
    args: string[];
    /** When true, the command is interpreted as a shell line (cmd is the whole line, args ignored). */
    useShell: boolean;
}

/**
 * Translate a runtime tag + command string into spawn args for `node:child_process.spawn`.
 *
 * Runtimes:
 *   - `""` / `"sh"` / `"bash"`           → shell-mode invocation of the command
 *   - `"node"`                          → `node -e <command>`
 *   - `"python"` / `"python3"`          → `python3 -c <command>`
 *   - any other (unknown) runtime tag    → conservative `<runtime> -c <command>` fallback
 *
 * Consumers check `isKnownRuntime(runtime)` before calling to enforce a 501 boundary
 * on unconfigured runtimes; this function never throws.
 */
export type RuntimeResolver = (runtime: string, command: string) => SpawnArgs;
