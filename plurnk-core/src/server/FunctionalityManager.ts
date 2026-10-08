// {§functionality-model-projection} — the model-facing face of one managed
// Functionality family for one workspace. Published inside that workspace's
// snapshot like every other family: its verbs are ordinary execution targets, its
// documents render through the common tool-document machinery, and a host verb
// proposes through the ordinary Exec proposal lifecycle. Acceptance calls the
// exact coordinator method a client action calls.
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl, RuntimeToolRegistry } from "@plurnk/plurnk-execs";
import type { FunctionalityDiscovery } from "@plurnk/plurnk-modules";
import { Problems, type JsonSchema } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import ErrorDetail from "../core/ErrorDetail.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import EnvFunctionality from "./EnvFunctionality.ts";
import type Functionality from "./Functionality.ts";

const CHANNEL = "results";
export const FUNCTIONALITY_VERBS = Object.freeze(["list", "discover", "add", "enable", "disable", "remove"] as const);
export type FunctionalityVerb = (typeof FUNCTIONALITY_VERBS)[number];
const READ_VERBS: ReadonlySet<FunctionalityVerb> = new Set(["list", "discover"]);

const VERB_TEACHING: Readonly<Record<FunctionalityVerb, { summary: string; details: string }>> = Object.freeze({
    list: {
        summary: "Inspect definitions, ownership, configuration sources, and readiness.",
        details: "Read-only. Unavailable definitions carry their exact Problem. Provenance identifies the winning configuration input, not a runtime or shadowed definition.",
    },
    discover: {
        summary: "Return inert candidates for the input its schema accepts.",
        details: "Read-only. Discovery never installs, persists, enables, or executes a candidate; add one explicitly.",
    },
    add: {
        summary: "Validate one exact definition, persist it at the selected scope, prepare it, and enable it atomically.",
        details: "A host effect: it proposes and runs only on acceptance. The definition must conform to the family definition schema.",
    },
    enable: {
        summary: "Prepare and publish one already-available definition.",
        details: "A host effect. Re-enabling an unavailable definition retries its preparation.",
    },
    disable: {
        summary: "Withdraw the effective capability while keeping the definition available.",
        details: "A host effect. The definition remains inspectable.",
    },
    remove: {
        summary: "Forget the local definition and restore inheritance.",
        details: "A host effect. Any inherited definition resumes with its inherited enabledness. Inherited definitions cannot be removed at this scope.",
    },
});

// {§functionality-discover-advertisement} The family's verbs are exactly those with an input schema.
export type FunctionalityTeaching = {
    readonly traits?: readonly string[];
    readonly inputSchemas: Readonly<Partial<Record<FunctionalityVerb, JsonSchema>>>;
    readonly example?: { readonly alias: string; readonly definition: object };
    readonly discovery?: FunctionalityDiscovery;
};

const isFunctionalityVerb = (value: string | null): value is FunctionalityVerb =>
    value !== null && (FUNCTIONALITY_VERBS as readonly string[]).includes(value);

export const functionalityRuntimeDecl = (family: string, summary: string, details: string): RuntimeDecl => ({
    name: family,
    glyph: "🧩",
    summary: { from: "tools", description: summary },
    invocation: {
        body: { role: "JSON arguments for the verb", required: false },
        target: { role: "lifecycle verb", required: true, kind: "literal" },
        example: { target: "list" },
    },
    ...(details.length === 0 ? {} : { details }),
});

export default class FunctionalityManager extends BaseExecutor {
    readonly #coordinator: Functionality;
    readonly #workspaceId: number;
    readonly #workerId: number | undefined;
    readonly #teaching: FunctionalityTeaching;

    constructor(args: { family: string; workspaceId: number; workerId?: number; coordinator: Functionality } & FunctionalityTeaching) {
        super({ runtime: args.family, glyph: "🧩" });
        this.#coordinator = args.coordinator;
        this.#workspaceId = args.workspaceId;
        this.#workerId = args.workerId;
        this.#teaching = { traits: args.traits, inputSchemas: args.inputSchemas, example: args.example, discovery: args.discovery };
    }

    // {§functionality-model-projection} — the published manager closes over the workspace; Core binds
    // the invoking Worker at the operation ({§functionality-scope}), so a worker-scoped family's verbs
    // act for that Worker. A bound instance is per operation, never retained on the published one.
    forWorker(workerId: number): FunctionalityManager {
        return new FunctionalityManager({
            family: this.runtime, workspaceId: this.#workspaceId, workerId, coordinator: this.#coordinator, ...this.#teaching,
        });
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { [CHANNEL]: { mimetype: "application/json" } };
    }

    override get traits(): ReadonlyArray<string> | undefined {
        return this.#teaching.traits;
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "workspace Functionality manager" };
    }

    override effect(target: string | null): Effect {
        // An unknown verb is refused at run; gating it as host keeps an invalid
        // invocation from ever running ungated.
        return isFunctionalityVerb(target) && READ_VERBS.has(target) ? "read" : "host";
    }

    #verbs(): FunctionalityVerb[] {
        return FUNCTIONALITY_VERBS.filter((verb) => this.#teaching.inputSchemas[verb] !== undefined);
    }

    // The family's verbs in lifecycle order; `add` teaches the family's definition from its schema
    // with one exact example, and `discover` carries the family's own teaching when it has some.
    // A body is optional where an empty one is a complete request: `list`, and a discovery whose
    // empty request lists everything.
    toolRegistry(): RuntimeToolRegistry {
        return {
            tools: this.#verbs().map((verb) => {
                const inputSchema = this.#teaching.inputSchemas[verb]!;
                const optional = verb === "list" || (verb === "discover" && this.#teaching.discovery?.emptyListsAll === true);
                return {
                    target: verb,
                    summary: VERB_TEACHING[verb].summary,
                    invocation: {
                        body: { role: "JSON arguments", required: !optional },
                        target: { role: "lifecycle verb", required: true, kind: "literal" },
                        inputSchema,
                    },
                    details: this.#details(verb),
                };
            }),
        };
    }

    #details(verb: FunctionalityVerb): string {
        const base = VERB_TEACHING[verb];
        if (verb === "discover") {
            const details = this.#teaching.discovery?.details;
            return details === undefined ? base.details : `${base.details}\n\n${details}`;
        }
        if (verb !== "add") return base.details;
        const example = this.#teaching.example === undefined ? [] : [
            "",
            PlurnkParser.frame(`${this.runtime} (add)`, JSON.stringify({ alias: this.#teaching.example.alias, definition: this.#teaching.example.definition })),
        ];
        return [base.details, ...example].join("\n");
    }

    async run(args: ExecArgs): Promise<ExecResult> {
        const verb = args.target;
        const verbs = this.#verbs();
        if (!isFunctionalityVerb(verb) || !verbs.includes(verb)) {
            return Results.failure("functionality", "verb-unknown", 400, `'${verb ?? ""}' is not a ${this.runtime} lifecycle verb.`, {}, {
                recovery: `Select one of ${verbs.join(", ")}.`,
                retryable: false,
            });
        }
        let params: unknown = {};
        if (args.body.trim().length > 0) {
            try {
                params = JSON.parse(args.body);
            } catch (cause) {
                return Results.failure("functionality", "arguments-not-json", 400, `The ${verb} body must be a JSON object.`, {}, {
                    recovery: "Supply a JSON object body.",
                    retryable: false,
                    cause: ErrorDetail.preview(cause),
                });
            }
        }
        const identity = { workspaceId: this.#workspaceId, ...(this.#workerId === undefined ? {} : { workerId: this.#workerId }) };
        let result: { status: number; body: unknown };
        let refusal: ExecResult | null = null;
        try {
            result = await this.#coordinator.invoke(this.runtime, verb, params, identity, "operation", { env: EnvFunctionality.modifier(args.metadata) });
        } catch (cause) {
            // {§functionality-model-projection} — a coordinator refusal (alias taken, scope, admission) is the
            // verb's own outcome with its own status, never an executor fault: it streams as the result,
            // and the executor reports that same failure (status + Problem) as its operation result.
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            refusal = cause instanceof OperationFailureError ? cause.result : { status: problem.status, problem };
            result = { status: refusal.status, body: refusal };
        }
        args.setState(CHANNEL, "active");
        args.write(CHANNEL, JSON.stringify(result.body, null, 2), "application/json");
        // {§functionality-model-mutation} Resource readiness is the body; this invocation has settled.
        args.setState(CHANNEL, result.status >= 400 ? "errored" : "closed");
        return refusal ?? { status: result.status === 202 ? 200 : result.status };
    }
}
