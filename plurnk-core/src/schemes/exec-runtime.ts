import type { ExecStatement, ParsedPath } from "@plurnk/plurnk-contracts";

// {§exec-executor-slot} — `## EXEC0 [executor] (program)`: the bracket names the registered
// executor and the path names its program. A bare heading is the default shell.
export type ExecRoute = { readonly runtime: string; readonly target: ParsedPath | null };

export const execRouteOf = (statement: ExecStatement): ExecRoute => ({ runtime: statement.executor ?? "sh", target: statement.target });
