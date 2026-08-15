import {
    BaseExecutor,
    ErrorDetail,
    ERROR_DETAIL_LIMIT,
    renderJsonResult,
    Results,
} from "@plurnk/plurnk-execs";
import type {
    ChannelDecl,
    Effect,
    ExecArgs,
    ExecResult,
    RuntimeAvailability,
    RuntimeDecl,
    RuntimeInvocationVariant,
} from "@plurnk/plurnk-execs";
import ServerConnection from "./client.ts";
import type { ToolPolicy } from "./config.ts";
import ToolAddress from "./ToolAddress.ts";

const CHANNEL = "body";

export const runtimeDecl = (name: string): RuntimeDecl => ({
    name,
    glyph: "🔌",
    invocation: {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name", body: '{"argument":"value"}' },
    },
    documentation: `# ${name}

This configured MCP server is available as an executable tool family and an
addressable resource family.

\`\`\`plurnk
## FIND0 (${name}://*/)\n\n## READ0 (${name}://tool_name/)\n\n## EXEC0 [${name}] (tool_name)\n{"argument":"value"}
\`\`\`

FIND surveys tool contracts, READ pulls one exact contract, and the empty-authority
root retains the complete live server catalog. Tool arguments are one JSON object.
Tool results are written to the operation's \`body\` channel.
`,
});

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export default class McpExecutor extends BaseExecutor {
    readonly #connection: ServerConnection;
    readonly #featured: boolean | readonly string[];
    readonly #read: ReadonlySet<string>;

    constructor(
        metadata: { runtime: string; glyph: string },
        connection: ServerConnection,
        policy: Partial<ToolPolicy> = {},
    ) {
        super(metadata);
        this.#connection = connection;
        this.#featured = policy.featured ?? false;
        this.#read = new Set(policy.read ?? []);
    }

    override get manifest() {
        const example = `## FIND0 (${this.runtime}://*/)`;
        return {
            ...super.manifest,
            example,
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
        return target !== null && this.#read.has(target) ? "read" : "host";
    }

    #assertConfiguredTools(tools: readonly { readonly name: string }[]): void {
        const available = new Set(tools.map((tool) => tool.name));
        const configured = [
            ...(typeof this.#featured === "boolean" ? [] : this.#featured),
            ...this.#read,
        ];
        for (const name of configured) {
            if (!available.has(name)) {
                throw new Error(`Configured MCP tool '${name}' is absent from server '${this.runtime}'.`);
            }
        }
    }

    invocationVariants(): readonly RuntimeInvocationVariant[] {
        const tools = this.#connection.currentTools();
        this.#assertConfiguredTools(tools);
        const featured = this.#featured;
        const selected = typeof featured === "boolean"
            ? featured ? tools : []
            : tools.filter((tool) => featured.includes(tool.name));
        return selected.map((tool) => {
            const address = ToolAddress.render(this.runtime, tool.name);
            return {
                body: { role: "JSON arguments", required: false },
                target: {
                    role: `MCP tool contract ${address}`,
                    required: true,
                    kind: "literal",
                },
                example: { target: tool.name },
            };
        });
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
        this.#assertConfiguredTools(catalog.tools);
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
                    recovery: `FIND ${runtime}://*/ for tool contracts, then target one listed tool.`,
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
