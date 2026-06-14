import AstBuilder from "./AstBuilder.ts";

export { default as PlurnkParser } from "./PlurnkParser.ts";
export { default as PlurnkParseError } from "./PlurnkParseError.ts";
export { default as PlurnkErrorStrategy } from "./PlurnkErrorStrategy.ts";
export { AstBuilder };
export { default as RecordingListener } from "./RecordingListener.ts";

/**
 * Parse a path/URI string into a ParsedPath — the exact decomposition the parser
 * applies to every `(target)` slot. The top-level helper to reach for; no need to
 * touch AstBuilder.
 *
 * Primary use: resolving a COPY destination. COPY's body is an opaque string — a
 * destination URI for an entry copy, a prompt for a run fork (`run://`) — so the
 * scheme handler interprets it, then calls this for the destination case. MOVE
 * destinations arrive pre-parsed (its body is always a path); COPY's does not,
 * because its body is polymorphic. See SPEC §4 (COPY) and §12.
 */
export const parsePath = (raw: string) => AstBuilder.parsePath(raw);
export { default as Validator } from "./Validator.ts";
export type { ValidationResult } from "./Validator.ts";

export type { ErrorSource } from "./PlurnkParseError.ts";
export type {
    ContentOffset,
    CopyStatement,
    EditStatement,
    ExecStatement,
    FindStatement,
    FoldStatement,
    KillStatement,
    LineMarker,
    LocalPath,
    LogCoordinate,
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
    TelemetryEvent,
    UrlPath,
} from "./types.ts";
