import {
    BaseExecutor,
    ErrorDetail,
    ERROR_DETAIL_LIMIT,
    Results,
    RuntimeInvocation,
} from "@plurnk/plurnk-execs";
import { formatJsonDocument } from "@plurnk/plurnk-contracts";
import type {
    ChannelDecl,
    Effect,
    ExecArgs,
    ExecResult,
    Notice,
    RuntimeAvailability,
    RuntimeDecl,
    RuntimeSummaryDecl,
    RuntimeToolRegistry,
} from "@plurnk/plurnk-execs";
import ServerConnection, { type ServerCatalog } from "./client.ts";
import type { ContentBlock, Progress, Tool } from "@modelcontextprotocol/client";
import { resourcePath } from "./McpResources.ts";
import ResourceContent from "./ResourceContent.ts";
import type { ToolPolicy } from "./config.ts";
import { toolRegistry as presentTools } from "./ToolPresentation.ts";

const CHANNEL = "body";

const firstSentence = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    const normalized = text.replaceAll(/\s+/gu, " ").trim();
    if (normalized === "") return undefined;
    const boundary = /[.!?](?:\s|$)/u.exec(normalized);
    return boundary === null ? normalized : normalized.slice(0, boundary.index + 1);
};

// {§mcp-summary-derivation} — one server one-liner: the authored _SUMMARY
// companion, then the server's own description and display title (spec
// metadata — a title like "Chrome DevTools MCP server" IS the one-liner), then
// the first sentence of its instructions essay. Never the container template;
// when the chain is empty, name the actual tools.
const authoredServerSummary = (
    name: string,
    catalog: ServerCatalog | undefined,
    override: string | undefined,
): string | undefined => {
    if (override !== undefined && override.trim() !== "") return override.trim();
    const described = catalog?.server?.description;
    if (described !== undefined && described.trim() !== "") return described.replaceAll(/\s+/gu, " ").trim();
    const titled = catalog?.server?.title;
    if (titled !== undefined && titled.trim() !== "") return titled.replaceAll(/\s+/gu, " ").trim();
    const instructed = firstSentence(catalog?.instructions);
    if (instructed !== undefined) return instructed;
    return undefined;
};

export const serverSummary = (
    name: string,
    catalog: ServerCatalog | undefined,
    override: string | undefined,
): string => {
    const authored = authoredServerSummary(name, catalog, override);
    if (authored !== undefined) return authored;
    const tools = catalog?.tools.map((tool) => tool.name).join(", ");
    return tools === undefined || tools === ""
        ? `MCP server ${name}.`
        : `Tools: ${tools}.`;
};

// The generated runtime document resolves a factual tool-list fallback from
// its effective registry. An authored server description remains invariant.
export const runtimeServerSummary = (
    name: string,
    catalog: ServerCatalog | undefined,
    override: string | undefined,
): RuntimeSummaryDecl => {
    const authored = authoredServerSummary(name, catalog, override);
    if (authored !== undefined) return authored;
    return (catalog?.tools.length ?? 0) === 0 ? `MCP server ${name}.` : { from: "tools" };
};

// The channel carries the tool's RESULT, never the transport envelope: text parts as text with
// their own newlines (JSON when they parse as JSON), so a page rule and a scoped READ mean what
// they say and nothing reaches the model double-escaped. Non-text parts are ordinary resource
// links; the exact protocol result has its own non-published channel.
export type ToolResultShape = {
    readonly content?: readonly ContentBlock[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
};

export const toolResultBody = async (result: ToolResultShape, runtime: string, entry?: ExecArgs["entry"]): Promise<{ content: string; mimetype: string }> => {
    const parts = result.content ?? [];
    if (parts.length === 0 && result.structuredContent !== undefined) {
        return { content: JSON.stringify(result.structuredContent, null, 2), mimetype: "application/json" };
    }
    const rendered: string[] = [];
    for (const part of parts) {
        if (part.type === "text") {
            rendered.push(part.text);
            continue;
        }
        if (part.type === "resource_link") {
            rendered.push(`<${runtime}://${resourcePath(part.uri)}> — ${part.name}`);
            continue;
        }
        if (entry === undefined) throw new Error("MCP content requires the executor resource publisher.");
        const name = part.type === "resource" ? ResourceContent.name(part.resource) : undefined;
        const channel = part.type === "resource" ? ResourceContent.channel(part.resource)
            : { content: "", bytes: Buffer.from(part.data, "base64"), mimetype: part.mimeType };
        const uri = await entry(null, channel.bytes ?? channel.content, { mimetype: channel.mimetype, ...(name === undefined ? {} : { name }) });
        rendered.push(`<${uri}> — ${channel.mimetype}`);
    }
    const text = rendered.join("\n");
    const formatted = formatJsonDocument(text);
    return { content: formatted ?? text, mimetype: formatted === undefined ? (parts.some((part) => part.type !== "text") ? "text/markdown" : "text/plain") : "application/json" };
};

export const runtimeDecl = (name: string, summary: RuntimeSummaryDecl, expandTools: boolean): RuntimeDecl => ({
    name,
    glyph: "🔌",
    summary,
    // {§tools-resource-materialization} — MCP families live in the tools
    // namespace; the turn-0 survey lists the family document, and expandTools
    // (PLURNK_MCP_EXPANDED) adds the complete tool tree.
    resourcesPath: "/tools",
    ...(expandTools ? { expandTools: true } : {}),
    invocation: {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    },
});

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const progressNotice = (
    runtime: string,
    tool: string,
    progress: Progress,
): Notice => ({
    source: `exec:${runtime}`,
    kind: "mcp_progress",
    level: "info",
    message: progress.message ?? (
        progress.total === undefined
            ? `MCP tool '${tool}' progressed to ${progress.progress}.`
            : `MCP tool '${tool}' progressed to ${progress.progress}/${progress.total}.`
    ),
    tool,
    progress: progress.progress,
    ...(progress.total === undefined ? {} : { total: progress.total }),
});

export default class McpExecutor extends BaseExecutor {
    readonly #connection: ServerConnection;
    readonly #tools: readonly string[] | null;
    readonly #read: ReadonlySet<string>;
    #registry: RuntimeToolRegistry | null = null;
    readonly #toolSummaries: ReadonlyMap<string, string>;
    readonly #retainWorkspace: () => () => void;
    #catalog: ServerCatalog | null = null;

    constructor(
        metadata: { runtime: string; glyph: string },
        connection: ServerConnection,
        retainWorkspace: () => () => void,
        policy: Partial<ToolPolicy> = {},
        toolSummaries?: ReadonlyMap<string, string>,
    ) {
        super(metadata);
        this.#connection = connection;
        this.#tools = policy.tools ?? null;
        this.#read = new Set(policy.read ?? []);
        this.#toolSummaries = toolSummaries ?? new Map();
        this.#retainWorkspace = retainWorkspace;
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return {
            [CHANNEL]: {
                mimetype: "application/json",
            },
            json: { mimetype: "application/json" },
        };
    }

    override effect(target: string | null): Effect {
        if (target === null || !this.#enabledTargets().has(target)) {
            throw new Error(`MCP effect classification received unregistered target '${target ?? ""}' on '${this.runtime}'.`);
        }
        return this.#read.has(target) ? "read" : "host";
    }

    override get publishedChannel(): string {
        return CHANNEL;
    }

    #selectTools(tools: readonly Tool[]): readonly Tool[] {
        const available = new Set(tools.map((tool) => tool.name));
        if (available.size !== tools.length) {
            throw new Error(`MCP server '${this.runtime}' returned duplicate tool names.`);
        }
        const configured = this.#tools ?? [];
        for (const name of configured) {
            if (!available.has(name)) {
                throw new Error(`Configured MCP tool '${name}' is absent from server '${this.runtime}'.`);
            }
        }
        const selected = this.#tools === null
            ? tools
            : tools.filter((tool) => this.#tools?.includes(tool.name));
        const enabled = new Set(selected.map((tool) => tool.name));
        for (const name of this.#read) {
            if (!enabled.has(name)) {
                throw new Error(`Read-classified MCP tool '${name}' is not enabled on server '${this.runtime}'.`);
            }
        }
        return selected;
    }

    #enabledTargets(): ReadonlySet<string> {
        if (this.#registry === null) {
            throw new Error(`MCP tool registry for '${this.runtime}' was read before availability was established.`);
        }
        return new Set(this.#registry.tools.map((tool) => tool.target));
    }

    toolRegistry(): RuntimeToolRegistry {
        if (this.#registry === null) {
            throw new Error(`MCP tool registry for '${this.runtime}' was read before availability was established.`);
        }
        return this.#registry;
    }

    get catalog(): ServerCatalog {
        if (this.#catalog === null) {
            throw new Error(`MCP catalog for '${this.runtime}' was read before availability was established.`);
        }
        return this.#catalog;
    }

    override async probe(signal?: AbortSignal): Promise<RuntimeAvailability> {
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            return {
                available: false,
                detail: `${ERROR_DETAIL_LIMIT} must be set to a non-negative integer.`,
            };
        }
        try {
            return await this.requireAvailable(signal);
        } catch (error) {
            return {
                available: false,
                detail: ErrorDetail.preview(message(error), detailLimit),
            };
        }
    }

    async requireAvailable(signal?: AbortSignal): Promise<RuntimeAvailability> {
        if (ErrorDetail.configuredLimit() === null) {
            throw new Error(`${ERROR_DETAIL_LIMIT} must be set to a non-negative integer.`);
        }
        const catalog = await this.#connection.catalog(signal);
        const selected = this.#selectTools(catalog.tools);
        this.#registry = RuntimeInvocation.assertToolRegistry(
            presentTools(this.runtime, selected, this.#toolSummaries),
            "@plurnk/plurnk-mcp",
            this.runtime,
        );
        this.#catalog = catalog;
        return {
            available: true,
            detail: [
                `MCP ${catalog.protocolVersion}`,
                `${catalog.tools.length} tools`,
                `${catalog.resources.length} resources`,
                `${catalog.prompts.length} prompts`,
            ].join("; "),
        };
    }

    async run({
        runtime,
        body,
        target,
        signal,
        write,
        setState,
        emit,
        interact,
        entry,
    }: ExecArgs): Promise<ExecResult> {
        const fail = (
            code: string,
            status: number,
            detail: string,
            extensions: Readonly<Record<string, unknown>>,
        ): ExecResult => {
            setState(CHANNEL, "errored");
            return Results.failure(
                "executor:mcp",
                code,
                status,
                detail,
                {},
                {
                    runtime,
                    stage: "mcp",
                    ...extensions,
                },
            );
        };
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState(CHANNEL, "errored");
            return ErrorDetail.invalidConfiguration("executor:mcp");
        }
        const input = body.trim();
        if (target === null || target.length === 0) {
            return fail(
                "tool-required",
                400,
                "An MCP tool target is required.",
                {
                    recovery: `Select a target documented under worker://~/_plurnk/tools/${runtime}/.`,
                    retryable: false,
                },
            );
        }
        if (!this.#enabledTargets().has(target)) {
            return fail(
                "tool-not-enabled",
                404,
                "The MCP tool is not enabled.",
                {
                    tool: target,
                    recovery: `Select a target documented under worker://~/_plurnk/tools/${runtime}/.`,
                    retryable: false,
                },
            );
        }

        let args: Record<string, unknown> = {};
        if (input.length > 0) {
            try {
                const parsed: unknown = JSON.parse(input);
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                    throw new TypeError("tool arguments must be an object");
                }
                args = parsed as Record<string, unknown>;
            } catch (cause) {
                // The diagnostic alone taught models to resend the same body
                // (https://repo.possumtech.com/plurnk/plurnk-bench/issues/6, run52): name the form that works.
                return fail(
                    "invalid-tool-arguments",
                    400,
                    "MCP tool arguments must be one JSON object.",
                    {
                        tool: target,
                        retryable: false,
                        diagnostic: ErrorDetail.preview(message(cause), detailLimit),
                        recovery: "One JSON object per MCP tool call; a second call is a second EXEC.",
                    },
                );
            }
        }

        const releaseWorkspace = this.#retainWorkspace();
        try {
            const tool = this.#catalog?.tools.find((candidate) => candidate.name === target);
            if (tool === undefined) {
                throw new Error(`MCP tool '${target}' is absent from the prepared catalog.`);
            }
            const result = await this.#connection.callTool(
                target,
                args,
                signal,
                (progress) => emit(progressNotice(runtime, target, progress)),
                interact,
                tool,
            );
            write("json", JSON.stringify(result, null, 2), "application/json");
            setState("json", "closed");
            const body = await toolResultBody(result, runtime, entry);
            write(CHANNEL, body.content, body.mimetype);
            if (result.isError === true) {
                return fail(
                    "tool-reported-error",
                    502,
                    "The MCP tool reported an error.",
                    {
                        tool: target,
                        retryable: false,
                    },
                );
            }
            setState(CHANNEL, "closed");
            return { status: 200 };
        } catch (error) {
            return fail(
                signal.aborted ? "cancelled" : "tool-call-failed",
                signal.aborted ? 499 : 502,
                signal.aborted
                    ? "The MCP tool call was cancelled."
                    : "The MCP tool call failed.",
                {
                    tool: target,
                    ...(signal.aborted ? {} : { diagnostic: ErrorDetail.preview(message(error), detailLimit) }),
                    retryable: false,
                },
            );
        } finally {
            releaseWorkspace();
        }
    }
}
