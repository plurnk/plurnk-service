import assert from "node:assert/strict";
import test from "node:test";
import {
    acceptedContent,
    inputRequired,
    McpServer,
    createMcpHandler,
    type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { serveMcpHttp } from "../test/http-fixture.ts";
import ServerConnection, { AuthorizationRequiredError } from "./client.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";

const floor = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
};

const handler = (): McpHttpHandler => createMcpHandler(() => {
    const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
    server.registerTool(
        "echo",
        {
            description: "Echo one message.",
            inputSchema: z.object({ message: z.string() }),
        },
        async ({ message }) => ({
            content: [{ type: "text", text: String(message) }],
        }),
    );
    return server;
}, {
    legacy: "reject",
    responseMode: "auto",
    keepAliveMs: 0,
});

const lifecycleHandler = (
    onWaitStarted: () => void,
    onWaitCancelled: () => void,
): McpHttpHandler => createMcpHandler(() => {
    const server = new McpServer({ name: "http-lifecycle-fixture", version: "1.0.0" });
    server.registerTool(
        "progress",
        { description: "Report progress.", inputSchema: z.object({}) },
        async (_args, ctx) => {
            const progressToken = ctx.mcpReq._meta?.progressToken;
            if (progressToken === undefined) throw new Error("Progress token was not requested.");
            await ctx.mcpReq.notify({
                method: "notifications/progress",
                params: { progressToken, progress: 1, total: 2, message: "halfway" },
            });
            return { content: [{ type: "text", text: "done" }] };
        },
    );
    server.registerTool(
        "wait",
        { description: "Wait for cancellation.", inputSchema: z.object({}) },
        async (_args, ctx) => {
            onWaitStarted();
            await new Promise((resolve, reject) => {
                if (ctx.mcpReq.signal.aborted) {
                    onWaitCancelled();
                    reject(ctx.mcpReq.signal.reason);
                    return;
                }
                ctx.mcpReq.signal.addEventListener("abort", () => {
                    onWaitCancelled();
                    reject(ctx.mcpReq.signal.reason);
                }, { once: true });
            });
            return { content: [{ type: "text", text: "unexpected" }] };
        },
    );
    return server;
}, {
    legacy: "reject",
    responseMode: "auto",
    keepAliveMs: 0,
});

const httpRequestState = "http::\u03b4\nopaque";

const interactionHandler = (): McpHttpHandler => createMcpHandler(() => {
    const server = new McpServer({ name: "http-interaction-fixture", version: "1.0.0" });
    server.registerTool(
        "confirm",
        { description: "Confirm over Streamable HTTP.", inputSchema: z.object({}) },
        async (_args, ctx) => {
            if (ctx.mcpReq.requestState() === undefined) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: "Continue over HTTP?",
                            requestedSchema: {
                                type: "object",
                                properties: { confirm: { type: "boolean" } },
                                required: ["confirm"],
                                additionalProperties: false,
                            },
                        }),
                    },
                    requestState: httpRequestState,
                });
            }
            if (ctx.mcpReq.requestState() !== httpRequestState) {
                throw new Error("HTTP requestState changed in transit.");
            }
            const response = acceptedContent(ctx.mcpReq.inputResponses, "confirm", z.object({
                confirm: z.boolean(),
            }));
            if (response?.confirm !== true) throw new Error("HTTP input response changed in transit.");
            return { content: [{ type: "text", text: "confirmed" }] };
        },
    );
    return server;
}, {
    legacy: "reject",
    responseMode: "auto",
    keepAliveMs: 0,
});

test("Streamable HTTP carries the current envelope and ordinary tool calls", async (t) => {
    const served = await serveMcpHttp(t, handler());
    const connection = new ServerConnection({
        name: "http",
        transport: "http",
        url: served.url,
    }, floor);
    t.after(() => connection.close());

    const catalog = await connection.catalog();
    assert.deepEqual(catalog.tools.map(({ name }) => name), ["echo"]);
    const result = await connection.callTool("echo", { message: "hello" });
    assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);

    const messages = served.requests.map(({ body }) => body as {
        method?: string;
        params?: { _meta?: Record<string, unknown> };
    });
    assert.ok(messages.some(({ method }) => method === "server/discover"));
    assert.ok(messages.some(({ method }) => method === "tools/call"));
    for (const [index, request] of served.requests.entries()) {
        assert.equal(
            request.headers.get("mcp-protocol-version"),
            MCP_PROTOCOL_VERSION,
            `request ${index} carries the pinned revision header`,
        );
        const message = messages[index];
        assert.equal(
            message.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
            MCP_PROTOCOL_VERSION,
            `request ${index} carries the matching envelope revision`,
        );
    }
});

test("HTTP bearer credentials expand only while preparing a connection", async (t) => {
    const served = await serveMcpHttp(t, handler(), (request) =>
        request.headers.get("authorization") === "Bearer secret"
            ? null
            : new Response("unauthorized", { status: 401 }));
    const connection = new ServerConnection({
        name: "private",
        transport: "http",
        url: served.url,
        authorization: { type: "bearer", token: "${MCP_TEST_TOKEN}" },
    }, { ...floor, MCP_TEST_TOKEN: "secret" });
    t.after(() => connection.close());

    assert.deepEqual((await connection.tools()).map(({ name }) => name), ["echo"]);
    assert.ok(served.requests.length > 0);
    assert.ok(served.requests.every(({ headers }) =>
        headers.get("authorization") === "Bearer secret"));
    assert.equal(connection.definition.authorization?.type, "bearer");
    if (connection.definition.authorization?.type === "bearer") {
        assert.equal(connection.definition.authorization.token, "${MCP_TEST_TOKEN}");
    }
});

test("HTTP progress and stream cancellation settle the same request", async (t) => {
    let startWait = (): void => undefined;
    const waitStarted = new Promise<void>((resolve) => { startWait = resolve; });
    let recordCancellation = (): void => undefined;
    const waitCancelled = new Promise<void>((resolve) => { recordCancellation = resolve; });
    const served = await serveMcpHttp(t, lifecycleHandler(startWait, recordCancellation));
    const connection = new ServerConnection({
        name: "lifecycle",
        transport: "http",
        url: served.url,
    }, floor);
    t.after(() => connection.close());

    const progress: unknown[] = [];
    await connection.callTool("progress", {}, undefined, (value) => progress.push(value));
    assert.deepEqual(progress, [{ progress: 1, total: 2, message: "halfway" }]);

    const controller = new AbortController();
    const running = connection.callTool("wait", {}, controller.signal);
    await waitStarted;
    controller.abort(new Error("test cancellation"));
    await assert.rejects(running, /test cancellation|abort/i);
    await waitCancelled;
    assert.equal(
        served.requests.some(({ body }) =>
            (body as { method?: string }).method === "notifications/cancelled"),
        false,
        "Streamable HTTP cancellation closes the request instead of posting a cancellation notification",
    );
});

test("Streamable HTTP retries MRTR with a fresh ID and exact private continuation state", async (t) => {
    const served = await serveMcpHttp(t, interactionHandler());
    const connection = new ServerConnection({
        name: "interaction",
        transport: "http",
        url: served.url,
    }, floor);
    t.after(() => connection.close());

    let projectedRequest = "";
    const result = await connection.callTool(
        "confirm",
        {},
        undefined,
        undefined,
        async (request) => {
            projectedRequest = JSON.stringify(request);
            return {
                status: "resolved",
                payload: {
                    confirm: { action: "accept", content: { confirm: true } },
                },
            };
        },
    );
    assert.deepEqual(result.content, [{ type: "text", text: "confirmed" }]);
    assert.equal(projectedRequest.includes(httpRequestState), false);

    const calls = served.requests
        .map(({ body }) => body as {
            id?: number;
            method?: string;
            params?: {
                requestState?: string;
                inputResponses?: Record<string, unknown>;
            };
        })
        .filter(({ method }) => method === "tools/call");
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0]?.id, calls[1]?.id);
    assert.equal(calls[0]?.params?.requestState, undefined);
    assert.equal(calls[1]?.params?.requestState, httpRequestState);
    assert.deepEqual(calls[1]?.params?.inputResponses, {
        confirm: { action: "accept", content: { confirm: true } },
    });
});

test("interactive HTTP OAuth preserves discovery, PKCE, state, issuer, and resource binding", async (t) => {
    let origin = "";
    const tokenRequests: URLSearchParams[] = [];
    const served = await serveMcpHttp(t, handler(), (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
            if (request.headers.get("authorization") === "Bearer access-token") return null;
            return new Response("unauthorized", {
                status: 401,
                headers: {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
                },
            });
        }
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            return Response.json({
                resource: `${origin}/mcp`,
                authorization_servers: [origin],
                scopes_supported: ["mcp:read"],
            });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
                client_id_metadata_document_supported: true,
                authorization_response_iss_parameter_supported: true,
            });
        }
        if (url.pathname === "/token") {
            return request.text().then((body) => {
                tokenRequests.push(new URLSearchParams(body));
                return Response.json({
                    access_token: "access-token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "mcp:read",
                });
            });
        }
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    const clientMetadataUrl = "https://client.example.test/oauth/metadata.json";
    const connection = new ServerConnection({
        name: "oauth",
        transport: "http",
        url: served.url,
        authorization: {
            type: "oauth",
            redirectUrl: `${origin}/callback`,
            clientMetadataUrl,
            scope: "mcp:read",
        },
    }, floor);
    t.after(() => connection.close());

    let authorizationUrl = "";
    await assert.rejects(
        () => connection.connect(),
        (error) => {
            assert.ok(
                error instanceof AuthorizationRequiredError,
                error instanceof Error
                    ? `${error.name}: ${error.message}; cause=${String(error.cause)}`
                    : String(error),
            );
            authorizationUrl = error.authorizationUrl;
            return true;
        },
    );
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.origin + authorization.pathname, `${origin}/authorize`);
    assert.equal(authorization.searchParams.get("client_id"), clientMetadataUrl);
    assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}/callback`);
    assert.equal(authorization.searchParams.get("resource"), `${origin}/mcp`);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.ok((authorization.searchParams.get("code_challenge")?.length ?? 0) >= 43);
    const state = authorization.searchParams.get("state");
    assert.ok(state);

    await assert.rejects(
        () => connection.finishAuthorization(`${origin}/callback?code=fixture-code&state=wrong&iss=${encodeURIComponent(origin)}`),
        /state does not match/,
    );
    await connection.finishAuthorization(
        `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
    );
    assert.deepEqual((await connection.tools()).map(({ name }) => name), ["echo"]);
    const tokenRequest = tokenRequests[0];
    assert.ok(tokenRequest);
    assert.equal(tokenRequest.get("grant_type"), "authorization_code");
    assert.equal(tokenRequest.get("code"), "fixture-code");
    assert.equal(tokenRequest.get("redirect_uri"), `${origin}/callback`);
    assert.ok((tokenRequest.get("code_verifier")?.length ?? 0) >= 43);
    assert.equal(tokenRequest.get("resource"), `${origin}/mcp`);
});
