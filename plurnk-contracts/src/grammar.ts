import AstBuilder from "./AstBuilder.ts";

export { default as PlurnkParser } from "./PlurnkParser.ts";
export { default as Jsonplurnk } from "./Jsonplurnk.ts";
export { default as PlurnkParseError } from "./PlurnkParseError.ts";
export { default as PlurnkErrorStrategy } from "./PlurnkErrorStrategy.ts";
export { AstBuilder };
export { default as RecordingListener } from "./RecordingListener.ts";

/**
 * Parse a path/URI string into a ParsedPath — the exact decomposition the parser
 * applies to every `(target)` slot. The top-level helper to reach for; no need to
 * touch AstBuilder.
 *
 * Use this when a consumer needs the same path decomposition as an operation
 * target without constructing a synthetic statement.
 */
export const parsePath = (raw: string) => AstBuilder.parsePath(raw);
export const parseResourceSelection = (raw: string) => AstBuilder.parseResourceSelection(raw);
export { default as Validator } from "./GrammarValidator.ts";
export type { ValidationResult } from "./GrammarValidator.ts";
// The canonical runtime op-set (a value, not just the PlurnkOp type) — consumers derive their
// op enums / SQL CHECKs from this single source instead of hand-copying the literal list.
export { PLURNK_OPS, WORKER_NAME, RESERVED_AUTHORITIES } from "./types.ts";

export type { ErrorSource, Severity } from "./PlurnkParseError.ts";
export type {
    BuffStatement,
    ClientOp,
    ClientStatement,
    CopyStatement,
    EditStatement,
    ExecStatement,
    FindStatement,
    FoldStatement,
    ForkStatement,
    KillStatement,
    LineMarker,
    LocalPath,
    LookStatement,
    MatcherBody,
    MoveStatement,
    ParseItem,
    ParseResult,
    ParsedPath,
    PlanStatement,
    PlurnkOp,
    PlurnkStatement,
    Position,
    ReadStatement,
    ResourceSelection,
    SendBody,
    SendStatement,
    OpenStatement,
    UrlPath,
    WorkStatement,
} from "./types.ts";
