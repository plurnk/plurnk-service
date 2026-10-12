import test from "node:test";
import assert from "node:assert/strict";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import ServerConnection from "./client.ts";
import { HeaderDeclarationError } from "./protocolHeaders.ts";
import { MCP_TASKS_EXTENSION_ID } from "./protocol.ts";
import { serveMcpHttp } from "../test/http-fixture.ts";
import { wireRequest } from "../test/task-fixture.ts";

const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

// The referee's invalid definitions, as the server SDK registers them without complaint.
const invalidNumberHeader = { type: "object", properties: { score: { type: "number", "x-mcp-header": "Score" } }, required: ["score"] } as const;
const validRegionHeader = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } }, required: ["region"] } as const;

const server = (tasks: boolean) => createMcpHandler(() => {
    const instance = new McpServer(
        { name: tasks ? "tasks-leg" : "direct-leg", version: "1.0.0" },
        tasks ? { capabilities: { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } } } : {},
    );
    instance.registerTool("valid_tool", { inputSchema: fromJsonSchema(validRegionHeader) }, async () => ({ content: [{ type: "text", text: "valid called" }] }));
    instance.registerTool("invalid_number_header", { inputSchema: fromJsonSchema(invalidNumberHeader) }, async () => ({ content: [{ type: "text", text: "must never run" }] }));
    return instance;
}, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });

for (const [leg, tasks] of [["direct", false], ["tasks", true]] as const) {
    test(`{§mcp-header-declarations} on the ${leg} leg an invalid x-mcp-header declaration is refused before any request is sent`, async (t) => {
        const { url, requests } = await serveMcpHttp(t, server(tasks));
        const connection = new ServerConnection({ name: `${leg}-leg`, type: "streamable-http", url }, env);
        try {
            const tools = await connection.tools();
            const invalid = tools.find((tool) => tool.name === "invalid_number_header");
            assert.ok(invalid, "the listing carries the invalid definition; the refusal is the call's");
            for (const definition of [invalid, undefined]) {
                await assert.rejects(
                    connection.callTool("invalid_number_header", { score: 1 }, undefined, undefined, undefined, definition),
                    (error: unknown) => {
                        assert.ok(error instanceof HeaderDeclarationError);
                        assert.equal(error.tool, "invalid_number_header");
                        assert.equal(error.declaration, "score: x-mcp-header 'Score' on type number; permitted on string, integer and boolean");
                        return true;
                    },
                    definition === undefined ? "the listing supplies the definition when the caller does not" : "the caller's definition is scanned",
                );
            }
            const calls = requests.filter((request) => wireRequest(request).method === "tools/call");
            assert.equal(calls.length, 0, "no tools/call reached the transport");
            if (!tasks) {
                const result = await connection.callTool("valid_tool", { region: "us-west1" }) as { content: Array<{ text: string }> };
                assert.equal(result.content[0]?.text, "valid called", "a valid tool on the same server is still called");
                const valid = requests.filter((request) => wireRequest(request).method === "tools/call");
                assert.equal(valid.length, 1);
                assert.equal(valid[0]?.headers.get("mcp-param-region"), "us-west1", "its declared parameter is mirrored");
            }
        } finally {
            await connection.close();
        }
    });
}
