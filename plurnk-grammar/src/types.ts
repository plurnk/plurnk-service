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
    | "KILL"
    | "PLAN";

// Client-tier-only ops (parseClient). Kept distinct from PlurnkOp so the protocol op set
// stays closed and client ops never widen the model-facing type.
export type ClientOp = "LOOK" | "BUFF";

// Parameterized over the statement type so the protocol entry points keep the closed
// PlurnkStatement (the default), while parseClient returns ParseResult<ClientStatement>.
export type ParseItem<S = PlurnkStatement> =
    | { kind: "statement"; statement: S }
    | { kind: "error"; error: PlurnkParseError }
    | { kind: "text"; text: string; position: Position };

export type ParseResult<S = PlurnkStatement> = {
    items: ParseItem<S>[];
    unparsedTail?: { from: Position; reason: string };
};
