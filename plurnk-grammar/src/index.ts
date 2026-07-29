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
 * Primary use: resolving a COPY destination. COPY's destination body remains an
 * opaque string until the consumer calls this helper. MOVE destinations arrive
 * pre-parsed because their body is always a path. See SPEC section 4 (COPY) and 12.
 */
export const parsePath = (raw: string) => AstBuilder.parsePath(raw);
export { default as Validator } from "./Validator.ts";
export type { ValidationResult } from "./Validator.ts";
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
    SendBody,
    SendStatement,
    OpenStatement,
    UrlPath,
    WorkStatement,
} from "./types.ts";
