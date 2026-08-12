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
} from "@plurnk/plurnk-execs";
import ServerConnection from "./client.ts";

const CHANNEL = "body";

export const runtimeDecl = (name: string): RuntimeDecl => ({
    name,
    glyph: "🔌",
    example: `## EXEC1 [${name}] (tool_name)\n{"argument":"value"}`,
    documentation: `# ${name}

This configured MCP server is available as an executable tool family and an
addressable resource family.

\`\`\`plurnk
## READ1 (${name}:///)\n\n## EXEC1 [${name}] (tool_name)\n{"argument":"value"}
\`\`\`

READ returns the live catalog. Tool arguments are one JSON object. Tool results
are written to the operation's \`body\` channel.
`,
});

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export default class McpExecutor extends BaseExecutor {
    readonly #connection: ServerConnection;

    constructor(
        metadata: { runtime: string; glyph: string },
        connection: ServerConnection,
    ) {
        super(metadata);
        this.#connection = connection;
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return {
            [CHANNEL]: {
                mimetype: "application/json",
            },
        };
    }

    override effect(target: string | null): Effect {
        if (target === null || target.length === 0) return "read";
        return this.#connection.readOnly(target) ? "read" : "host";
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
            const catalog = await this.#connection.catalog(signal);
            return {
                available: true,
                detail: [
                    `MCP ${catalog.protocolVersion}`,
                    `${catalog.tools.length} tools`,
                    `${catalog.resources.length} resources`,
                    `${catalog.prompts.length} prompts`,
                ].join("; "),
            };
        } catch (error) {
            return {
                available: false,
                detail: ErrorDetail.preview(message(error), detailLimit),
            };
        }
    }

    async run({
        runtime,
        command,
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
        const body = command.trim();
        if (target === null || target.length === 0) {
            return fail(
                "tool-required",
                400,
                `MCP executor '${runtime}' requires a tool target.`,
                {
                    recovery: `READ ${runtime}:/// for the live catalog, then target one listed tool.`,
                    retryable: false,
                },
            );
        }

        let args: Record<string, unknown> = {};
        if (body.length > 0) {
            try {
                const parsed: unknown = JSON.parse(body);
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
