import type { ExecStatement, ParsedPath } from "@plurnk/plurnk-contracts";

// {§exec-executor-slot} — the fence names the registered executor; the target names
// its program. Native EXEC without an executor selects the default shell.
export type ExecRoute = { readonly runtime: string; readonly target: ParsedPath | null };

export const execRouteOf = (statement: Pick<ExecStatement, "executor" | "target">): ExecRoute => ({ runtime: statement.executor ?? "sh", target: statement.target });
