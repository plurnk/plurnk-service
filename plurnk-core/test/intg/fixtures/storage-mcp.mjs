import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const snapshot = {
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
    pid: process.pid,
};
await mkdir(".tool-state", { recursive: true });
await writeFile(".tool-state/start.json", JSON.stringify(snapshot));
await appendFile(process.env.MCP_STORAGE_MARKER, `${JSON.stringify(snapshot)}\n`);
if (process.env.MCP_STORAGE_FAIL === "1") process.exit(1);

await serveStdio(() => {
    const server = new McpServer({ name: "storage-fixture", version: "1.0.0" });
    server.registerTool("write", {
        description: "Write a relative result and an optional explicit deliverable.",
        inputSchema: fromJsonSchema({ type: "object", properties: { destination: { type: "string" } }, additionalProperties: false }),
    }, async ({ destination }) => {
        await writeFile(".tool-state/result.txt", "retained result\n");
        if (destination !== undefined) await writeFile(destination, "intentional project work\n");
        return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
    });
    return server;
});
