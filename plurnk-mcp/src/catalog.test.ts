import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHandler, McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import ServerConnection from "./client.ts";
import McpExecutor from "./McpExecutor.ts";

const floor = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
};

const lists = [
    ["tools/list", "tools"],
    ["resources/list", "resources"],
    ["resources/templates/list", "resourceTemplates"],
    ["prompts/list", "prompts"],
] as const;

const handler = () => createMcpHandler(() => {
    const server = new McpServer({ name: "catalog", version: "1" });
    server.registerTool("echo", { inputSchema: z.object({}) }, async () => ({
        content: [{ type: "text", text: "still callable" }],
    }));
    server.registerResource("note", "test:///note", {}, async () => ({
        contents: [{ uri: "test:///note", text: "still readable" }],
    }));
    server.registerPrompt("note", {}, async () => ({
        messages: [{ role: "user", content: { type: "text", text: "still retrievable" } }],
    }));
    server.server.setRequestHandler("resources/templates/list", () => ({
        resourceTemplates: [{ name: "template", uriTemplate: "test:///{name}" }],
    }));
    return server;
}, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });

for (const [method, collection] of lists) {
    test(`a missing ${method} leaves the other catalog collections usable`, async (t) => {
        let missing = true;
        const served = await serveMcpHttp(t, handler(), async (request) => {
            const body = await request.clone().json();
            return missing && body.method === method
                ? Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not implemented" } })
                : null;
        });
        const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, floor);
        t.after(() => connection.close());
        const executor = new McpExecutor({ runtime: "catalog", glyph: "" }, connection, () => () => undefined);
        const availability = await executor.requireAvailable();
        assert.equal(availability.available, true);
        assert.ok(availability.detail?.includes(`not implemented: ${method}`), String(availability.detail));
        const catalog = await connection.catalog();
        for (const [, key] of lists) {
            assert.equal(catalog[key].length, key === collection ? 0 : 1, key);
        }
        assert.equal((await connection.tools()).length, collection === "tools" ? 0 : 1);
        const resources = await connection.resources();
        assert.equal(resources.resources.length, collection === "resources" ? 0 : 1);
        assert.equal(resources.resourceTemplates.length, collection === "resourceTemplates" ? 0 : 1);
        assert.equal((await connection.prompts()).length, collection === "prompts" ? 0 : 1);
        assert.deepEqual((await connection.callTool("echo", {})).content, [{ type: "text", text: "still callable" }]);
        assert.deepEqual((await connection.readResource("test:///note")).contents, [{ uri: "test:///note", text: "still readable" }]);

        missing = false;
        const refreshed = await executor.requireAvailable();
        assert.equal(refreshed.available, true);
        assert.equal(refreshed.detail?.includes("not implemented:"), false, "absence is not cached as a permanent capability");
        assert.equal((await connection.catalog())[collection].length, 1);
    });
}

for (const code of [-32602, -32603]) {
    test(`a list failure ${code} is not treated as an unsupported method`, async (t) => {
        const served = await serveMcpHttp(t, handler(), async (request) => {
            const body = await request.clone().json();
            return body.method === "resources/templates/list"
                ? Response.json({ jsonrpc: "2.0", id: body.id, error: { code, message: "templates failed" } })
                : null;
        });
        const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, floor);
        t.after(() => connection.close());
        await assert.rejects(connection.catalog(), (error) => {
            assert.ok(ProtocolError.isInstance(error), String(error));
            assert.equal(error.code, code);
            assert.equal(error.message, "templates failed");
            return true;
        });
    });
}

test("a method disappearing after the first page fails instead of publishing a partial catalog", async (t) => {
    const served = await serveMcpHttp(t, handler(), async (request) => {
        const body = await request.clone().json();
        if (body.method !== "resources/templates/list") return null;
        return Response.json({
            jsonrpc: "2.0", id: body.id,
            ...(body.params?.cursor === undefined
                ? { result: { resultType: "complete", resourceTemplates: [{ name: "first", uriTemplate: "test:///{name}" }], nextCursor: "second", ttlMs: 0, cacheScope: "private" } }
                : { error: { code: -32601, message: "method disappeared" } }),
        });
    });
    const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, floor);
    t.after(() => connection.close());
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(connection.catalog(), (error) => {
            assert.ok(ProtocolError.isInstance(error), String(error));
            assert.equal(error.code, -32601);
            assert.equal(error.message, "method disappeared");
            return true;
        });
    }
});

test("method-not-found on a tool call remains an operation error", async (t) => {
    const served = await serveMcpHttp(t, handler(), async (request) => {
        const body = await request.clone().json();
        return body.method === "tools/call"
            ? Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "call unavailable" } })
            : null;
    });
    const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, floor);
    t.after(() => connection.close());
    await connection.catalog();
    await assert.rejects(connection.callTool("echo", {}), (error) => {
        assert.ok(ProtocolError.isInstance(error), String(error));
        assert.equal(error.code, -32601);
        assert.equal(error.message, "call unavailable");
        return true;
    });
});
