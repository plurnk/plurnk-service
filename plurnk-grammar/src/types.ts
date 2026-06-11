// Schema-derived types are generated from schema/*.json — re-exported here as
// the single import surface for consumers. Run `npm run build:types` to regenerate.
export * from "./types.generated.ts";

import type { Position, PlurnkStatement } from "./types.generated.ts";
import type PlurnkParseError from "./PlurnkParseError.ts";

// Non-schema types — depend on the PlurnkParseError class and so can't be
// expressed in JSON Schema. Hand-maintained.

export type PlurnkOp =
    | "FIND"
    | "READ"
    | "EDIT"
    | "COPY"
    | "MOVE"
    | "OPEN"
    | "FOLD"
    | "SEND"
    | "EXEC"
    | "KILL";

export type ParseItem =
    | { kind: "statement"; statement: PlurnkStatement }
    | { kind: "error"; error: PlurnkParseError }
    | { kind: "text"; text: string; position: Position };

export type ParseResult = {
    items: ParseItem[];
    unparsedTail?: { from: Position; reason: string };
};
