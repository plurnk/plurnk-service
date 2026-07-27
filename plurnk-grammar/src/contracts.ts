// Runtime-neutral contract entrypoint for packages that share PLURNK's wire
// schemas without importing the parser.
export { default as Validator } from "./Validator.ts";
export type { OperationResult, ProblemDetails, TelemetryEvent } from "./types.ts";
