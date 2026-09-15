import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { appendFileSync } from "node:fs";
import { z } from "zod/v4";

const values = {
    witness: process.env.ENV_WITNESS ?? null,
    private: process.env.WORKER_ONLY ?? null,
    bound: process.env.BOUND_VALUE ?? null,
    reference: process.env.REF_VALUE ?? null,
    home: process.env.HOME ?? null,
    pid: process.pid,
};
if (process.env.MCP_ENV_MARKER) appendFileSync(process.env.MCP_ENV_MARKER, `${JSON.stringify(values)}\n`);
await serveStdio(() => {
    const server = new McpServer({ name: `env-${values.witness ?? "missing"}`, version: "1.0.0" });
    server.registerTool("environment", { description: "Read this fixture's launch environment.", inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: JSON.stringify(values) }] }));
    return server;
});
