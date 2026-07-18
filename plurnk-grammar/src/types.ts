// Schema-derived types are generated from schema/*.json — re-exported here as
// the single import surface for consumers. Run `npm run build:types` to regenerate.
export * from "./types.generated.ts";

import type { Position, PlurnkStatement } from "./types.generated.ts";
import type PlurnkParseError from "./PlurnkParseError.ts";

// Non-schema types — depend on the PlurnkParseError class and so can't be
// expressed in JSON Schema. Hand-maintained.

// The canonical runtime op-set — the SINGLE source of truth for the protocol alphabet, in
// canonical order. PlurnkOp is DERIVED from it, so a new verb lands in the type AND the runtime
// list at once; consumers derive their enums / validators / SQL CHECKs from PLURNK_OPS instead
// of hand-copying the literal set (which goes stale the instant a verb ships).
export const PLURNK_OPS = [
    "FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "WORK", "FORK", "KILL", "PLAN",
] as const;

export type PlurnkOp = (typeof PLURNK_OPS)[number];

// The worker-name (URI authority) contract (#527, §worker-name) — the SINGLE source for what
// a mintable worker name is; core's auto-namer and schemes' registry derive from THIS instead
// of hand-copying. A lowercase DNS label (LDH): the authority slot looks like a hostname, so
// names ARE hostname-shaped — the exact pretraining prior the slot rides. Lowercase-ONLY is
// load-bearing: non-special-scheme URL parsing preserves authority case (worker://Alice ≠
// worker://alice — verified), so admitting case would mint look-alike principals.
// NOT encoded here (deliberately): id-freedom. `model-1721-a3f8` is LDH-legal — no alphabet
// can distinguish hash-like, and trying would be content policing. Id-free names are the
// GENERATOR's contract (core), enforced at minting, not in the charset.
// The parser stays permissive (it decomposes ANY authority — http hosts are arbitrary);
// this contract governs MINTING and registry validation, not ingestion.
export const WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Authorities interpreted by the RESOLVER, never mintable as worker names. `~` (self) is
// reserved by construction — it is outside WORKER_NAME's alphabet. The commons row's name
// (core-minted) must also never render into a URI: the commons renders as the EMPTY authority.
export const RESERVED_AUTHORITIES = Object.freeze(["plurnk"] as const);

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
