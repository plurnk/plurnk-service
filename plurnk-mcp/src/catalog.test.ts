import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import ServerConnection from "./client.ts";
import McpExecutor from "./McpExecutor.ts";

const floor = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
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

const discoveryFloor = { PLURNK_MCP_CONNECT_TIMEOUT: "250", PLURNK_MCP_REQUEST_TIMEOUT: "3000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000" };
const isTimeout = (error: unknown): boolean => {
    assert.ok(error instanceof DOMException && error.name === "TimeoutError"
        || SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout, String(error));
    return true;
};

for (const [method] of lists) {
    test(`{§mcp-catalog-deadline}: stalled ${method} expires before the tool deadline and retries cleanly`, { timeout: 5000 }, async (t) => {
        let stalled = true;
        const served = await serveMcpHttp(t, handler(), async (request) => {
            const body = await request.clone().json();
            if (stalled && body.method === method) await delay(750, undefined, { signal: request.signal });
            return null;
        });
        const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, discoveryFloor);
        t.after(() => connection.close());
        await connection.connect();
        await assert.rejects(connection.catalog(), isTimeout);
        assert.equal(connection.activeRequests, 0);
        stalled = false;
        const catalog = await connection.catalog();
        for (const [, key] of lists) assert.equal(catalog[key].length, 1, "retry publishes the complete catalog");
    });
}

test("{§mcp-catalog-deadline}: pagination shares one deadline rather than renewing it for each page", { timeout: 5000 }, async (t) => {
    const served = await serveMcpHttp(t, handler(), async (request) => {
        const body = await request.clone().json();
        if (body.method !== "resources/templates/list") return null;
        await delay(100, undefined, { signal: request.signal });
        const page = Number(body.params?.cursor ?? 0);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
            resultType: "complete", resourceTemplates: [{ name: `page${page}`, uriTemplate: `test:///${page}/{name}` }],
            ...(page < 6 ? { nextCursor: String(page + 1) } : {}), ttlMs: 0, cacheScope: "private",
        } });
    });
    const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, discoveryFloor);
    t.after(() => connection.close());
    await connection.connect();
    await assert.rejects(connection.resources(), isTimeout);
    const pages = served.requests.filter(({ body }) => (body as { method?: string })?.method === "resources/templates/list");
    assert.ok(pages.length > 1 && pages.length < 7, `deadline stopped the multi-page walk after ${pages.length} pages`);
});

test("{§mcp-catalog-deadline}: caller cancellation stays identifiable and does not close the connection", async (t) => {
    const owner = new AbortController();
    const cause = new Error("caller cancelled discovery");
    const served = await serveMcpHttp(t, handler(), async (request) => {
        const body = await request.clone().json();
        if (body.method === "tools/list") owner.abort(cause);
        return null;
    });
    const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, floor);
    t.after(() => connection.close());
    await assert.rejects(connection.tools(owner.signal), (error) => {
        assert.ok(SdkError.isInstance(error));
        assert.equal(error.code, SdkErrorCode.RequestTimeout);
        assert.equal(error.message, String(cause));
        assert.equal(owner.signal.reason, cause);
        return true;
    });
    assert.equal(connection.activeRequests, 0);
    assert.deepEqual((await connection.callTool("echo", {})).content, [{ type: "text", text: "still callable" }]);
});

test("{§mcp-catalog-deadline}: a real tool operation may outlast the discovery deadline", async (t) => {
    const served = await serveMcpHttp(t, handler(), async (request) => {
        const body = await request.clone().json();
        if (body.method === "tools/call") await delay(500, undefined, { signal: request.signal });
        return null;
    });
    const connection = new ServerConnection({ name: "catalog", transport: "http", url: served.url }, discoveryFloor);
    t.after(() => connection.close());
    await connection.catalog();
    assert.deepEqual((await connection.callTool("echo", {})).content, [{ type: "text", text: "still callable" }]);
});

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
