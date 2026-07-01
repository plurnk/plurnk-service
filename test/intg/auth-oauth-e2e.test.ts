// #306 end-to-end — drive the auth.* relay through a REAL mock OAuth server (RFC 9728 discovery →
// auth-server metadata → DCR → token), so the flow runs across the service's own methods on real
// fetch, not a fetchFn stub. Mirrors execs-mcp's own oauth.test mock shape, promoted to an http
// server. Proves the seam execs-mcp's unit tests can't: our methods → execs-mcp mechanics → install.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import MethodRegistry from "../../src/server/MethodRegistry.ts";
import type { HandlerContext } from "../../src/server/MethodRegistry.ts";
import AuthMethod from "../../src/server/methods/auth.ts";
import { serverConfig } from "@plurnk/plurnk-execs-mcp";

const mockOAuthServer = async (): Promise<{ server: Server; base: string }> => {
    const server = createServer((req, res) => {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const send = (body: unknown): void => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        const url = req.url ?? "";
        if (url.includes("oauth-protected-resource")) return send({ resource: `${base}/mcp`, authorization_servers: [base] });
        if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) return send({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
        if (url.includes("/register")) return send({ client_id: "test-client-id", redirect_uris: ["http://127.0.0.1:9876/callback"], token_endpoint_auth_method: "none" });
        if (url.includes("/token")) return send({ access_token: "tok-abc123", token_type: "Bearer", expires_in: 3600 });
        res.writeHead(404); res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const ctx = {} as HandlerContext;
const handler = (name: string) => {
    const reg = new MethodRegistry();
    AuthMethod.register(reg);
    const h = reg.getMethod(name)?.handler;
    assert.ok(h, `${name} registered`);
    return h;
};

test("auth relay end-to-end: authorize → code → complete injects the bearer (real mock OAuth server)", async () => {
    const { server, base } = await mockOAuthServer();
    process.env.PLURNK_MCP_TESTAUTH = `${base}/mcp`;
    const redirectUri = "http://127.0.0.1:9876/callback";
    try {
        // 1. auth.authorize — discovery + DCR + PKCE, all on real fetch to the mock, through our method.
        const begun = await handler("auth.authorize")({ target: "testauth", redirectUri }, ctx) as { authorizationUrl: string; pkce: unknown };
        assert.match(begun.authorizationUrl, new RegExp(`^${base}/authorize\\?`), "authorization URL points at the mock auth server");
        assert.match(begun.authorizationUrl, /code_challenge=[^&]+/, "carries a PKCE challenge");
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(begun.pkce)), "pkce is a JSON blob the client round-trips");

        // 2. auth.authorize.complete — the client would return this code off its loopback; exchange + inject.
        const done = await handler("auth.authorize.complete")({ target: "testauth", code: "auth-code-xyz", pkce: begun.pkce, redirectUri }, ctx) as { ok: boolean };
        assert.equal(done.ok, true, "complete succeeds");

        // 3. The bearer is now on the server's resolved config — the next EXEC[testauth] carries it.
        assert.equal(serverConfig("testauth")?.headers?.Authorization, "Bearer tok-abc123", "install overlaid the bearer");
    } finally {
        delete process.env.PLURNK_MCP_TESTAUTH;
        server.close();
    }
});
