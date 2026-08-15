import {
    BaseExecutor,
    ErrorDetail,
    ERROR_DETAIL_LIMIT,
    renderJsonResult,
    Results,
    RuntimeInvocation,
} from "@plurnk/plurnk-execs";
import type {
    ChannelDecl,
    Effect,
    ExecArgs,
    ExecResult,
    RuntimeAvailability,
    RuntimeDecl,
    RuntimeToolRegistry,
} from "@plurnk/plurnk-execs";
import ServerConnection from "./client.ts";
import type { Tool } from "@modelcontextprotocol/client";
import type { ToolPolicy } from "./config.ts";
import { toolRegistry as presentTools } from "./ToolPresentation.ts";

const CHANNEL = "body";

export const runtimeDecl = (name: string): RuntimeDecl => ({
    name,
    glyph: "🔌",
    invocation: {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    },
    documentation: "",
});

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export default class McpExecutor extends BaseExecutor {
    readonly #connection: ServerConnection;
    readonly #tools: readonly string[] | null;
    readonly #read: ReadonlySet<string>;
    #registry: RuntimeToolRegistry | null = null;

    constructor(
        metadata: { runtime: string; glyph: string },
        connection: ServerConnection,
        policy: Partial<ToolPolicy> = {},
    ) {
        super(metadata);
        this.#connection = connection;
        this.#tools = policy.tools ?? null;
        this.#read = new Set(policy.read ?? []);
    }

    override get manifest() {
        return {
            ...super.manifest,
            example: `## FIND0 (${this.runtime}:///resources/**)`,
        };
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return {
            [CHANNEL]: {
                mimetype: "application/json",
            },
        };
    }

    override effect(target: string | null): Effect {
        if (target === null || !this.#enabledTargets().has(target)) {
            throw new Error(`MCP effect classification received unregistered target '${target ?? ""}' on '${this.runtime}'.`);
        }
        return this.#read.has(target) ? "read" : "host";
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
            presentTools(this.runtime, selected),
            "@plurnk/plurnk-mcp",
            this.runtime,
        );
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
                `MCP executor '${runtime}' requires a tool target.`,
                {
                    recovery: "Select a target listed for this executor in Registered Tools.",
                    retryable: false,
                },
            );
        }
        if (!this.#enabledTargets().has(target)) {
            return fail(
                "tool-not-enabled",
                404,
                `MCP tool '${target}' is not enabled on '${runtime}'.`,
                {
                    tool: target,
                    recovery: "Select a target listed for this executor in Registered Tools.",
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
                return fail(
                    "invalid-tool-arguments",
                    400,
                    `Arguments for MCP tool '${target}' must be one JSON object.`,
                    {
                        tool: target,
                        retryable: false,
                        diagnostic: ErrorDetail.preview(message(cause), detailLimit),
                    },
                );
            }
        }

        try {
            const result = await this.#connection.callTool(target, args, signal);
            write(CHANNEL, renderJsonResult(result), "application/json");
            if (result.isError === true) {
                return fail(
                    "tool-reported-error",
                    502,
                    `MCP tool '${target}' on '${runtime}' reported an error.`,
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
                    ? `MCP tool '${target}' on '${runtime}' was cancelled.`
                    : `MCP tool '${target}' on '${runtime}' failed: ${ErrorDetail.preview(message(error), detailLimit)}.`,
                {
                    tool: target,
                    retryable: !signal.aborted,
                },
            );
        }
    }
}
