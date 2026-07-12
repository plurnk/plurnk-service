// Minimal real MCP server over stdio — a deterministic test fixture (no Zod,
// low-level Server + hand-crafted handlers). Two tools: `echo` returns its
// arguments; `boom` returns an isError result; any other name throws. The
// Mcp.test.ts suite spawns this via the real Mcp executor to exercise the
// bridge end-to-end over a genuine stdio transport.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        { name: "echo", description: "Echo the arguments back", inputSchema: { type: "object", properties: { msg: { type: "string" } } }, annotations: { readOnlyHint: true } },
        { name: "boom", description: "Always returns an error", inputSchema: { type: "object", properties: {} } },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "echo") return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
    if (name === "boom") return { content: [{ type: "text", text: "kaboom" }], isError: true };
    throw new Error(`unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
