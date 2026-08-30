import {
    McpServer,
    completable,
    fromJsonSchema,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";

const closeMarker = process.env.PLURNK_MCP_TEST_CLOSE_MARKER;
if (closeMarker !== undefined) {
    // #429 — the marker names the process that exited, so a test can tell a duplicate from the original.
    process.on("exit", () => writeFileSync(closeMarker, `closed ${process.pid}\n`));
}
const startMarker = process.env.PLURNK_MCP_TEST_START_MARKER;
if (startMarker !== undefined) appendFileSync(startMarker, `${process.pid}\n`);
const startDelayMs = Number(process.env.PLURNK_MCP_TEST_START_DELAY_MS ?? "0");
if (startDelayMs > 0) await delay(startDelayMs);

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
            "rich",
            {
                description: "Return one of every passive content variant.",
                inputSchema: z.object({}),
            },
            async () => ({
                content: [
                    { type: "text", text: "prose" },
                    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
                    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
                    {
                        type: "resource_link",
                        uri: "fixture://document",
                        name: "Linked document",
                    },
                    {
                        type: "resource",
                        resource: {
                            uri: "fixture://embedded",
                            mimeType: "text/plain",
                            text: "embedded text",
                        },
                    },
                    {
                        type: "resource",
                        resource: {
                            uri: "fixture://binary",
                            mimeType: "application/octet-stream",
                            blob: "YmxvYg==",
                        },
                    },
                ],
            }),
        );
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
