import {
    McpServer,
    fromJsonSchema,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { writeFileSync } from "node:fs";

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
    return server;
};

serveStdio(factory, {
    legacy: "reject",
});
