// {§functionality-model-projection} — the model-facing `plurnk` runtime
// executor: one tool per workspace Functionality family plus `question`,
// published under `worker:///_plurnk/tools/plurnk.md` and
// `worker:///_plurnk/tools/plurnk/<tool>.json` and expanded at turn 0.
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl, RuntimeRegisteredTool, RuntimeToolRegistry } from "@plurnk/plurnk-execs";
import type { FunctionalityDiscovery } from "@plurnk/plurnk-modules";
import { Problems, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import ErrorDetail from "../core/ErrorDetail.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import QuestionTool, { questionRegisteredTool } from "../schemes/QuestionTool.ts";
import EnvFunctionality from "./EnvFunctionality.ts";
import type Functionality from "./Functionality.ts";
import type { FunctionalityConfigurationFailure } from "./Functionality.ts";

const CHANNEL = "results";
export const FUNCTIONALITY_VERBS = Object.freeze(["list", "discover", "add", "replace", "enable", "disable", "remove"] as const);
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
        summary: "Validate each definition the body names, persist it at the selected scope, prepare it, and enable it atomically.",
        details: "A host effect: it proposes and runs only on acceptance. The body must conform to the verb's input schema.",
    },
    replace: {
        summary: "Assign a complete definition to a named alias, retaining its enabledness.",
        details: "A host effect. A new alias is enabled. Rejection preserves the preceding definition and attachment; disabled definitions are saved without preparation.",
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
    readonly summary?: string;
    readonly traits?: readonly string[];
    readonly inputSchemas: Readonly<Partial<Record<FunctionalityVerb, JsonSchema>>>;
    readonly example?: object;
    readonly discovery?: FunctionalityDiscovery;
    readonly documentBody?: string;
    readonly configurationFailure?: FunctionalityConfigurationFailure | null;
};

export interface FunctionalityFamilyEntry extends FunctionalityTeaching {
    readonly family: string;
}

export type FunctionalityManagerOptions =
    | {
        readonly coordinator: Functionality;
        readonly workspaceId?: number;
        readonly workerId?: number;
        readonly entries: readonly FunctionalityFamilyEntry[] | ((workspaceId?: number) => readonly FunctionalityFamilyEntry[]);
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
    }
    | ({
        readonly coordinator: Functionality;
        readonly workspaceId?: number;
        readonly workerId?: number;
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
    } & FunctionalityFamilyEntry);

export const isFunctionalityVerb = (value: unknown): value is FunctionalityVerb =>
    typeof value === "string" && (FUNCTIONALITY_VERBS as readonly string[]).includes(value);

export const plurnkRuntimeDecl: RuntimeDecl & { readonly glyph: string } = {
    name: "plurnk",
    glyph: "🔌",
    summary: { from: "tools", description: "Manage workspace capabilities and ask the user questions." },
    resourcesPath: "/tools",
    expandTools: true,
    invocation: {
        body: { role: "JSON arguments", required: false, mimetype: "application/json" },
        target: { role: "Plurnk tool", required: true, kind: "literal" },
        example: { target: "members", body: '{"verb": "list"}' },
    },
};

const stripLeadingHeading = (markdown: string): string =>
    markdown.trim().replace(/^# [^\n]*\n+/u, "").trim();

export default class FunctionalityManager extends BaseExecutor {
    readonly #coordinator: Functionality;
    readonly #workspaceId: number;
    readonly #workerId: number | undefined;
    readonly #entriesSource: readonly FunctionalityFamilyEntry[] | ((workspaceId?: number) => readonly FunctionalityFamilyEntry[]);
    readonly #includeQuestionSource: boolean | ((workspaceId?: number) => boolean);
    readonly #question = new QuestionTool({ runtime: "plurnk", glyph: "🔌" });

    constructor(args: FunctionalityManagerOptions) {
        super({ runtime: "plurnk", glyph: "🔌" });
        this.#coordinator = args.coordinator;
        this.#workspaceId = args.workspaceId ?? 1;
        this.#workerId = args.workerId;
        this.#entriesSource = "entries" in args ? args.entries : [args];
        this.#includeQuestionSource = args.includeQuestion ?? false;
    }

    // {§functionality-model-projection} — the published manager closes over the coordinator; Core binds
    // the invoking workspace and Worker at the operation ({§functionality-scope}), so a worker-scoped family's
    // verbs act for that Worker. A bound instance is per operation, never retained on the published one.
    forWorker(workerId: number): FunctionalityManager {
        return this.forContext(this.#workspaceId, workerId);
    }

    forContext(workspaceId: number, workerId: number): FunctionalityManager {
        return new FunctionalityManager({
            coordinator: this.#coordinator,
            workspaceId,
            workerId,
            entries: this.#entriesSource,
            includeQuestion: this.#includeQuestionSource,
        });
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { [CHANNEL]: { mimetype: "application/json" } };
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "workspace Functionality manager" };
    }

    override effect(target: string | null): Effect {
        return target === "question" ? "read" : "host";
    }

    // {§functionality-model-mutation} — `list`, `discover`, and `question` are `read`;
    // lifecycle mutations (`add`, `replace`, `enable`, `disable`, `remove`) are `host`.
    effectForInvocation(target: string | null, body: string, workspaceId?: number): Effect {
        if (target === "question") return "read";
        if (target === null) return "host";
        const entry = this.#entries(workspaceId).find((candidate) => candidate.family === target);
        if (entry === undefined) return "host";
        const trimmed = body.trim();
        if (trimmed.length === 0) {
            return entry.inputSchemas.list !== undefined ? "read" : "host";
        }
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (!isRecord(parsed)) return "host";
            const verb = parsed.verb === undefined && Object.keys(parsed).length === 0 ? "list" : parsed.verb;
            return isFunctionalityVerb(verb) && READ_VERBS.has(verb) && entry.inputSchemas[verb] !== undefined
                ? "read"
                : "host";
        } catch {
            return "host";
        }
    }

    #entries(workspaceId?: number): readonly FunctionalityFamilyEntry[] {
        const targetWorkspace = workspaceId ?? this.#workspaceId;
        return typeof this.#entriesSource === "function"
            ? this.#entriesSource(targetWorkspace)
            : this.#entriesSource;
    }

    #includeQuestion(workspaceId?: number): boolean {
        const targetWorkspace = workspaceId ?? this.#workspaceId;
        return typeof this.#includeQuestionSource === "function"
            ? this.#includeQuestionSource(targetWorkspace)
            : this.#includeQuestionSource;
    }

    static #verbsFor(entry: FunctionalityFamilyEntry): FunctionalityVerb[] {
        return FUNCTIONALITY_VERBS.filter((verb) => entry.inputSchemas[verb] !== undefined);
    }

    static #familySummary(entry: FunctionalityFamilyEntry): string {
        const base = entry.summary ?? `Manage ${entry.family} definitions.`;
        return entry.configurationFailure !== null && entry.configurationFailure !== undefined
            ? `${base.replace(/\.$/u, "")} — configuration unavailable; inspect with list`
            : base;
    }

    static #familyInputSchema(entry: FunctionalityFamilyEntry, verbs: readonly FunctionalityVerb[]): JsonSchema {
        const properties: Record<string, JsonSchema> = {
            verb: {
                type: "string",
                enum: [...verbs],
                description: "The lifecycle verb to run (defaults to list when the body is empty).",
            },
        };
        for (const verb of verbs) {
            const schema = entry.inputSchemas[verb];
            const verbProps = isRecord(schema?.properties) ? schema.properties : {};
            for (const [key, prop] of Object.entries(verbProps)) {
                if (!Object.hasOwn(properties, key) && isRecord(prop)) {
                    properties[key] = prop;
                }
            }
        }
        return {
            type: "object",
            additionalProperties: false,
            required: ["verb"],
            properties,
        };
    }

    static #familyDetails(entry: FunctionalityFamilyEntry, verbs: readonly FunctionalityVerb[]): string {
        const sections: string[] = [];
        if (entry.configurationFailure !== null && entry.configurationFailure !== undefined) {
            sections.push(`> [!WARNING]\n> ${entry.configurationFailure.error.message}`);
        }
        const verbLines = verbs.map((verb) => {
            const base = VERB_TEACHING[verb];
            if (verb === "discover" && entry.discovery?.details !== undefined) {
                return `- \`${verb}\`: ${base.summary} ${base.details}\n\n${entry.discovery.details}`;
            }
            return `- \`${verb}\`: ${base.summary} ${base.details}`;
        });
        if (verbLines.length > 0) {
            sections.push(`## Verbs\n\n${verbLines.join("\n")}`);
        }
        if (verbs.includes("add") && entry.example !== undefined) {
            sections.push(PlurnkParser.frame(`plurnk (${entry.family})`, JSON.stringify({ verb: "add", ...entry.example })));
        }
        const docBody = entry.documentBody === undefined ? "" : stripLeadingHeading(entry.documentBody);
        if (docBody.length > 0) {
            sections.push(docBody);
        }
        return sections.join("\n\n");
    }

    static #familyTool(entry: FunctionalityFamilyEntry): RuntimeRegisteredTool {
        const verbs = FunctionalityManager.#verbsFor(entry);
        const summary = FunctionalityManager.#familySummary(entry);
        const inputSchema = FunctionalityManager.#familyInputSchema(entry, verbs);
        const details = FunctionalityManager.#familyDetails(entry, verbs);
        const description = [summary, details].filter((part) => part.length > 0).join("\n\n");
        return {
            target: entry.family,
            summary,
            ...(entry.traits === undefined ? {} : { traits: entry.traits }),
            invocation: {
                body: { role: "JSON arguments", required: false, mimetype: "application/json" },
                target: { role: "Plurnk tool", required: true, kind: "literal" },
                inputSchema,
            },
            ...(details.length === 0 ? {} : { details }),
            definition: {
                name: entry.family,
                description,
                inputSchema,
            },
        };
    }

    toolRegistry(workspaceId?: number): RuntimeToolRegistry {
        const familyTools = this.#entries(workspaceId)
            .filter((entry) => FunctionalityManager.#verbsFor(entry).length > 0)
            .map((entry) => FunctionalityManager.#familyTool(entry));
        const tools = this.#includeQuestion(workspaceId)
            ? [...familyTools, questionRegisteredTool]
            : familyTools;
        return { tools };
    }

    override async run(args: ExecArgs): Promise<ExecResult> {
        const target = args.target;
        if (target === "question" && this.#includeQuestion(this.#workspaceId)) {
            return this.#question.run(args);
        }
        const entry = this.#entries(this.#workspaceId).find((candidate) => candidate.family === target);
        if (entry === undefined) {
            const available = this.toolRegistry(this.#workspaceId).tools.map((tool) => tool.target);
            return Results.failure("functionality", "verb-unknown", 400, `'${target ?? ""}' is not a plurnk tool.`, {}, {
                recovery: `Select one of ${available.join(", ")}.`,
                retryable: false,
            });
        }
        const verbs = FunctionalityManager.#verbsFor(entry);
        let verb: FunctionalityVerb;
        let params: unknown = {};
        if (args.body.trim().length === 0) {
            if (!verbs.includes("list")) {
                return Results.failure("functionality", "verb-unknown", 400, `'' is not a ${entry.family} lifecycle verb.`, {}, {
                    recovery: `Select one of ${verbs.join(", ")}.`,
                    retryable: false,
                });
            }
            verb = "list";
        } else {
            let parsed: unknown;
            try {
                parsed = JSON.parse(args.body);
            } catch (cause) {
                return Results.failure("functionality", "arguments-not-json", 400, `The ${entry.family} body must be a JSON object.`, {}, {
                    recovery: "Supply a JSON object body.",
                    retryable: false,
                    cause: ErrorDetail.preview(cause),
                });
            }
            if (!isRecord(parsed)) {
                return Results.failure("functionality", "arguments-invalid", 400, `The ${entry.family} body must be a JSON object.`, {}, {
                    recovery: `Supply a JSON object with a "verb" field (${verbs.join(", ")}).`,
                    retryable: false,
                });
            }
            const rawVerb = parsed.verb === undefined && Object.keys(parsed).length === 0 ? "list" : parsed.verb;
            if (!isFunctionalityVerb(rawVerb) || !verbs.includes(rawVerb)) {
                return Results.failure("functionality", "verb-unknown", 400, `'${typeof rawVerb === "string" ? rawVerb : ""}' is not a ${entry.family} lifecycle verb.`, {}, {
                    recovery: `Select one of ${verbs.join(", ")}.`,
                    retryable: false,
                });
            }
            const { verb: _verb, ...rest } = parsed;
            verb = rawVerb;
            params = rest;
        }
        const identity = { workspaceId: this.#workspaceId, ...(this.#workerId === undefined ? {} : { workerId: this.#workerId }) };
        let result: { status: number; body: unknown };
        let refusal: ExecResult | null = null;
        try {
            result = await this.#coordinator.invoke(
                entry.family,
                verb,
                params,
                identity,
                "operation",
                {
                    env: EnvFunctionality.modifier(args.metadata),
                    onAuthorizationRequired: (aliases) => {
                        for (const alias of aliases) {
                            args.emit({
                                source: `functionality:${entry.family}`,
                                kind: "authorization_required",
                                level: "info",
                                message: entry.family === "mcp"
                                    ? `MCP server '${alias}' awaits sign-in (/mcp oauth ${alias}).`
                                    : `${entry.family} '${alias}' awaits authorization.`,
                            });
                        }
                    },
                },
                args.signal,
            );
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
        return refusal ?? { status: result.status };
    }
}
