// #306 end-to-end — drive the auth.* relay through a REAL mock OAuth server (RFC 9728 discovery →
// auth-server metadata → DCR → token), so the flow runs across the service's own methods on real
// fetch, not a fetchFn stub. Mirrors execs-mcp's own oauth.test mock shape, promoted to an http
// server. Proves the seam execs-mcp's unit tests can't: our methods → execs-mcp mechanics → install.

import test from "node:test";
import assert from "node:assert/strict";
import { mockOAuthServer } from "../_mock-oauth.ts";
import MethodRegistry from "../../src/server/MethodRegistry.ts";
import type { HandlerContext } from "../../src/server/MethodRegistry.ts";
import AuthMethod from "../../src/server/methods/auth.ts";
import { serverConfig } from "@plurnk/plurnk-execs-mcp";

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
    process.env.PLURNK_EXECS_MCP_TESTAUTH = `${base}/mcp`;
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
        delete process.env.PLURNK_EXECS_MCP_TESTAUTH;
        server.close();
    }
});
