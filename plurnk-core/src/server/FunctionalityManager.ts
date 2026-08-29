// {§functionality-model-projection} — the model-facing face of one managed
// Functionality family for one Worker. Published inside that Worker's own
// snapshot like every other family: its verbs are ordinary EXEC targets, its
// documents render through the common tool-document machinery, and a host verb
// proposes through the ordinary Exec proposal lifecycle. Acceptance calls the
// exact coordinator method a client action calls.
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl, RuntimeToolRegistry } from "@plurnk/plurnk-execs";
import { Validator, type JsonSchema } from "@plurnk/plurnk-contracts";
import ErrorDetail from "../core/ErrorDetail.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import type Functionality from "./Functionality.ts";

const CHANNEL = "results";
export const FUNCTIONALITY_VERBS = Object.freeze(["list", "discover", "add", "enable", "disable", "remove"] as const);
export type FunctionalityVerb = (typeof FUNCTIONALITY_VERBS)[number];
const READ_VERBS: ReadonlySet<FunctionalityVerb> = new Set(["list", "discover"]);

const VERB_TEACHING: Readonly<Record<FunctionalityVerb, { summary: string; signature: string; details: string }>> = Object.freeze({
    list: {
        summary: "Project every definition with its origin, enabledness, and current state.",
        signature: "",
        details: "Read-only. Unavailable definitions carry their exact Problem.",
    },
    discover: {
        summary: "Inspect a query or source and return inert candidates.",
        signature: '{"query"?: string, "source"?: string}',
        details: "Read-only. Discovery never installs, persists, enables, or executes a candidate; add one explicitly.",
    },
    add: {
        summary: "Validate one exact definition, persist it for this Worker, prepare it, and enable it atomically.",
        signature: '{"alias": string, "definition": object}',
        details: "A host effect: it proposes and runs only on acceptance. The definition must conform to the family definition schema.",
    },
    enable: {
        summary: "Prepare and publish one already-available definition.",
        signature: '{"alias": string}',
        details: "A host effect. Re-enabling an unavailable definition retries its preparation.",
    },
    disable: {
        summary: "Withdraw the effective capability while keeping the definition available.",
        signature: '{"alias": string}',
        details: "A host effect. A disabled definition stays client-visible and model-invisible.",
    },
    remove: {
        summary: "Disable and remove this Worker's own definition.",
        signature: '{"alias": string}',
        details: "A host effect. A lower-precedence service definition may become visible again, disabled. Service definitions cannot be removed; disable them.",
    },
});

export type FunctionalityTeaching = {
    readonly definitionSchema?: JsonSchema;
    readonly example?: { readonly alias: string; readonly definition: object };
    readonly discovery?: { readonly signature: string; readonly details: string };
};

const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/gu, " ");

// {§functionality-model-projection} — the definition a family accepts, taught from the family's
// own schema: every field with its type, requirement, and meaning, nested fields dotted.
const definitionRows = (schema: JsonSchema | undefined): string[] => {
    if (schema === undefined) return [];
    const ref = (schema as { $ref?: unknown }).$ref;
    const resolved = typeof ref === "string" ? Validator.schemaByRef(ref) : schema;
    if (resolved === null) return [];
    const rows: string[] = [];
    type Node = { type?: string | string[]; enum?: unknown[]; description?: string; properties?: Record<string, Node>; required?: string[]; readOnly?: boolean };
    const walk = (prefix: string, node: Node): void => {
        const required = new Set(node.required ?? []);
        for (const [name, property] of Object.entries(node.properties ?? {})) {
            if (property.readOnly === true) continue;   // the coordinator's own record, never a caller's field
            const type = property.enum !== undefined
                ? property.enum.map((value) => JSON.stringify(value)).join(" \\| ")
                : Array.isArray(property.type) ? property.type.join(" \\| ") : (property.type ?? "any");
            rows.push(`| \`${prefix}${name}\` | ${type} | ${required.has(name) ? "yes" : "no"} | ${cell(property.description ?? "")} |`);
            if (property.properties !== undefined) walk(`${prefix}${name}.`, property);
        }
    };
    walk("", resolved as Node);
    return rows.length === 0 ? [] : ["| Field | Type | Required | Meaning |", "| --- | --- | --- | --- |", ...rows];
};

export const isFunctionalityVerb = (value: string | null): value is FunctionalityVerb =>
    value !== null && (FUNCTIONALITY_VERBS as readonly string[]).includes(value);

export const functionalityRuntimeDecl = (family: string, summary: string): RuntimeDecl => ({
    name: family,
    glyph: "🧩",
    summary,
    invocation: {
        body: { role: "JSON arguments for the verb", required: false },
        target: { role: "lifecycle verb", required: true, kind: "literal" },
        example: { target: "list" },
    },
});

export default class FunctionalityManager extends BaseExecutor {
    readonly #coordinator: Functionality;
    readonly #workspaceId: number;
    readonly #workerId: number;
    readonly #teaching: FunctionalityTeaching;

    constructor(args: { family: string; workspaceId: number; workerId: number; coordinator: Functionality } & FunctionalityTeaching) {
        super({ runtime: args.family, glyph: "🧩" });
        this.#coordinator = args.coordinator;
        this.#workspaceId = args.workspaceId;
        this.#workerId = args.workerId;
        this.#teaching = { definitionSchema: args.definitionSchema, example: args.example, discovery: args.discovery };
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { [CHANNEL]: { mimetype: "application/json" } };
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "Worker Functionality manager" };
    }

    override effect(target: string | null): Effect {
        // An unknown verb is refused at run; gating it as host keeps an invalid
        // invocation from ever running ungated.
        return isFunctionalityVerb(target) && READ_VERBS.has(target) ? "read" : "host";
    }

    // The six verbs in lifecycle order; `add` teaches the family's definition from its schema
    // with one exact example, and `discover` carries the family's own contract when it has one.
    toolRegistry(): RuntimeToolRegistry {
        return {
            tools: FUNCTIONALITY_VERBS.map((verb) => {
                const { signature, details } = this.#teach(verb);
                return {
                    target: verb,
                    summary: VERB_TEACHING[verb].summary,
                    invocation: {
                        body: { role: "JSON arguments", required: signature.length > 0 },
                        target: { role: "lifecycle verb", required: true, kind: "literal" },
                        ...(signature.length > 0 ? { signature } : { example: { target: verb } }),
                    },
                    details,
                };
            }),
        };
    }

    #teach(verb: FunctionalityVerb): { signature: string; details: string } {
        const base = VERB_TEACHING[verb];
        if (verb === "discover" && this.#teaching.discovery !== undefined) {
            return { signature: this.#teaching.discovery.signature, details: `${base.details}\n\n${this.#teaching.discovery.details}` };
        }
        if (verb !== "add") return base;
        const example = this.#teaching.example === undefined ? [] : [
            "",
            "```plurnk",
            `## EXEC0 [${this.runtime}] (add)`,
            JSON.stringify({ alias: this.#teaching.example.alias, definition: this.#teaching.example.definition }),
            "```",
        ];
        const rows = definitionRows(this.#teaching.definitionSchema);
        return { signature: base.signature, details: [base.details, ...example, ...(rows.length === 0 ? [] : ["", ...rows])].join("\n") };
    }

    async run(args: ExecArgs): Promise<ExecResult> {
        const verb = args.target;
        if (!isFunctionalityVerb(verb)) {
            return Results.failure("functionality", "verb-unknown", 400, `'${verb ?? ""}' is not a ${this.runtime} lifecycle verb.`, {}, {
                recovery: `Select one of ${FUNCTIONALITY_VERBS.join(", ")}.`,
                retryable: false,
            });
        }
        let params: unknown = {};
        if (args.body.trim().length > 0) {
            try {
                params = JSON.parse(args.body);
            } catch (cause) {
                return Results.failure("functionality", "arguments-not-json", 400, `The ${verb} body must be a JSON object.`, {}, {
                    recovery: `Supply ${VERB_TEACHING[verb].signature || "no body"}.`,
                    retryable: false,
                    cause: ErrorDetail.preview(cause),
                });
            }
        }
        const identity = { workspaceId: this.#workspaceId, workerId: this.#workerId };
        let result: { status: number; body: unknown };
        let refusal: ExecResult | null = null;
        try {
            result = await this.#coordinator.invoke(this.runtime, verb, params, identity, "operation");
        } catch (cause) {
            // {§functionality-model-projection} — a coordinator refusal (alias taken, scope, admission) is the
            // verb's own outcome with its own status, never an executor fault: it streams as the result,
            // and the executor reports that same failure (status + Problem) as its operation result.
            if (!(cause instanceof OperationFailureError)) throw cause;
            refusal = cause.result;
            result = { status: cause.result.status, body: cause.result };
        }
        args.setState(CHANNEL, "active");
        args.write(CHANNEL, JSON.stringify(result.body, null, 2), "application/json");
        // The channel's terminal state follows the outcome's status, exactly as the stream close does.
        args.setState(CHANNEL, result.status >= 400 ? "errored" : "closed");
        return refusal ?? { status: result.status };
    }
}
