// Minimal real MCP server over stdio — a deterministic test fixture (no Zod,
// low-level Server + hand-crafted handlers). Mcp.test.ts spawns this through
// the real executor over a genuine stdio transport.
//
// Tools: `echo` returns its arguments (readOnlyHint); `boom` returns an isError
// result; any other name throws.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server({ name: "echo", version: "0.0.0" }, { capabilities: { tools: {} } });

const TOOLS = [
    { name: "echo", description: "Echo the arguments back", inputSchema: { type: "object", properties: { msg: { type: "string" } } }, annotations: { readOnlyHint: true } },
    { name: "boom", description: "Always returns an error", inputSchema: { type: "object", properties: {} } },
];

// Full mode serves the tool list PAGINATED (one tool per page) so the client's
// cursor-following is proven by every existing "both tools present" assertion —
// a client that reads only the first page sees `echo` and never `boom`.
server.setRequestHandler("tools/list", async (req) => {
    if (req.params?.cursor === undefined) return { tools: [TOOLS[0]], nextCursor: "page-2" };
    return { tools: [TOOLS[1]] };
});

server.setRequestHandler("tools/call", async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "echo") return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
    if (name === "boom") return { content: [{ type: "text", text: "kaboom" }], isError: true };
    throw new Error(`unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
