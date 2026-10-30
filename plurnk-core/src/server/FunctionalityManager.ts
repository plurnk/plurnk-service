// {§functionality-model-projection} — the model-facing `plurnk_<family>` runtime
// executors: one runtime per workspace Functionality family (`plurnk_env`,
// `plurnk_mcp`, `plurnk_skills`, `plurnk_schedule`, `plurnk_members`) whose
// tools are its lifecycle verbs (`list`, `discover`, `add`, `replace`,
// `enable`, `disable`, `remove`), alongside `plurnk_question (ask)`
// ({§question-tool}), published under `mcp:///plurnk_*.md`.
import { BaseExecutor, ToolInputSchema } from "@plurnk/plurnk-execs";
import type {
    ChannelDecl,
    Effect,
    ExecArgs,
    ExecResult,
    RuntimeAvailability,
    RuntimeDecl,
    RuntimeRegisteredTool,
    RuntimeToolRegistry,
} from "@plurnk/plurnk-execs";
import type { FunctionalityDiscovery } from "@plurnk/plurnk-modules";
import { Problems, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import ErrorDetail from "../core/ErrorDetail.ts";
import type ExecutorRegistry from "../core/ExecutorRegistry.ts";
import type { RegistryEntry, RuntimeRegistryRegistration } from "../core/ExecutorRegistry.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import QuestionTool, { plurnkQuestionRuntimeDecl } from "../schemes/QuestionTool.ts";
export { plurnkQuestionRuntimeDecl };
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

// {§functionality-replacement} The family's verbs are exactly those with an input schema.
type FunctionalityTeaching = {
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
        readonly sessionId?: number;
        readonly executors?: () => ExecutorRegistry | undefined;
        readonly entry: FunctionalityFamilyEntry | ((workspaceId?: number) => FunctionalityFamilyEntry);
    }
    | ({
        readonly coordinator: Functionality;
        readonly workspaceId?: number;
        readonly sessionId?: number;
        readonly executors?: () => ExecutorRegistry | undefined;
    } & FunctionalityFamilyEntry);

const isFunctionalityVerb = (value: unknown): value is FunctionalityVerb =>
    typeof value === "string" && (FUNCTIONALITY_VERBS as readonly string[]).includes(value);

const stripLeadingHeading = (markdown: string): string =>
    markdown.trim().replace(/^# [^\n]*\n+/u, "").trim();

export const plurnkFamilyRuntimeDecl = (entry: FunctionalityFamilyEntry): RuntimeDecl & { readonly glyph: string } => {
    const firstVerb = FUNCTIONALITY_VERBS.find((verb) => entry.inputSchemas[verb] !== undefined) ?? "list";
    return {
        name: `plurnk_${entry.family}`,
        glyph: "🔌",
        summary: {
            from: "tools",
            description: FunctionalityManager.familySummary(entry),
        },
        resourcesPath: "/tools",
        invocation: {
            body: { role: "JSON arguments", required: false, mimetype: "application/json" },
            target: { role: `${entry.family} lifecycle verb`, required: true, kind: "literal" },
            example: { target: firstVerb, body: "{}" },
        },
        details: FunctionalityManager.familyDetails(entry),
    };
};

export const questionRuntimeEntry = (): RegistryEntry => ({
    executor: new QuestionTool(),
    namespaceOwner: { kind: "module", name: "core" },
    glyph: plurnkQuestionRuntimeDecl.glyph,
    summary: plurnkQuestionRuntimeDecl.summary,
    invocation: plurnkQuestionRuntimeDecl.invocation,
    details: plurnkQuestionRuntimeDecl.details ?? "",
    ...(plurnkQuestionRuntimeDecl.resourcesPath === undefined ? {} : { resourcesPath: plurnkQuestionRuntimeDecl.resourcesPath }),
    available: true,
    detail: "in-process",
});

export default class FunctionalityManager extends BaseExecutor {
    readonly #coordinator: Functionality;
    readonly #workspaceId: number;
    readonly #sessionId: number | undefined;
    readonly #family: string;
    readonly #entrySource: FunctionalityFamilyEntry | ((workspaceId?: number) => FunctionalityFamilyEntry);
    readonly #executors: (() => ExecutorRegistry | undefined) | undefined;

    constructor(args: FunctionalityManagerOptions) {
        const entrySource = "entry" in args ? args.entry : args;
        const initial = typeof entrySource === "function" ? entrySource(args.workspaceId) : entrySource;
        super({ runtime: `plurnk_${initial.family}`, glyph: "🔌" });
        this.#coordinator = args.coordinator;
        this.#workspaceId = args.workspaceId ?? 1;
        this.#sessionId = args.sessionId;
        this.#family = initial.family;
        this.#entrySource = entrySource;
        this.#executors = args.executors;
    }

    get family(): string {
        return this.#family;
    }

    runtimeDecl(workspaceId?: number): RuntimeDecl & { readonly glyph: string } {
        return plurnkFamilyRuntimeDecl(this.#entry(workspaceId));
    }

    static forFamily(args: FunctionalityManagerOptions): FunctionalityManager {
        return new FunctionalityManager(args);
    }

    static forQuestion(): QuestionTool {
        return new QuestionTool();
    }

    static runtimeRegistrations(
        coordinator: Functionality,
        options: { readonly includeQuestion?: boolean; readonly executors?: () => ExecutorRegistry | undefined } = {},
    ): RuntimeRegistryRegistration[] {
        const entries = coordinator.familyEntries();
        const families: RuntimeRegistryRegistration[] = entries.map((initial) => {
            const decl = plurnkFamilyRuntimeDecl(initial);
            return {
                tag: decl.name,
                entry: {
                    executor: new FunctionalityManager({
                        coordinator,
                        ...(options.executors === undefined ? {} : { executors: options.executors }),
                        entry: (workspaceId) =>
                            coordinator.familyEntries(workspaceId).find((candidate) => candidate.family === initial.family) ?? initial,
                    }),
                    namespaceOwner: { kind: "module", name: "core" },
                    glyph: decl.glyph,
                    summary: decl.summary,
                    invocation: decl.invocation,
                    details: decl.details ?? "",
                    ...(decl.resourcesPath === undefined ? {} : { resourcesPath: decl.resourcesPath }),
                    available: true,
                    detail: "in-process",
                    workspaceDecl: (workspaceId) => {
                        const current = coordinator.familyEntries(workspaceId).find((candidate) => candidate.family === initial.family) ?? initial;
                        const currentDecl = plurnkFamilyRuntimeDecl(current);
                        return { summary: currentDecl.summary, details: currentDecl.details ?? "" };
                    },
                },
            };
        });
        if (options.includeQuestion !== false) {
            families.push({
                tag: plurnkQuestionRuntimeDecl.name,
                entry: questionRuntimeEntry(),
            });
        }
        return families;
    }

    // {§functionality-model-projection} — the published manager closes over the coordinator; Core binds
    // the invoking workspace and Session at the operation ({§functionality-coordinator}), so a session-scoped family's
    // verbs act for that Session. A bound instance is per operation, never retained on the published one.
    forSession(sessionId: number): FunctionalityManager {
        return this.forContext(this.#workspaceId, sessionId);
    }

    forContext(workspaceId: number, sessionId: number): FunctionalityManager {
        return new FunctionalityManager({
            coordinator: this.#coordinator,
            workspaceId,
            sessionId,
            entry: this.#entrySource,
            ...(this.#executors === undefined ? {} : { executors: this.#executors }),
        });
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { [CHANNEL]: { mimetype: "application/json" } };
    }

    override get publishedChannel(): string {
        return CHANNEL;
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "workspace Functionality manager" };
    }

    // {§functionality-model-projection} — `list` and `discover` are `read`;
    // lifecycle mutations (`add`, `replace`, `enable`, `disable`, `remove`) are `host`.
    override effect(target: string | null): Effect {
        return this.effectForInvocation(target, "", this.#workspaceId);
    }

    effectForInvocation(target: string | null, _body = "", workspaceId?: number): Effect {
        const entry = this.#entry(workspaceId);
        const verb = target === null || target.length === 0 ? "list" : target;
        return isFunctionalityVerb(verb) && READ_VERBS.has(verb) && entry.inputSchemas[verb] !== undefined
            ? "read"
            : "host";
    }

    hasConfigurationFailure(workspaceId?: number): boolean {
        const failure = this.#entry(workspaceId).configurationFailure;
        return failure !== null && failure !== undefined;
    }

    #entry(workspaceId?: number): FunctionalityFamilyEntry {
        const targetWorkspace = workspaceId ?? this.#workspaceId;
        return typeof this.#entrySource === "function"
            ? this.#entrySource(targetWorkspace)
            : this.#entrySource;
    }

    static #verbsFor(entry: FunctionalityFamilyEntry): FunctionalityVerb[] {
        return FUNCTIONALITY_VERBS.filter((verb) => entry.inputSchemas[verb] !== undefined);
    }

    static familySummary(entry: FunctionalityFamilyEntry): string {
        const base = entry.summary ?? `Manage ${entry.family} definitions.`;
        return entry.configurationFailure !== null && entry.configurationFailure !== undefined
            ? `${base.replace(/\.$/u, "")} — configuration unavailable; inspect with list`
            : base;
    }

    static familyDetails(entry: FunctionalityFamilyEntry): string {
        const verbs = FunctionalityManager.#verbsFor(entry);
        const sections: string[] = [];
        if (entry.configurationFailure !== null && entry.configurationFailure !== undefined) {
            sections.push(`> [!WARNING]\n> ${entry.configurationFailure.error.message}`);
        }
        if (verbs.includes("discover") && entry.discovery?.details !== undefined) {
            sections.push(entry.discovery.details);
        }
        if (verbs.includes("add") && entry.example !== undefined) {
            sections.push(PlurnkParser.frame(`plurnk_${entry.family} (add)`, JSON.stringify(entry.example)));
        }
        const docBody = entry.documentBody === undefined ? "" : stripLeadingHeading(entry.documentBody);
        if (docBody.length > 0) {
            sections.push(docBody);
        }
        return sections.join("\n\n");
    }

    static #verbTool(entry: FunctionalityFamilyEntry, verb: FunctionalityVerb): RuntimeRegisteredTool {
        const inputSchema = entry.inputSchemas[verb]!;
        const base = VERB_TEACHING[verb];
        const summary = verb === "list" && entry.configurationFailure !== null && entry.configurationFailure !== undefined
            ? `${base.summary.replace(/\.$/u, "")} — configuration unavailable`
            : base.summary;
        const detailParts: string[] = [];
        if (verb === "list" && entry.configurationFailure !== null && entry.configurationFailure !== undefined) {
            detailParts.push(`> [!WARNING]\n> ${entry.configurationFailure.error.message}`);
        }
        detailParts.push(base.details);
        if (verb === "discover" && entry.discovery?.details !== undefined) {
            detailParts.push(entry.discovery.details);
        }
        if (verb === "add" && entry.example !== undefined) {
            detailParts.push(PlurnkParser.frame(`plurnk_${entry.family} (add)`, JSON.stringify(entry.example)));
        }
        if (verb === "add" && entry.documentBody !== undefined) {
            const docBody = stripLeadingHeading(entry.documentBody);
            if (docBody.length > 0) detailParts.push(docBody);
        }
        const details = detailParts.join("\n\n");
        const description = [summary, details].filter((part) => part.length > 0).join("\n\n");
        const bodyRequired = ToolInputSchema.requiredFields(inputSchema).length > 0;
        return {
            target: verb,
            summary,
            ...(entry.traits === undefined ? {} : { traits: entry.traits }),
            invocation: {
                body: { role: "JSON arguments", required: bodyRequired, mimetype: "application/json" },
                target: { role: `${entry.family} lifecycle verb`, required: true, kind: "literal" },
                inputSchema,
            },
            ...(details.length === 0 ? {} : { details }),
            definition: {
                name: verb,
                description,
                inputSchema,
            },
        };
    }

    toolRegistry(workspaceId?: number): RuntimeToolRegistry {
        const entry = this.#entry(workspaceId);
        const tools = FunctionalityManager.#verbsFor(entry)
            .map((verb) => FunctionalityManager.#verbTool(entry, verb));
        return { tools };
    }

    override async run(args: ExecArgs): Promise<ExecResult> {
        const entry = this.#entry(this.#workspaceId);
        const verbs = FunctionalityManager.#verbsFor(entry);
        const rawTarget = args.target === null || args.target.length === 0
            ? (args.body.trim().length === 0 && verbs.includes("list") ? "list" : "")
            : args.target;
        if (!isFunctionalityVerb(rawTarget) || !verbs.includes(rawTarget)) {
            return Results.failure("functionality", "verb-unknown", 400, `'${rawTarget}' is not a ${entry.family} lifecycle verb.`, {}, {
                recovery: `Select one of ${verbs.join(", ")}.`,
                retryable: false,
            });
        }
        const verb: FunctionalityVerb = rawTarget;
        let params: unknown = {};
        if (args.body.trim().length > 0) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(args.body);
            } catch (cause) {
                return Results.failure("functionality", "arguments-not-json", 400, `The ${entry.family} ${verb} body must be a JSON object.`, {}, {
                    recovery: "Supply a JSON object body.",
                    retryable: false,
                    cause: ErrorDetail.preview(cause),
                });
            }
            if (!isRecord(parsed)) {
                return Results.failure("functionality", "arguments-invalid", 400, `The ${entry.family} ${verb} body must be a JSON object.`, {}, {
                    recovery: "Supply a JSON object body.",
                    retryable: false,
                });
            }
            params = parsed;
        }
        const identity = { workspaceId: this.#workspaceId, ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }) };
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
        const formatted = verb === "list" && refusal === null
            ? FunctionalityManager.#formatListBody(
                entry.family,
                result.body,
                entry.family === "mcp" ? (this.#executors?.()?.inProcessToolServers(this.#workspaceId) ?? []) : [],
            )
            : JSON.stringify(result.body, null, 2);
        args.write(CHANNEL, formatted, "application/json");
        // {§functionality-model-projection} Resource readiness is the body; this invocation has settled.
        args.setState(CHANNEL, result.status >= 400 ? "errored" : "closed");
        return refusal ?? { status: result.status };
    }

    static #formatListBody(
        family: string,
        body: unknown,
        inProcessServers: ReadonlyArray<{
            readonly alias: string;
            readonly state: "active" | "unavailable";
            readonly description?: string;
            readonly docs: string;
        }> = [],
    ): string {
        if (!isRecord(body) || !Array.isArray(body.definitions)) {
            return JSON.stringify(body, null, 2);
        }
        const definitions = family === "mcp"
            ? (() => {
                const external = body.definitions.map((item): Record<string, unknown> => {
                    if (!isRecord(item)) return { value: item };
                    const detail = isRecord(item.detail) ? item.detail : null;
                    return {
                        alias: item.alias,
                        state: item.state,
                        ...(detail !== null && typeof detail.description === "string" ? { description: detail.description } : {}),
                        ...(detail !== null ? { docs: typeof detail.docs === "string" ? detail.docs : `mcp:///${String(item.alias)}.md` } : {}),
                        ...(detail !== null && typeof detail.resources === "number" && detail.resources > 0 ? { resources: detail.resources } : {}),
                        ...(detail !== null && typeof detail.resourceTemplates === "number" && detail.resourceTemplates > 0 ? { resourceTemplates: detail.resourceTemplates } : {}),
                        ...(detail !== null && typeof detail.prompts === "number" && detail.prompts > 0 ? { prompts: detail.prompts } : {}),
                        ...(detail !== null && Array.isArray(detail.skills) && detail.skills.length > 0 ? { skills: detail.skills } : {}),
                        ...(item.authorization === undefined ? {} : { authorization: item.authorization }),
                        ...(item.problem === undefined ? {} : { problem: item.problem }),
                    };
                });
                const seen = new Set(external.map((item) => typeof item.alias === "string" ? item.alias : ""));
                const merged: Array<Record<string, unknown>> = [
                    ...external,
                    ...inProcessServers.filter(({ alias }) => !seen.has(alias)),
                ];
                return merged.toSorted((left, right) =>
                    (typeof left.alias === "string" ? left.alias : "").localeCompare(typeof right.alias === "string" ? right.alias : ""));
            })()
            : body.definitions;
        if (definitions.length === 0) {
            return JSON.stringify({ ...body, definitions: [] });
        }
        const lines = definitions.map((def) => `  ${JSON.stringify(def)}`);
        return `{\n  "family": ${JSON.stringify(body.family)},\n  "definitions": [\n${lines.join(",\n")}\n  ]\n}`;
    }
}
