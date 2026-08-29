// Schema-derived types are generated from schema/*.json — re-exported here as
// the single import surface for consumers. Run `npm run build:types` to regenerate.
export * from "./types.generated.ts";

import reasoningPolicySchema from "../schema/ReasoningPolicy.json" with { type: "json" };
import type {
    CapabilityPolicy,
    LoopPolicy,
    Position,
    PlurnkStatement,
    ProviderRequestAccounting,
    ReasoningPolicy,
} from "./types.generated.ts";
import type PlurnkParseError from "./PlurnkParseError.ts";

// Non-schema types — depend on the PlurnkParseError class and so can't be
// expressed in JSON Schema. Hand-maintained.

// Runtime protocol alphabet; PlurnkOp is structurally derived from this tuple. {§op-shapes}
export const PLURNK_OPS = [
    "FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "BARE", "WORK", "FORK", "KILL", "PLAN",
] as const;

// Markerless model-facing retrievals share one fixed first page. Producers use
// an explicit <1,-1> when they deliberately require the complete projection.
export const DEFAULT_RETRIEVAL_LIMIT = 16;

export type PlurnkOp = (typeof PLURNK_OPS)[number];

// Runtime-neutral cardinal observation for one physical inference request.
// The caller opens identity before I/O; the producer settles that exact
// occurrence once with normalized accounting evidence. {§provider-request-accounting}
export interface ProviderRequestIdentity {
    readonly provider: string;
    readonly model: string;
}

export type ProviderRequestSettlement = (
    accounting: ProviderRequestAccounting,
) => Promise<void>;

export type ProviderRequestObserver = (
    identity: ProviderRequestIdentity,
) => Promise<ProviderRequestSettlement>;

// Schema-owned portable reasoning vocabulary. Providers own which subset a
// route supports; runtimes and clients share this exact wire alphabet.
export const REASONING_POLICIES = Object.freeze(
    reasoningPolicySchema.enum as ReasoningPolicy[],
) as readonly ReasoningPolicy[];

export const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy = Object.freeze({});

export const DEFAULT_LOOP_POLICY: LoopPolicy = Object.freeze({
    capabilities: DEFAULT_CAPABILITY_POLICY,
    proposals: "review",
});

// Minting predicate only; URL ingestion deliberately remains permissive. {§worker-name}
export const WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Authority-shaped internal worker names excluded from minting. {§worker-name}
export const RESERVED_AUTHORITIES = Object.freeze(["commons", "plurnk"] as const);

// Structurally synthesized statements have no parsed source point. {§parser-position}
export const UNKNOWN_POSITION: Readonly<Position> = Object.freeze({ line: 0, column: 0 });

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
