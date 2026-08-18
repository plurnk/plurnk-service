import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
import {
    MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID,
    MCP_PROTOCOL_VERSION,
    MCP_TASKS_EXTENSION_ID,
} from "./protocol.ts";

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

test("{§oauth-client-credentials} the extension capability is advertised only on client-credentials connections", async (t) => {
    let servedUrl = "";
    const served = await serveMcpHttp(t, handler(), (request) => {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization");
        if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
            return Response.json({
                resource: servedUrl,
                authorization_servers: [servedUrl],
            });
        }
        if (url.pathname.endsWith("/.well-known/oauth-authorization-server")) {
            return Response.json({
                issuer: servedUrl,
                authorization_endpoint: `${servedUrl}/authorize`,
                token_endpoint: `${servedUrl}/token`,
                scopes_supported: [],
            });
        }
        if (url.pathname.endsWith("/token")) {
            return Response.json({
                access_token: "granted-access-token",
                token_type: "Bearer",
                expires_in: 3600,
            });
        }
        if (authorization === "Bearer granted-access-token" || authorization === "Bearer secret") {
            return null;
        }
        return new Response("unauthorized", { status: 401 });
    });
    servedUrl = served.url;

    const granted = new ServerConnection({
        name: "grant",
        transport: "http",
        url: served.url,
        authorization: {
            type: "client-credentials",
            clientId: "app-id",
            clientSecret: "${MCP_TEST_SECRET}",
            issuer: served.url,
        },
    }, { ...floor, MCP_TEST_SECRET: "client-secret-value" });
    t.after(() => granted.close());
    assert.deepEqual((await granted.tools()).map(({ name }) => name), ["echo"]);
    assert.ok(served.requests.some(({ headers, body }) =>
        headers.get("authorization") === "Bearer granted-access-token" &&
        (body as { method?: string }).method === "server/discover"));

    const bearer = new ServerConnection({
        name: "private",
        transport: "http",
        url: served.url,
        authorization: { type: "bearer", token: "${MCP_TEST_TOKEN}" },
    }, { ...floor, MCP_TEST_TOKEN: "secret" });
    t.after(() => bearer.close());
    assert.deepEqual((await bearer.tools()).map(({ name }) => name), ["echo"]);

    const advertisedExtensions = (body: unknown): Record<string, unknown> | undefined => {
        const meta = (body as {
            params?: { _meta?: { "io.modelcontextprotocol/clientCapabilities"?: {
                extensions?: Record<string, unknown>;
            } } };
        }).params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
        return meta?.extensions;
    };
    const discovers = served.requests
        .map(({ headers, body }) => ({ auth: headers.get("authorization"), body: body as { method?: string } }))
        .filter(({ body }) => body !== null && typeof body === "object" && body.method === "server/discover");
    const [grantedDiscover] = discovers.filter(({ auth }) => auth === "Bearer granted-access-token");
    const [bearerDiscover] = discovers.filter(({ auth }) => auth === "Bearer secret");
    assert.ok(grantedDiscover !== undefined, "the authenticated grant connection discovered once");
    assert.ok(bearerDiscover !== undefined, "the bearer connection discovered once");
    const grantedCapabilities = advertisedExtensions(grantedDiscover.body) ?? {};
    const bearerCapabilities = advertisedExtensions(bearerDiscover.body) ?? {};
    assert.ok(MCP_TASKS_EXTENSION_ID in grantedCapabilities);
    assert.ok(MCP_TASKS_EXTENSION_ID in bearerCapabilities);
    assert.ok(MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID in grantedCapabilities);
    assert.ok(!(MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID in bearerCapabilities));
});

test("{§oauth-client-credentials} a declared issuer withholds the credential from a different authorization server", async (t) => {
    let servedUrl = "";
    let tokenPosts = 0;
    const served = await serveMcpHttp(t, handler(), (request) => {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization");
        if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
            return Response.json({
                resource: servedUrl,
                authorization_servers: [servedUrl],
            });
        }
        if (url.pathname.endsWith("/.well-known/oauth-authorization-server")) {
            return Response.json({
                issuer: servedUrl,
                authorization_endpoint: `${servedUrl}/authorize`,
                token_endpoint: `${servedUrl}/token`,
                scopes_supported: [],
            });
        }
        if (url.pathname.endsWith("/token")) {
            tokenPosts += 1;
            return Response.json({
                access_token: "granted-access-token",
                token_type: "Bearer",
                expires_in: 3600,
            });
        }
        if (authorization === "Bearer granted-access-token") return null;
        return new Response("unauthorized", { status: 401 });
    });
    servedUrl = served.url;

    const connection = new ServerConnection({
        name: "bound",
        transport: "http",
        url: served.url,
        authorization: {
            type: "client-credentials",
            clientId: "app-id",
            clientSecret: "${MCP_TEST_SECRET}",
            issuer: "https://different-issuer.invalid/",
        },
    }, { ...floor, MCP_TEST_SECRET: "client-secret-value" });
    t.after(() => connection.close());

    await assert.rejects(() => connection.tools());
    assert.equal(tokenPosts, 0, "the credential never reached a token endpoint");
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

test("{§oauth-lifetime} an expired access token refreshes with the stored grant without user interaction", async (t) => {
    let origin = "";
    let issuedAt = Number.POSITIVE_INFINITY;
    const tokenRequests: URLSearchParams[] = [];
    const served = await serveMcpHttp(t, handler(), (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
            if (
                request.headers.get("authorization") === "Bearer access-token-2"
                || (
                    request.headers.get("authorization") === "Bearer access-token-1"
                    && Date.now() - issuedAt < 1000
                )
            ) {
                return null;
            }
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
                scopes_supported: ["mcp:read", "offline_access"],
                client_id_metadata_document_supported: true,
                authorization_response_iss_parameter_supported: true,
            });
        }
        if (url.pathname === "/token") {
            return request.text().then((body) => {
                const params = new URLSearchParams(body);
                tokenRequests.push(params);
                if (params.get("grant_type") === "refresh_token") {
                    return Response.json({
                        access_token: "access-token-2",
                        token_type: "Bearer",
                        expires_in: 3600,
                        scope: "mcp:read offline_access",
                    });
                }
                issuedAt = Date.now();
                return Response.json({
                    access_token: "access-token-1",
                    token_type: "Bearer",
                    expires_in: 1,
                    refresh_token: "refresh-token-1",
                    scope: "mcp:read offline_access",
                });
            });
        }
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    const connection = new ServerConnection({
        name: "oauth",
        transport: "http",
        url: served.url,
        authorization: {
            type: "oauth",
            redirectUrl: `${origin}/callback`,
            clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
            scope: "mcp:read",
        },
    }, floor);
    t.after(() => connection.close());

    let authorizationUrl = "";
    await assert.rejects(
        () => connection.connect(),
        (error) => {
            assert.ok(error instanceof AuthorizationRequiredError);
            authorizationUrl = error.authorizationUrl;
            return true;
        },
    );
    const state = new URL(authorizationUrl).searchParams.get("state");
    assert.ok(state);
    await connection.finishAuthorization(
        `${origin}/callback?code=fixture-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(origin)}`,
    );
    assert.deepEqual((await connection.tools()).map(({ name }) => name), ["echo"]);
    assert.equal(tokenRequests.length, 1);

    await delay(1200);
    const renewed = await connection.callTool("echo", { message: "after-expiry" });
    assert.deepEqual(renewed.content, [{ type: "text", text: "after-expiry" }]);
    assert.equal(tokenRequests.length, 2, "expiry surfaces one refresh round-trip");
    const refreshRequest = tokenRequests[1];
    assert.ok(refreshRequest);
    assert.equal(refreshRequest.get("grant_type"), "refresh_token");
    assert.equal(refreshRequest.get("refresh_token"), "refresh-token-1");
});

test("{§mcp-exclusions} unavailable deprecated DCR is attributed without probing it", async (t) => {
    let origin = "";
    let registrationRequests = 0;
    const served = await serveMcpHttp(t, handler(), (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
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
            });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code"],
                code_challenge_methods_supported: ["S256"],
            });
        }
        if (url.pathname === "/register") registrationRequests += 1;
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    const connection = new ServerConnection({
        name: "dcr-unavailable",
        transport: "http",
        url: served.url,
        authorization: {
            type: "oauth",
            redirectUrl: `${origin}/callback`,
        },
    }, floor);
    t.after(() => connection.close());

    await assert.rejects(
        () => connection.connect(),
        (error) => {
            assert.match(String((error as Error).cause), /Dynamic Client Registration endpoint/);
            return true;
        },
    );
    assert.equal(registrationRequests, 0);
});

test("{§mcp-exclusions} OAuth rejects legacy endpoint inference without metadata", async (t) => {
    let origin = "";
    const legacyEndpointRequests: string[] = [];
    const served = await serveMcpHttp(t, handler(), (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
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
            });
        }
        if (["/authorize", "/token", "/register"].includes(url.pathname)) {
            legacyEndpointRequests.push(url.pathname);
        }
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    const connection = new ServerConnection({
        name: "missing-auth-metadata",
        transport: "http",
        url: served.url,
        authorization: {
            type: "oauth",
            redirectUrl: `${origin}/callback`,
        },
    }, floor);
    t.after(() => connection.close());

    await assert.rejects(
        () => connection.connect(),
        (error) => {
            assert.match(String((error as Error).cause), /authorization-server metadata/);
            return true;
        },
    );
    assert.deepEqual(legacyEndpointRequests, []);
});
