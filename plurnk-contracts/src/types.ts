// Schema-derived types are generated from schema/*.json — re-exported here as
// the single import surface for consumers. Run `npm run build:types` to regenerate.
export * from "./types.generated.ts";

import type { Position, PlurnkStatement } from "./types.generated.ts";
import type PlurnkParseError from "./PlurnkParseError.ts";

// Non-schema types — depend on the PlurnkParseError class and so can't be
// expressed in JSON Schema. Hand-maintained.

// Runtime protocol alphabet; PlurnkOp is structurally derived from this tuple. {§op-shapes}
export const PLURNK_OPS = [
    "FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "WORK", "FORK", "KILL", "PLAN",
] as const;

export type PlurnkOp = (typeof PLURNK_OPS)[number];

// Minting predicate only; URL ingestion deliberately remains permissive. {§worker-name}
export const WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Resolver-owned authority names excluded from minting. {§worker-name}
export const RESERVED_AUTHORITIES = Object.freeze(["plurnk", "self"] as const);

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
