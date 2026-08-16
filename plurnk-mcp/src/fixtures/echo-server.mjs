import {
    McpServer,
    completable,
    fromJsonSchema,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { writeFileSync } from "node:fs";
import { z } from "zod/v4";

const closeMarker = process.env.PLURNK_MCP_TEST_CLOSE_MARKER;
if (closeMarker !== undefined) {
    process.on("exit", () => writeFileSync(closeMarker, "closed\n"));
}

const factory = () => {
    const server = new McpServer({
        name: "current-echo",
        version: "1.0.0",
    });
    server.registerTool(
        "echo",
        {
            description: "Echo one message.",
            inputSchema: fromJsonSchema({
                type: "object",
                properties: {
                    message: {
                        type: "string",
                    },
                },
                required: ["message"],
                additionalProperties: false,
            }),
            annotations: {
                readOnlyHint: true,
            },
        },
        async ({ message }) => ({
            content: [{
                type: "text",
                text: String(message),
            }],
        }),
    );
    server.registerTool(
        "fail",
        {
            description: "Return a deterministic tool error.",
            inputSchema: fromJsonSchema({
                type: "object",
                additionalProperties: false,
            }),
        },
        async () => ({
            content: [{
                type: "text",
                text: "fixture failure",
            }],
            isError: true,
        }),
    );
    if (process.env.PLURNK_MCP_TEST_EXTENDED === "1") {
        server.registerTool(
            "progress",
            {
                description: "Report deterministic progress.",
                inputSchema: z.object({}),
            },
            async (_args, ctx) => {
                const progressToken = ctx.mcpReq._meta?.progressToken;
                if (progressToken === undefined) throw new Error("Progress token was not requested.");
                await ctx.mcpReq.notify({
                    method: "notifications/progress",
                    params: {
                        progressToken,
                        progress: 1,
                        total: 2,
                        message: "fixture halfway",
                    },
                });
                return { content: [{ type: "text", text: "done" }] };
            },
        );
        server.registerTool(
            "wait",
            {
                description: "Wait until the request is cancelled.",
                inputSchema: z.object({}),
            },
            async (_args, ctx) => {
                await new Promise((resolve, reject) => {
                    if (ctx.mcpReq.signal.aborted) {
                        reject(ctx.mcpReq.signal.reason);
                        return;
                    }
                    ctx.mcpReq.signal.addEventListener("abort", () => {
                        const marker = process.env.PLURNK_MCP_TEST_CANCEL_MARKER;
                        if (marker !== undefined) writeFileSync(marker, "cancelled\n");
                        reject(ctx.mcpReq.signal.reason);
                    }, { once: true });
                });
                return { content: [{ type: "text", text: "unexpected" }] };
            },
        );
    }
    server.registerResource(
        "fixture",
        "fixture://document",
        {
            mimeType: "text/plain",
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: "text/plain",
                text: "alpha\nbeta\ngamma\n",
            }],
        }),
    );
    server.registerPrompt(
        "summarize",
        {
            description: "Build a summary request for one topic.",
            argsSchema: z.object({
                topic: completable(z.string(), (value) =>
                    ["MCP", "Plurnk", "protocol"].filter((candidate) =>
                        candidate.toLowerCase().startsWith(value.toLowerCase()))),
            }),
        },
        async ({ topic }) => ({
            messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: `Summarize ${String(topic)}.`,
                },
            }],
        }),
    );
    return server;
};

serveStdio(factory, {
    legacy: "reject",
});
