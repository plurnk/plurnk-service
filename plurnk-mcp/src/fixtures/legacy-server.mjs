// A pre-discover legacy peer: speaks the 2025-06-18 initialize surface with one
// tool and no server/discover. Exists to prove the host negotiates-and-degrades
// rather than rejecting an ordinary MCP server at an older supported revision
// ({§mcp-authority}).

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

const reply = (id, payload) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
};

for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === "initialize") {
        reply(request.id, {
            result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "legacy-echo", version: "1.0.0" },
                instructions: "a legacy peer",
            },
        });
        continue;
    }
    if (request.method === "tools/list") {
        reply(request.id, {
            result: {
                tools: [{
                    name: "legacy_echo",
                    description: "echo the text argument",
                    inputSchema: {
                        type: "object",
                        properties: { text: { type: "string" } },
                        required: ["text"],
                    },
                }],
            },
        });
        continue;
    }
    if (request.method === "tools/call") {
        reply(request.id, {
            result: {
                content: [{ type: "text", text: `legacy echo: ${String(request.params?.arguments?.text ?? "")}` }],
                structuredContent: {},
                isError: false,
            },
        });
        continue;
    }
    if (request.method === "ping") {
        reply(request.id, { result: {} });
        continue;
    }
    reply(request.id, { error: { code: -32601, message: `Method not found: ${String(request.method)}` } });
}
