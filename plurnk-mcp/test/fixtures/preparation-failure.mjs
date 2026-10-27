// {§mcp-module}: the probe is hidden by the SDK; only the
// subsequent real session exposes stderr through the public transport.
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === "server/discover") {
        process.stderr.write("probe-only diagnostic\n");
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
        continue;
    }
    if (request.method === "initialize") {
        process.stderr.write(`session rejected ${process.env.FIXTURE_SECRET}\n`, () => process.exit(23));
    }
}
