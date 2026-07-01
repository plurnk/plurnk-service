import test from "node:test";
import { strict as assert } from "node:assert";
import { authorize, completeAuth } from "./oauth.ts";
import { install } from "./Mcp.ts";
import { serverConfig } from "./config.ts";

const RESOURCE = "https://mcp.test/mcp";
const AS = "https://auth.test";
const REDIRECT = "http://127.0.0.1:9876/callback";

const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// A mock authorization server: RFC 9728 protected-resource metadata → auth-server
// metadata → DCR → token, driven entirely through the injected fetchFn (no network).
const mockFetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.includes("oauth-protected-resource")) return json({ resource: RESOURCE, authorization_servers: [AS] });
    if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
        return json({
            issuer: AS,
            authorization_endpoint: `${AS}/authorize`,
            token_endpoint: `${AS}/token`,
            registration_endpoint: `${AS}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
    }
    if (url === `${AS}/register`) return json({ client_id: "test-client-id", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    if (url === `${AS}/token`) return json({ access_token: "tok-abc123", token_type: "Bearer", expires_in: 3600 });
    return new Response("not found", { status: 404 });
}) as typeof fetch;

test("authorize: RFC 9728 discovery + DCR + PKCE → an authorization URL to propose; pkce round-trips as JSON", async () => {
    process.env.PLURNK_MCP_OASRV = RESOURCE;
    try {
        const { authorizationUrl, pkce } = await authorize("oasrv", { redirectUri: REDIRECT, fetchFn: mockFetch });
        assert.match(authorizationUrl, /^https:\/\/auth\.test\/authorize\?/);
        assert.match(authorizationUrl, /client_id=test-client-id/);
        assert.match(authorizationUrl, /code_challenge=[^&]+/, "carries a PKCE challenge");
        assert.match(authorizationUrl, /code_challenge_method=S256/);
        assert.equal(typeof pkce.codeVerifier, "string");
        assert.match(pkce.authorizationServerUrl, /auth\.test/);
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(pkce)), "pkce is an opaque JSON blob the caller carries back");
    } finally {
        delete process.env.PLURNK_MCP_OASRV;
    }
});

test("completeAuth: authorization-code exchange → Bearer headers to inject", async () => {
    process.env.PLURNK_MCP_OASRV = RESOURCE;
    try {
        const { pkce } = await authorize("oasrv", { redirectUri: REDIRECT, fetchFn: mockFetch });
        const { headers } = await completeAuth("oasrv", { code: "auth-code-xyz", pkce, redirectUri: REDIRECT, fetchFn: mockFetch });
        assert.deepEqual(headers, { Authorization: "Bearer tok-abc123" });
    } finally {
        delete process.env.PLURNK_MCP_OASRV;
    }
});

test("install: overlays the bearer onto an env server's headers and evicts the cached client (#1)", () => {
    process.env.PLURNK_MCP_OASRV = RESOURCE;
    try {
        install("oasrv", { Authorization: "Bearer tok-abc123" });
        assert.equal(serverConfig("oasrv")?.headers?.Authorization, "Bearer tok-abc123");
    } finally {
        delete process.env.PLURNK_MCP_OASRV;
    }
});

test("authorize: a stdio server is rejected — OAuth is http-only", async () => {
    process.env.PLURNK_MCP_STDIOSRV = "node server.mjs";
    try {
        await assert.rejects(
            authorize("stdiosrv", { redirectUri: REDIRECT, fetchFn: mockFetch }),
            /not a configured http server/,
        );
    } finally {
        delete process.env.PLURNK_MCP_STDIOSRV;
    }
});
