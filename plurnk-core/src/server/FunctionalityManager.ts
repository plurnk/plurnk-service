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
import { Problems, isRecord, type CapabilityPolicy, type JsonSchema } from "@plurnk/plurnk-contracts";
import type CapabilityResolver from "../core/CapabilityResolver.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import type ExecutorRegistry from "../core/ExecutorRegistry.ts";
import type { RuntimeRegistryRegistration } from "../core/ExecutorRegistry.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import ToolResources, { type ToolResource } from "../core/ToolResources.ts";
import { coreOperationTools } from "../schemes/CoreOperationTools.ts";
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
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
        readonly entries: readonly FunctionalityFamilyEntry[] | ((workspaceId?: number) => readonly FunctionalityFamilyEntry[]);
    }
    | {
        readonly coordinator: Functionality;
        readonly workspaceId?: number;
        readonly sessionId?: number;
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
        readonly entry: FunctionalityFamilyEntry | ((workspaceId?: number) => FunctionalityFamilyEntry);
    }
    | ({
        readonly coordinator: Functionality;
        readonly workspaceId?: number;
        readonly sessionId?: number;
        readonly includeQuestion?: boolean | ((workspaceId?: number) => boolean);
    } & FunctionalityFamilyEntry);

const stripLeadingHeading = (markdown: string): string =>
    markdown.trim().replace(/^# [^\n]*\n+/u, "").trim();

export const plurnkRuntimeDecl: RuntimeDecl & { readonly glyph: string } = {
    name: "plurnk",
    glyph: "🔌",
    summary: {
        from: "tools",
        description: "Core operations, code execution, workspace configuration (env, mcp, members, personas, schedule, skills), and user questions.",
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
    readonly #question: QuestionTool;

    constructor(args: FunctionalityManagerOptions) {
        super({ runtime: plurnkRuntimeDecl.name, glyph: plurnkRuntimeDecl.glyph });
        this.#coordinator = args.coordinator;
        this.#workspaceId = args.workspaceId ?? 1;
        this.#sessionId = args.sessionId;
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
        options: { readonly includeQuestion?: boolean } = {},
    ): RuntimeRegistryRegistration[] {
        return [{
            tag: plurnkRuntimeDecl.name,
            entry: {
                executor: new FunctionalityManager({
                    coordinator,
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

    static catalogTools(
        capabilities: CapabilityResolver,
        workspaceId: number,
        policies: readonly CapabilityPolicy[],
        executors: ExecutorRegistry | undefined,
    ): readonly RuntimeRegisteredTool[] {
        const coreTools = coreOperationTools(capabilities, workspaceId, policies, executors);
        const plurnkRegistry = executors?.availableRuntimes(workspaceId).includes(plurnkRuntimeDecl.name) === true
            ? executors.toolRegistry(plurnkRuntimeDecl.name, workspaceId)
            : null;
        const runtimeTools = plurnkRegistry === null
            ? []
            : plurnkRegistry.tools.filter((tool) =>
                capabilities.allowsRuntimeAcross(plurnkRuntimeDecl.name, tool.target, workspaceId, policies));
        return [...coreTools, ...runtimeTools];
    }

    static renderPlurnkResources(
        capabilities: CapabilityResolver,
        workspaceId: number,
        policies: readonly CapabilityPolicy[],
        executors: ExecutorRegistry | undefined,
    ): readonly ToolResource[] {
        const tools = FunctionalityManager.catalogTools(capabilities, workspaceId, policies, executors);
        if (tools.length === 0) return [];
        const entry = executors?.availableRuntimes(workspaceId).includes(plurnkRuntimeDecl.name) === true
            ? executors.entry(plurnkRuntimeDecl.name, workspaceId)
            : undefined;
        const resourcesPath = entry?.resourcesPath ?? plurnkRuntimeDecl.resourcesPath;
        const rawSummary = entry?.summary ?? plurnkRuntimeDecl.summary;
        const hasQuestion = tools.some(({ target }) => target === "question");
        const summary = typeof rawSummary === "object" && !hasQuestion
            ? {
                ...rawSummary,
                description: "Core operations, code execution, and workspace configuration (env, mcp, members, personas, schedule, skills).",
            }
            : rawSummary;
        return ToolResources.render({
            runtime: plurnkRuntimeDecl.name,
            summary,
            invocation: entry?.invocation ?? {
                body: { role: "JSON arguments", required: false, mimetype: "application/json" },
                target: { role: "Plurnk tool", required: true, kind: "literal" },
                example: { target: tools[0].target },
            },
            details: entry?.details ?? plurnkRuntimeDecl.details ?? "",
            registry: { tools },
            ...(resourcesPath === undefined ? {} : { resourcesPath }),
        });
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
        const rawProperties: Record<string, JsonSchema> = {};
        const defs: Record<string, JsonSchema> = {};
        for (const verb of ["add", "replace", "enable", "disable", "remove", "list"] as const) {
            if (verbs.includes(verb)) {
                FunctionalityManager.#collectSchemaProperties(entry.inputSchemas[verb], rawProperties, defs);
            }
        }
        const properties: Record<string, JsonSchema> = {};
        if (entry.family === "members") {
            properties.path = {
                oneOf: [
                    { type: "string", minLength: 1 },
                    { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                ],
                description: "A shell-path glob or array of globs relative to the project root (leading ! excludes).",
            };
            for (const [key, prop] of Object.entries(rawProperties)) {
                if (key === "files" || key === "file" || key === "scope") continue;
                properties[key] = prop;
            }
        } else {
            if (rawProperties.alias !== undefined) {
                properties.name = rawProperties.alias;
            }
            for (const [key, prop] of Object.entries(rawProperties)) {
                if (key === "alias" || key === "scope") continue;
                properties[key] = prop;
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
            const discoverProps: Record<string, JsonSchema> = {};
            for (const [key, prop] of Object.entries(rawDiscoverProps)) {
                if (key === "scope") continue;
                if (key === "alias") {
                    discoverProps.name = prop;
                } else {
                    discoverProps[key] = prop;
                }
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
        const docBody = entry.documentBody === undefined ? "" : stripLeadingHeading(entry.documentBody);
        if (entry.configurationFailure !== null && entry.configurationFailure !== undefined) {
            sections.push(`> [!WARNING]\n> ${entry.configurationFailure.error.message}`);
        }
        if (verbs.includes("discover") && entry.discovery?.details !== undefined && docBody.length === 0) {
            sections.push(entry.discovery.details);
        }
        if (verbs.includes("add") && entry.example !== undefined) {
            const exampleObj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(entry.example)) {
                if (entry.family === "members" && (k === "files" || k === "file")) {
                    exampleObj.path = v;
                } else if (k === "alias") {
                    exampleObj.name = v;
                } else {
                    exampleObj[k] = v;
                }
            }
            sections.push(`await plurnk.${entry.family}(${JSON.stringify(exampleObj)});`);
        }
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

    static #normalizeFamilyInput(
        entry: FunctionalityFamilyEntry,
        rawParsed: Record<string, unknown>,
    ): Record<string, unknown> {
        const keyMap: Record<string, string> = {};
        if (entry.family === "members") {
            const isSingleTargetOp = Object.hasOwn(rawParsed, "remove") || Object.hasOwn(rawParsed, "enabled");
            const targetKey = isSingleTargetOp ? "file" : "files";
            for (const k of ["path", "paths", "files", "file", "glob", "name", "alias"]) keyMap[k] = targetKey;
        } else {
            for (const k of ["name", "key", "server", "id"]) keyMap[k] = "alias";
            if (entry.family === "env") {
                keyMap.environment = "env";
            } else if (entry.family === "personas") {
                keyMap.text = "body";
                keyMap.instructions = "body";
            } else if (entry.family === "schedule") {
                keyMap.text = "prompt";
                keyMap.message = "prompt";
            } else if (entry.family === "skills") {
                keyMap.path = "source";
                keyMap.file = "source";
                keyMap.dir = "source";
            }
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rawParsed)) {
            if (v === undefined) continue;
            const mapped = keyMap[k];
            if (mapped !== undefined && !Object.hasOwn(rawParsed, mapped) && !Object.hasOwn(out, mapped)) {
                if (entry.family === "members" && mapped === "files" && typeof v === "string") {
                    out.files = [v];
                } else if (entry.family === "members" && mapped === "file" && Array.isArray(v) && v.length === 1 && typeof v[0] === "string") {
                    out.file = v[0];
                } else {
                    out[mapped] = v;
                }
            } else if (entry.family === "members" && k === "files" && typeof v === "string") {
                out.files = [v];
            } else if (entry.family === "members" && k === "file" && Array.isArray(v) && v.length === 1 && typeof v[0] === "string") {
                out.file = v[0];
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    static #resolveInvocation(
        entry: FunctionalityFamilyEntry,
        verbs: readonly FunctionalityVerb[],
        rawParsed: Record<string, unknown> | null,
    ): { verb: FunctionalityVerb; params: Record<string, unknown> } {
        if (rawParsed === null) {
            return { verb: "list", params: {} };
        }
        const normalized = FunctionalityManager.#normalizeFamilyInput(entry, rawParsed);
        const parsed = !FunctionalityManager.#hasScope(entry) && normalized.scope === "workspace"
            ? (() => {
                const { scope: _scope, ...rest } = normalized;
                return rest;
            })()
            : normalized;
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
        args.setState(CHANNEL, "active");
        const formatted = verb === "list" && refusal === null
            ? FunctionalityManager.#formatListBody(result.body)
            : JSON.stringify(result.body, null, 2);
        args.write(CHANNEL, formatted, "application/json");
        // {§functionality-model-projection} Resource readiness is the body; this invocation has settled.
        args.setState(CHANNEL, result.status >= 400 ? "errored" : "closed");
        return refusal ?? { status: result.status };
    }

    static #formatListBody(body: unknown): string {
        if (!isRecord(body) || !Array.isArray(body.definitions)) {
            return JSON.stringify(body, null, 2);
        }
        if (body.definitions.length === 0) {
            return JSON.stringify(body);
        }
        const lines = body.definitions.map((def) => `  ${JSON.stringify(def)}`);
        return `{\n  "family": ${JSON.stringify(body.family)},\n  "definitions": [\n${lines.join(",\n")}\n  ]\n}`;
    }
}
