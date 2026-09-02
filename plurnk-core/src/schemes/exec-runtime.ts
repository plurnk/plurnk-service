import { parsePath, type ExecStatement, type ParsedPath } from "@plurnk/plurnk-contracts";

// {§exec-path-runtime} — `## EXEC0 (runtime/target)`: when the first path segment names a
// registered runtime, the rest is that runtime's target — a registered tool, a script or
// directory, or a resource URL. Otherwise the whole path is the default shell's target
// (`## EXEC0 (scripts/test.sh)`, `## EXEC0 (.)`). A bare EXEC (no path) is the shell.
export type ExecRoute = { readonly runtime: string; readonly target: ParsedPath | null };

export const execRouteOf = (statement: ExecStatement, isRuntime: (name: string) => boolean): ExecRoute => {
    if (statement.target === null) return { runtime: "sh", target: null };
    if (statement.target.kind === "url") return { runtime: "sh", target: statement.target };
    const raw = statement.target.raw.replace(/^\/+/, "");
    const slash = raw.indexOf("/");
    const head = slash < 0 ? raw : raw.slice(0, slash);
    if (head === "sh" || !isRuntime(head)) return { runtime: "sh", target: head === "sh" ? (slash < 0 ? null : parsePath(raw.slice(slash + 1))) : statement.target };
    return { runtime: head, target: slash < 0 ? null : parsePath(raw.slice(slash + 1)) };
};
