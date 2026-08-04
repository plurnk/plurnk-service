import AstBuilder from "./AstBuilder.ts";

export {
    default as Validator,
    InvalidLoopFlagsError,
    InvalidNoticeError,
    InvalidOperationResultError,
    InvalidProblemDetailsError,
    InvalidProposalProjectionError,
    InvalidTextRegionError,
} from "./Validator.ts";
export { default as Problems } from "./Problems.ts";
export type { ProblemOptions } from "./Problems.ts";
export type { ValidationResult } from "./Validator.ts";
export { default as PlurnkParser } from "./PlurnkParser.ts";
export { default as PlurnkParseError } from "./PlurnkParseError.ts";
export { default as PathSyntax } from "./PathSyntax.ts";

export const parsePath = (raw: string) => AstBuilder.parsePath(raw);
export const parseResourceSelection = (raw: string) => AstBuilder.parseResourceSelection(raw);

export { DEFAULT_LOOP_FLAGS, PLURNK_OPS, WORKER_NAME, RESERVED_AUTHORITIES, UNKNOWN_POSITION } from "./types.ts";
export type * from "./types.ts";
export type { ErrorSource, Severity } from "./PlurnkParseError.ts";
