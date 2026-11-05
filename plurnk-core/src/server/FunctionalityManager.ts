// {§functionality-model-projection} — the model-facing `plurnk` runtime
// executor: one in-process tool server whose tools are the workspace
// Functionality families (`env`, `mcp`, `skills`, `personas`, `schedule`,
// `members`) plus `question` ({§question-tool}), published at
// `mcp:///plurnk.md` and `mcp:///plurnk/<tool>.json`.
import { BaseExecutor } from "@plurnk/plurnk-execs";
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
import { OutputScheme, type SchemeManifest } from "@plurnk/plurnk-schemes";
import { Problems, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import ErrorDetail from "../core/ErrorDetail.ts";
import type ExecutorRegistry from "../core/ExecutorRegistry.ts";
import type { RuntimeRegistryRegistration } from "../core/ExecutorRegistry.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import QuestionTool, { questionRegisteredTool } from "../schemes/QuestionTool.ts";
import type Functionality from "./Functionality.ts";
import type { FunctionalityConfigurationFailure } from "./Functionality.ts";

const CHANNEL = "results";
export const FUNCTIONALITY_VERBS = Object.freeze(["list", "discover", "add", "replace", "enable", "disable", "remove"] as const);
export type FunctionalityVerb = (typeof FUNCTIONALITY_VERBS)[number];
const READ_VERBS: ReadonlySet<FunctionalityVerb> = new Set(["list", "discover"]);

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
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
        readonly entries: readonly FunctionalityFamilyEntry[] | ((workspaceId?: number) => readonly FunctionalityFamilyEntry[]);
    }
    | {
        readonly coordinator: Functionality;
        readonly workspaceId?: number;
        readonly sessionId?: number;
        readonly executors?: () => ExecutorRegistry | undefined;
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
        readonly entry: FunctionalityFamilyEntry | ((workspaceId?: number) => FunctionalityFamilyEntry);
    }
    | ({
        readonly coordinator: Functionality;
        readonly workspaceId?: number;
        readonly sessionId?: number;
        readonly executors?: () => ExecutorRegistry | undefined;
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
    } & FunctionalityFamilyEntry);

const stripLeadingHeading = (markdown: string): string =>
    markdown.trim().replace(/^# [^\n]*\n+/u, "").trim();

export const plurnkRuntimeDecl: RuntimeDecl & { readonly glyph: string } = {
    name: "plurnk",
    glyph: "🔌",
    summary: {
        from: "tools",
        description: "Manage env, mcp, members, personas, schedule, and skills; ask the user questions.",
    },
    resourcesPath: "/tools",
    invocation: {
        body: { role: "JSON arguments", required: false, mimetype: "application/json" },
        target: { role: "Plurnk tool", required: true, kind: "literal" },
        example: { target: "members", body: "{}" },
    },
    details: "",
};

export default class FunctionalityManager extends BaseExecutor {
    readonly #coordinator: Functionality;
    readonly #workspaceId: number;
    readonly #sessionId: number | undefined;
    readonly #entriesSource: readonly FunctionalityFamilyEntry[] | ((workspaceId?: number) => readonly FunctionalityFamilyEntry[]);
    readonly #includeQuestionSource: boolean | ((workspaceId?: number) => boolean);
    readonly #executors: (() => ExecutorRegistry | undefined) | undefined;
    readonly #question: QuestionTool;

    constructor(args: FunctionalityManagerOptions) {
        super({ runtime: plurnkRuntimeDecl.name, glyph: plurnkRuntimeDecl.glyph });
        this.#coordinator = args.coordinator;
        this.#workspaceId = args.workspaceId ?? 1;
        this.#sessionId = args.sessionId;
        this.#executors = args.executors;
        this.#question = new QuestionTool({ runtime: plurnkRuntimeDecl.name, glyph: plurnkRuntimeDecl.glyph });
        if ("entries" in args) {
            this.#entriesSource = args.entries;
            this.#includeQuestionSource = args.includeQuestion ?? true;
        } else if ("entry" in args) {
            const entrySource = args.entry;
            this.#entriesSource = typeof entrySource === "function"
                ? (workspaceId) => [entrySource(workspaceId)]
                : [entrySource];
            this.#includeQuestionSource = args.includeQuestion ?? false;
        } else {
            this.#entriesSource = [args];
            this.#includeQuestionSource = args.includeQuestion ?? false;
        }
    }

    static runtimeRegistrations(
        coordinator: Functionality,
        options: { readonly includeQuestion?: boolean; readonly executors?: () => ExecutorRegistry | undefined } = {},
    ): RuntimeRegistryRegistration[] {
        return [{
            tag: plurnkRuntimeDecl.name,
            entry: {
                executor: new FunctionalityManager({
                    coordinator,
                    ...(options.executors === undefined ? {} : { executors: options.executors }),
                    entries: (workspaceId) => coordinator.familyEntries(workspaceId),
                    includeQuestion: options.includeQuestion ?? true,
                }),
                namespaceOwner: { kind: "module", name: "core" },
                glyph: plurnkRuntimeDecl.glyph,
                summary: plurnkRuntimeDecl.summary,
                invocation: plurnkRuntimeDecl.invocation,
                details: plurnkRuntimeDecl.details ?? "",
                ...(plurnkRuntimeDecl.resourcesPath === undefined ? {} : { resourcesPath: plurnkRuntimeDecl.resourcesPath }),
                available: true,
                detail: "in-process",
            },
        }];
    }

    // {§functionality-model-projection} — the published manager closes over the coordinator; Core binds
    // the invoking workspace and Session at the operation ({§functionality-coordinator}), so a session-scoped family's
    // operations act for that Session. A bound instance is per operation, never retained on the published one.
    forSession(sessionId: number): FunctionalityManager {
        return this.forContext(this.#workspaceId, sessionId);
    }

    forContext(workspaceId: number, sessionId: number): FunctionalityManager {
        return new FunctionalityManager({
            coordinator: this.#coordinator,
            workspaceId,
            sessionId,
            entries: this.#entriesSource,
            includeQuestion: this.#includeQuestionSource,
            ...(this.#executors === undefined ? {} : { executors: this.#executors }),
        });
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { [CHANNEL]: { mimetype: "application/json" } };
    }

    override get publishedChannel(): string {
        return CHANNEL;
    }

    override get manifest(): SchemeManifest {
        return {
            ...OutputScheme.manifestFromRuntime({
                name: this.runtime,
                glyph: this.glyph,
                channels: {
                    readable: "text/markdown",
                    [CHANNEL]: "application/json",
                },
                defaultChannel: "body",
                traits: this.traits,
            }),
            writableBy: ["_plurnk"],
            folderScopes: true,
            textEditScopes: true,
        };
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "workspace Functionality manager" };
    }

    // {§functionality-model-projection} — `list`, `discover`, and `question` are `read`;
    // lifecycle mutations (`add`, `replace`, `enable`, `disable`, `remove`) are `host`.
    override effect(target: string | null): Effect {
        return this.effectForInvocation(target, "", this.#workspaceId);
    }

    effectForInvocation(target: string | null, body = "", workspaceId?: number): Effect {
        if (target === "question" && this.#includeQuestion(workspaceId)) {
            return "read";
        }
        const entry = this.#resolveEntry(target, workspaceId);
        if (entry === undefined) return "host";
        const verbs = FunctionalityManager.#verbsFor(entry);
        const trimmed = body.trim();
        if (trimmed.length === 0) {
            return verbs.includes("list") ? "read" : "host";
        }
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (!isRecord(parsed)) return "host";
            const { verb } = FunctionalityManager.#resolveInvocation(entry, verbs, parsed);
            return READ_VERBS.has(verb) && verbs.includes(verb) ? "read" : "host";
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

    #resolveEntry(target: string | null, workspaceId?: number): FunctionalityFamilyEntry | undefined {
        const entries = this.#entries(workspaceId);
        if (target === null || target.length === 0) {
            return entries.length === 1 && !this.#includeQuestion(workspaceId) ? entries[0] : undefined;
        }
        return entries.find((candidate) => candidate.family === target);
    }

    static #verbsFor(entry: FunctionalityFamilyEntry): FunctionalityVerb[] {
        return FUNCTIONALITY_VERBS.filter((verb) => entry.inputSchemas[verb] !== undefined);
    }

    static familySummary(entry: FunctionalityFamilyEntry): string {
        const base = entry.summary ?? `Manage ${entry.family} definitions.`;
        return entry.configurationFailure !== null && entry.configurationFailure !== undefined
            ? `${base.replace(/\.$/u, "")} — configuration unavailable; inspect with {}`
            : base;
    }

    static #mergeProperty(properties: Record<string, JsonSchema>, key: string, prop: JsonSchema): void {
        if (typeof prop.const === "string") {
            const existing = properties[key];
            if (isRecord(existing) && Array.isArray(existing.enum)) {
                if (!existing.enum.includes(prop.const)) {
                    properties[key] = { ...existing, enum: [...existing.enum, prop.const] };
                }
                return;
            }
            const { const: constValue, ...rest } = prop;
            properties[key] = {
                ...rest,
                type: "string",
                enum: [constValue],
            };
            return;
        }
        if (!Object.hasOwn(properties, key)) {
            properties[key] = prop;
        }
    }

    static #collectSchemaProperties(
        schema: JsonSchema | undefined,
        properties: Record<string, JsonSchema>,
        defs: Record<string, JsonSchema>,
    ): void {
        if (!isRecord(schema)) return;
        if (isRecord(schema.$defs)) {
            for (const [defKey, defSchema] of Object.entries(schema.$defs)) {
                if (isRecord(defSchema) && !Object.hasOwn(defs, defKey)) {
                    defs[defKey] = defSchema;
                }
            }
        }
        if (isRecord(schema.properties)) {
            for (const [key, prop] of Object.entries(schema.properties)) {
                if (isRecord(prop)) {
                    FunctionalityManager.#mergeProperty(properties, key, prop);
                }
            }
        }
        for (const keyword of ["oneOf", "anyOf"] as const) {
            const branches = schema[keyword];
            if (Array.isArray(branches)) {
                for (const branch of branches) {
                    if (isRecord(branch)) {
                        FunctionalityManager.#collectSchemaProperties(branch, properties, defs);
                    }
                }
            }
        }
    }

    static #familyInputSchema(entry: FunctionalityFamilyEntry, verbs: readonly FunctionalityVerb[]): JsonSchema {
        const properties: Record<string, JsonSchema> = {};
        const defs: Record<string, JsonSchema> = {};
        for (const verb of ["add", "replace", "enable", "disable", "remove", "list"] as const) {
            if (verbs.includes(verb)) {
                FunctionalityManager.#collectSchemaProperties(entry.inputSchemas[verb], properties, defs);
            }
        }
        if (verbs.includes("enable") || verbs.includes("disable")) {
            properties.enabled = {
                type: "boolean",
                description: "Enable (true) or disable (false) the definition.",
            };
        }
        if (verbs.includes("remove")) {
            properties.remove = {
                type: "boolean",
                description: "Set true to remove the local definition and restore inheritance.",
            };
        }
        if (verbs.includes("discover") && isRecord(entry.inputSchemas.discover)) {
            const rawDiscoverProps: Record<string, JsonSchema> = {};
            FunctionalityManager.#collectSchemaProperties(entry.inputSchemas.discover, rawDiscoverProps, defs);
            const { scope: _scope, ...discoverProps } = rawDiscoverProps;
            if (!Object.hasOwn(properties, "scope") && rawDiscoverProps.scope !== undefined) {
                properties.scope = rawDiscoverProps.scope;
            }
            const primaryInput = entry.discovery?.inputs[0] ?? "query";
            const allowsEmpty = entry.discovery?.emptyListsAll === true;
            properties.discover = {
                type: allowsEmpty ? ["string", "object", "boolean"] : ["string", "object"],
                description: allowsEmpty
                    ? `Search or list candidates without installing them. Pass a ${primaryInput} string, true / "" to list all, or an object.`
                    : `Search or inspect candidates without installing them. Pass a ${primaryInput} string or an object.`,
                ...(Object.keys(discoverProps).length === 0 ? {} : {
                    properties: discoverProps,
                    additionalProperties: false,
                }),
            };
        }
        return {
            type: "object",
            additionalProperties: false,
            properties,
            ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
        };
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
            sections.push(`await plurnk.${entry.family}(${JSON.stringify(entry.example)});`);
        }
        const docBody = entry.documentBody === undefined ? "" : stripLeadingHeading(entry.documentBody);
        if (docBody.length > 0) {
            sections.push(docBody);
        }
        return sections.join("\n\n");
    }

    static #familyTool(entry: FunctionalityFamilyEntry): RuntimeRegisteredTool {
        const verbs = FunctionalityManager.#verbsFor(entry);
        const summary = FunctionalityManager.familySummary(entry);
        const inputSchema = FunctionalityManager.#familyInputSchema(entry, verbs);
        const details = FunctionalityManager.familyDetails(entry);
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

    static #hasScope(entry: FunctionalityFamilyEntry): boolean {
        const listProps = isRecord(entry.inputSchemas.list) && isRecord(entry.inputSchemas.list.properties)
            ? entry.inputSchemas.list.properties
            : null;
        return listProps !== null && Object.hasOwn(listProps, "scope");
    }

    static #resolveInvocation(
        entry: FunctionalityFamilyEntry,
        verbs: readonly FunctionalityVerb[],
        rawParsed: Record<string, unknown> | null,
    ): { verb: FunctionalityVerb; params: Record<string, unknown> } {
        if (rawParsed === null) {
            return { verb: "list", params: {} };
        }
        const parsed = !FunctionalityManager.#hasScope(entry) && rawParsed.scope === "workspace"
            ? (() => {
                const { scope: _scope, ...rest } = rawParsed;
                return rest;
            })()
            : rawParsed;
        const keys = Object.keys(parsed);
        const nonScopeKeys = keys.filter((key) => key !== "scope");
        if (nonScopeKeys.length === 0) {
            return { verb: "list", params: parsed };
        }
        if (Object.hasOwn(parsed, "discover")) {
            const { discover: rawDiscover, ...rest } = parsed;
            if (typeof rawDiscover === "string") {
                if (rawDiscover.trim().length === 0 && entry.discovery?.emptyListsAll === true) {
                    return { verb: "discover", params: rest };
                }
                const primaryInput = entry.discovery?.inputs[0] ?? "query";
                return { verb: "discover", params: { ...rest, [primaryInput]: rawDiscover } };
            }
            if (rawDiscover === true) {
                return { verb: "discover", params: rest };
            }
            if (isRecord(rawDiscover)) {
                return { verb: "discover", params: { ...rest, ...rawDiscover } };
            }
            return { verb: "discover", params: parsed };
        }
        if (Object.hasOwn(parsed, "remove")) {
            if (parsed.remove === true) {
                const { remove: _remove, ...rest } = parsed;
                return { verb: "remove", params: rest };
            }
            return { verb: "remove", params: parsed };
        }
        if (
            Object.hasOwn(parsed, "enabled")
            && nonScopeKeys.every((key) => key === "enabled" || key === "alias" || key === "file")
        ) {
            if (typeof parsed.enabled === "boolean") {
                const verb: FunctionalityVerb = parsed.enabled ? "enable" : "disable";
                const { enabled: _enabled, ...rest } = parsed;
                return { verb, params: rest };
            }
            return { verb: "enable", params: parsed };
        }
        const upsertVerb: FunctionalityVerb = verbs.includes("add") ? "add" : (verbs.includes("replace") ? "replace" : "add");
        if (parsed.enabled === true) {
            const { enabled: _enabled, ...rest } = parsed;
            return { verb: upsertVerb, params: rest };
        }
        return { verb: upsertVerb, params: parsed };
    }

    override async run(args: ExecArgs): Promise<ExecResult> {
        const target = args.target;
        if (target === "question" && this.#includeQuestion(this.#workspaceId)) {
            return this.#question.run(args);
        }
        const entry = this.#resolveEntry(target, this.#workspaceId);
        if (entry === undefined) {
            const available = this.toolRegistry(this.#workspaceId).tools.map((tool) => tool.target);
            return Results.failure("functionality", "verb-unknown", 400, `'${target ?? ""}' is not a plurnk tool.`, {}, {
                recovery: `Select one of ${available.join(", ")}.`,
                retryable: false,
            });
        }
        const verbs = FunctionalityManager.#verbsFor(entry);
        let parsedBody: Record<string, unknown> | null = null;
        if (args.body.trim().length > 0) {
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
                    recovery: "Supply a JSON object body.",
                    retryable: false,
                });
            }
            parsedBody = parsed;
        }
        const resolved = FunctionalityManager.#resolveInvocation(entry, verbs, parsedBody);
        let verb = resolved.verb;
        const params = resolved.params;
        if (!verbs.includes(verb)) {
            return Results.failure("functionality", "verb-unknown", 400, `'${verb}' is not a ${entry.family} lifecycle verb.`, {}, {
                recovery: `Select one of ${verbs.join(", ")}.`,
                retryable: false,
            });
        }
        const identity = { workspaceId: this.#workspaceId, ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }) };
        const invokeVerb = async (candidateVerb: FunctionalityVerb) =>
            this.#coordinator.invoke(
                entry.family,
                candidateVerb,
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
        let result: { status: number; body: unknown };
        let refusal: ExecResult | null = null;
        try {
            try {
                result = await invokeVerb(verb);
            } catch (firstCause) {
                const firstProblem = Problems.fromError(firstCause);
                if (
                    verb === "add"
                    && verbs.includes("replace")
                    && firstProblem !== null
                    && firstProblem.type.endsWith("/alias-exists")
                ) {
                    verb = "replace";
                    result = await invokeVerb("replace");
                } else {
                    throw firstCause;
                }
            }
        } catch (cause) {
            // {§functionality-model-projection} — a coordinator refusal (alias taken, scope, admission) is the
            // verb's own outcome with its own status, never an executor fault: it streams as the result,
            // and the executor reports that same failure (status + Problem) as its operation result.
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            refusal = cause instanceof OperationFailureError ? cause.result : { status: problem.status, problem };
            result = { status: refusal.status, body: refusal };
        }
        const inProcessServers = entry.family === "mcp"
            ? (this.#executors?.()?.inProcessToolServers(this.#workspaceId) ?? [])
            : [];
        const partialMcpList = verb === "list"
            && entry.family === "mcp"
            && refusal !== null
            && refusal.status >= 500
            && inProcessServers.length > 0;
        args.setState(CHANNEL, "active");
        const formatted = verb === "list" && (refusal === null || partialMcpList)
            ? FunctionalityManager.#formatListBody(
                entry.family,
                partialMcpList ? { family: entry.family, definitions: [], problem: refusal?.problem } : result.body,
                inProcessServers,
            )
            : JSON.stringify(result.body, null, 2);
        args.write(CHANNEL, formatted, "application/json");
        // {§functionality-model-projection} Resource readiness is the body; this invocation has settled.
        args.setState(CHANNEL, !partialMcpList && result.status >= 400 ? "errored" : "closed");
        return partialMcpList ? { status: 200 } : (refusal ?? { status: result.status });
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
                        ...(item.origin === undefined ? {} : { origin: item.origin }),
                        state: item.state,
                        ...(detail !== null && typeof detail.description === "string" ? { description: detail.description } : {}),
                        ...(detail !== null ? { docs: typeof detail.docs === "string" ? detail.docs : `mcp:///${String(item.alias)}.md` } : {}),
                        ...(detail !== null && typeof detail.resources === "number" && detail.resources > 0 ? { resources: detail.resources } : {}),
                        ...(detail !== null && typeof detail.resourceTemplates === "number" && detail.resourceTemplates > 0 ? { resourceTemplates: detail.resourceTemplates } : {}),
                        ...(detail !== null && typeof detail.prompts === "number" && detail.prompts > 0 ? { prompts: detail.prompts } : {}),
                        ...(detail !== null && Array.isArray(detail.skills) && detail.skills.length > 0 ? { skills: detail.skills } : {}),
                        ...(item.provenance === undefined ? {} : { provenance: item.provenance }),
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
        const problemLine = body.problem === undefined ? "" : `\n  "problem": ${JSON.stringify(body.problem)},`;
        return `{\n  "family": ${JSON.stringify(body.family)},${problemLine}\n  "definitions": [\n${lines.join(",\n")}\n  ]\n}`;
    }
}
