import {
    BaseExecutor,
    ErrorDetail,
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
import ContentProjection from "./ContentProjection.ts";
import type { ToolPolicy } from "./config.ts";
import { toolRegistry as presentTools } from "./ToolPresentation.ts";
import { summaryLine } from "./Summary.ts";

const CHANNEL = "body";

// {§mcp-summary-derivation}: the server's own purpose precedes a display label.
const authoredServerSummary = (catalog: ServerCatalog | undefined): string | undefined =>
    summaryLine(catalog?.server?.description)
        ?? summaryLine(catalog?.instructions)
        ?? summaryLine(catalog?.server?.title);

export const serverSummary = (
    name: string,
    catalog: ServerCatalog | undefined,
): string => {
    const authored = authoredServerSummary(catalog);
    if (authored !== undefined) return authored;
    const tools = catalog?.tools.map((tool) => tool.name).join(", ");
    return tools === undefined || tools === ""
        ? `MCP server ${name}.`
        : `Tools: ${tools}.`;
};

// {§scheme-catalog-aside}: purpose annotates the effective menu, never replaces it.
export const runtimeServerSummary = (
    name: string,
    catalog: ServerCatalog | undefined,
): RuntimeSummaryDecl => {
    const authored = authoredServerSummary(catalog);
    return (catalog?.tools.length ?? 0) === 0
        ? authored ?? `MCP server ${name}.`
        : { from: "tools", ...(authored === undefined ? {} : { description: authored }) };
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
        const projected = await ContentProjection.project(part, {
            address: (uri) => `${runtime}://${resourcePath(uri)}`,
            ...(entry === undefined ? {} : {
                publish: (channel, name) => entry(null, channel.bytes ?? channel.content, {
                    mimetype: channel.mimetype, ...(name === undefined ? {} : { name }),
                }),
            }),
        });
        rendered.push(projected.type === "text" ? projected.text
            : `<${projected.uri}> — ${part.type === "resource_link" ? projected.name : projected.mimeType}`);
    }
    const text = rendered.join("\n");
    const formatted = formatJsonDocument(text);
    return { content: formatted ?? text, mimetype: formatted === undefined ? (parts.some((part) => part.type !== "text") ? "text/markdown" : "text/plain") : "application/json" };
};

// {§executor-page-receipt} — a JSON array exactly as long as the page the call asked for, or
// the tool's default page, is a full page: the receipt says so, and nothing more.
const PAGE_ARGUMENTS = Object.freeze(["per_page", "page_size", "pageSize", "limit"]);

const pageReceipt = (
    args: Readonly<Record<string, unknown>>,
    tool: Tool,
    body: { readonly content: string; readonly mimetype: string },
): { size: number; returned: number } | null => {
    if (body.mimetype !== "application/json") return null;
    const parsed: unknown = JSON.parse(body.content);
    if (!Array.isArray(parsed)) return null;
    const properties = (tool.inputSchema.properties ?? {}) as Readonly<Record<string, { default?: unknown } | undefined>>;
    for (const name of PAGE_ARGUMENTS) {
        const sent = args[name];
        const size = typeof sent === "number" ? sent : properties[name]?.default;
        if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) continue;
        return parsed.length === size ? { size, returned: parsed.length } : null;
    }
    return null;
};

export const runtimeDecl = (name: string, summary: RuntimeSummaryDecl, expandTools: boolean, instructions?: string): RuntimeDecl => ({
    name,
    glyph: "🔌",
    summary,
    ...(instructions === undefined || instructions.trim() === "" ? {} : { details: instructions }),
    // {§tools-resource-materialization} — MCP families live in the tools
    // namespace; the turn-0 survey lists the family document, and expandTools
    // (PLURNK_MCP_EXPANDED) adds the complete tool tree.
    resourcesPath: "/tools",
    ...(expandTools ? { expandTools: true } : {}),
    invocation: {
        body: { role: "JSON arguments", required: false, mimetype: "application/json" },
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
    // {§mcp-trailing-aside} — an HTML comment after the one JSON object is the writer's aside, not
    // arguments: read the object, never teach the tolerance (#758).
    static #parseArguments(input: string): unknown {
        try { return JSON.parse(input); }
        catch (cause) {
            const stripped = input.replace(/(?:\s*<!--[\s\S]*?-->)+\s*$/u, "");
            if (stripped === input) throw cause;
            return JSON.parse(stripped);
        }
    }

    readonly #connection: ServerConnection;
    readonly #tools: readonly string[] | null;
    // {§mcp-model-projection} — the enabled tools whose annotations.readOnlyHint is true.
    #read: ReadonlySet<string> = new Set();
    #registry: RuntimeToolRegistry | null = null;
    readonly #retainWorkspace: () => () => void;
    #catalog: ServerCatalog | null = null;

    constructor(
        metadata: { runtime: string; glyph: string },
        connection: ServerConnection,
        retainWorkspace: () => () => void,
        policy: Partial<ToolPolicy> = {},
    ) {
        super(metadata);
        this.#connection = connection;
        this.#tools = policy.tools ?? null;
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
        return this.#tools === null
            ? tools
            : tools.filter((tool) => this.#tools?.includes(tool.name));
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
        try {
            return await this.requireAvailable(signal);
        } catch (error) {
            return {
                available: false,
                detail: ErrorDetail.preview(message(error)),
            };
        }
    }

    async requireAvailable(signal?: AbortSignal): Promise<RuntimeAvailability> {
        const catalog = await this.#connection.catalog(signal);
        const selected = this.#selectTools(catalog.tools);
        this.#read = new Set(selected.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name));
        this.#registry = RuntimeInvocation.assertToolRegistry(
            presentTools(this.runtime, selected),
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
                ...(catalog.unsupportedLists.length === 0
                    ? []
                    : [`not implemented: ${catalog.unsupportedLists.join(", ")}`]),
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
        const input = body.trim();
        if (target === null || target.length === 0) {
            return fail(
                "tool-required",
                400,
                "An MCP tool target is required.",
                {
                    recovery: `Select a target documented under worker:///_plurnk/tools/${runtime}/.`,
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
                    recovery: `Select a target documented under worker:///_plurnk/tools/${runtime}/.`,
                    retryable: false,
                },
            );
        }

        let args: Record<string, unknown> = {};
        if (input.length > 0) {
            try {
                const parsed: unknown = McpExecutor.#parseArguments(input);
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                    throw new TypeError("tool arguments must be an object");
                }
                args = parsed as Record<string, unknown>;
            } catch (cause) {
                // Name the form that works (https://repo.possumtech.com/plurnk/plurnk-bench/issues/6).
                return fail(
                    "invalid-tool-arguments",
                    400,
                    "MCP tool arguments must be one JSON object.",
                    {
                        tool: target,
                        retryable: false,
                        diagnostic: ErrorDetail.preview(message(cause)),
                        recovery: "One JSON object per MCP tool call; a second call is a second fence.",
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
                const diagnostic = (result.content ?? [])
                    .flatMap((part) => part.type === "text" && part.text.trim().length > 0 ? [part.text] : [])
                    .join("\n");
                return fail(
                    "tool-reported-error",
                    502,
                    "The MCP tool reported an error.",
                    {
                        tool: target,
                        retryable: false,
                        ...(diagnostic.length === 0 ? {} : { diagnostic: ErrorDetail.preview(diagnostic) }),
                    },
                );
            }
            setState(CHANNEL, "closed");
            const page = pageReceipt(args, tool, body);
            return { status: 200, ...(page === null ? {} : { page }) };
        } catch (error) {
            return fail(
                signal.aborted ? "cancelled" : "tool-call-failed",
                signal.aborted ? 499 : 502,
                signal.aborted
                    ? "The MCP tool call was cancelled."
                    : "The MCP tool call failed.",
                {
                    tool: target,
                    ...(signal.aborted ? {} : { diagnostic: ErrorDetail.preview(message(error)) }),
                    retryable: false,
                },
            );
        } finally {
            releaseWorkspace();
        }
    }
}
