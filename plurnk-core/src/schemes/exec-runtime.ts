import type { ExecStatement, ParsedPath } from "@plurnk/plurnk-contracts";

// {§op-shapes} — the expression names the runtime; the target names its program.
export type ExecRoute = { readonly runtime: string; readonly target: ParsedPath | null };
export const execRouteOf = (statement: Pick<ExecStatement, "runtime" | "target">): ExecRoute => ({ runtime: statement.runtime, target: statement.target });
