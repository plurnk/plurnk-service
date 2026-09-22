// Schema-derived types are generated from schema/*.json — re-exported here as
// the single import surface for consumers. Run `npm run build:types` to regenerate.
export * from "./types.generated.ts";

import loopPolicySchema from "../schema/LoopPolicy.json" with { type: "json" };
import reasoningPolicySchema from "../schema/ReasoningPolicy.json" with { type: "json" };
import skillDefinitionSchema from "../schema/SkillDefinition.json" with { type: "json" };
import type {
    ClientStatement,
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
    "FIND", "READ", "EDIT", "COPY", "MOVE", "SEND", "BARE", "WORK", "FORK", "KILL",
    "NOTE", "WAIT",
] as const;

// {§operation-fences} — canonical teaching/rendering width; ingestion also accepts three.
export const PLURNK_FENCE = "````";

export type PlurnkOp = (typeof PLURNK_OPS)[number];

// An execution is written as its runtime's fence, so its operation IS the runtime tag: lowercase
// by {§executor-runtime-declaration}, which is why it can never collide with an operation keyword.
// The engine's own lowercase row ops (`extension`, `error`) are reserved runtime names.
export type RuntimeTag = Lowercase<string>;
export const RUNTIME_TAG = /^[a-z][a-z0-9+.-]*$/;
export const INTERNAL_ROW_OPS: ReadonlySet<string> = new Set(["extension", "error"]);
export const isExecutionOp = (op: string | null | undefined): op is RuntimeTag => typeof op === "string" && !INTERNAL_ROW_OPS.has(op) && RUNTIME_TAG.test(op);
export const isExecution = <T extends { readonly op?: string | undefined }>(statement: T): statement is Extract<T, { runtime: RuntimeTag }> =>
    "runtime" in statement;
// The heading token as written: an operation keyword, or an execution's runtime. This is the
// log row's `op`.
export const writtenOp = <T extends PlurnkStatement | ClientStatement>(statement: T): Exclude<T["op"], undefined> | RuntimeTag =>
    (isExecution(statement) ? statement.runtime : statement.op) as Exclude<T["op"], undefined> | RuntimeTag;

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

// Schema-owned vocabulary of `LoopPolicy.proposals`. {§loop-policy}
export const PROPOSAL_POLICIES = Object.freeze(
    loopPolicySchema.properties.proposals.enum as LoopPolicy["proposals"][],
) as readonly LoopPolicy["proposals"][];

// Minting predicate only; URL ingestion deliberately remains permissive. {§worker-name}
export const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

// {§agent-skills-name} Discovery and registration share the wire schema's grammar.
export const SKILL_NAME = new RegExp(skillDefinitionSchema.properties.name.pattern, "u");

// Structurally synthesized statements have no parsed source point. {§parser-position}
export const UNKNOWN_POSITION: Readonly<Position> = Object.freeze({ line: 0, column: 0 });

// Client-tier-only ops (parseClient). Kept distinct from PlurnkOp so the protocol op set
// stays closed and client ops never widen the model-facing type.
export type ClientOp = "LOOK";

// Parameterized over the statement type so the protocol entry points keep the closed
// PlurnkStatement (the default), while parseClient returns ParseResult<ClientStatement>.
export type ParseItem<S = PlurnkStatement> =
    | { kind: "statement"; statement: S }
    | { kind: "text"; content: string; position: Position }
    | { kind: "error"; error: PlurnkParseError };

export type ParseResult<S = PlurnkStatement> = {
    items: ParseItem<S>[];
    unparsedTail?: { from: Position; reason: string };
};
