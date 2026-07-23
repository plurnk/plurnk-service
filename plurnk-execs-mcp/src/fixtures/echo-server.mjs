// Minimal real MCP server over stdio — a deterministic test fixture (no Zod,
// low-level Server + hand-crafted handlers). The Mcp.test.ts / McpScheme.test.ts
// suites spawn this via the real executor/scheme to exercise both faces
// end-to-end over a genuine stdio transport.
//
// MCP_FIXTURE_MODE selects the server's shape:
//   full (default)  tools + resources (incl. a template) + prompts
//   bare            tools only — the unadvertised-primitive gate tests
//   notemplates     resources WITHOUT a templates handler — the client's
//                   -32601 tolerance path (real servers commonly omit it)
//
// Tools: `echo` returns its arguments (readOnlyHint); `boom` returns an isError
// result; any other name throws.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const mode = process.env.MCP_FIXTURE_MODE ?? "full";
const capabilities = mode === "bare"
    ? { tools: {} }
    : { tools: {}, resources: {}, prompts: {} };

const server = new Server({ name: "echo", version: "0.0.0" }, { capabilities });

const TOOLS = [
    { name: "echo", description: "Echo the arguments back", inputSchema: { type: "object", properties: { msg: { type: "string" } } }, annotations: { readOnlyHint: true } },
    { name: "boom", description: "Always returns an error", inputSchema: { type: "object", properties: {} } },
];

// Full mode serves the tool list PAGINATED (one tool per page) so the client's
// cursor-following is proven by every existing "both tools present" assertion —
// a client that reads only the first page sees `echo` and never `boom`.
server.setRequestHandler("tools/list", async (req) => {
    if (mode === "bare") return { tools: TOOLS };
    if (req.params?.cursor === undefined) return { tools: [TOOLS[0]], nextCursor: "page-2" };
    return { tools: [TOOLS[1]] };
});

server.setRequestHandler("tools/call", async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "echo") return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
    if (name === "boom") return { content: [{ type: "text", text: "kaboom" }], isError: true };
    throw new Error(`unknown tool: ${name}`);
});

if (mode !== "bare") {
    server.setRequestHandler("resources/list", async () => ({
        resources: [
            { uri: "mem://greeting.txt", name: "greeting", mimeType: "text/plain" },
            { uri: "mem://parts", name: "parts" },
        ],
    }));

    server.setRequestHandler("resources/read", async (req) => {
        const { uri } = req.params;
        if (uri === "mem://greeting.txt") return { contents: [{ uri, mimeType: "text/plain", text: "hello from the fixture" }] };
        if (uri === "mem://parts") return { contents: [{ uri, text: "part one" }, { uri, text: "part two" }] };
        const note = /^mem:\/\/notes\/(.+)$/.exec(uri);
        if (note !== null) return { contents: [{ uri, mimeType: "text/plain", text: `note ${note[1]}` }] };
        throw new Error(`unknown resource: ${uri}`);
    });

    // notemplates: capability advertised, handler absent → the low-level Server
    // answers resources/templates/list with JSON-RPC -32601 Method not found.
    if (mode !== "notemplates") {
        server.setRequestHandler("resources/templates/list", async () => ({
            resourceTemplates: [{ uriTemplate: "mem://notes/{id}", name: "note" }],
        }));
    }

    server.setRequestHandler("prompts/list", async () => ({
        prompts: [{ name: "greet", description: "Greet someone", arguments: [{ name: "who", required: true }] }],
    }));

    server.setRequestHandler("prompts/get", async (req) => {
        const { name, arguments: args } = req.params;
        if (name !== "greet") throw new Error(`unknown prompt: ${name}`);
        return { description: "Greet someone", messages: [{ role: "user", content: { type: "text", text: `Say hello to ${args?.who ?? "nobody"}` } }] };
    });
}

await server.connect(new StdioServerTransport());
