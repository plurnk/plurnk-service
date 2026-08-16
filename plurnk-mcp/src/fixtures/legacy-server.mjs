// Negative conformance peer: a pre-server/discover endpoint. It exists only to
// prove that the host attributes a retired MCP lifecycle without downgrading.

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
            code: -32601,
            message: `Method not found: ${String(request.method)}`,
        },
    })}\n`);
}
