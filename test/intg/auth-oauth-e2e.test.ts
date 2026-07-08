// #353 end-to-end — drive the auth.* relay through a REAL mock OAuth server (RFC 9728 discovery →
// auth-server metadata → DCR → device authorization → device-token poll) on real fetch, not a fetchFn
// stub. Proves the seam execs-mcp's unit tests can't: our methods → execs-mcp mechanics → install, and
// that the poll loop (pending → authorized) round-trips the opaque device blob through our surface.

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

test("auth relay end-to-end: device grant — authorize → poll (pending → authorized) injects the bearer", async () => {
    const { server, base } = await mockOAuthServer();
    process.env.PLURNK_EXECS_MCP_TESTAUTH = `${base}/mcp`;
    try {
        // 1. auth.authorize — discovery + DCR + the device-authorization request, all on real fetch to
        // the mock, through our method. No redirect, no loopback server.
        const begun = await handler("auth.authorize")({ target: "testauth" }, ctx) as { verificationUri: string; verificationUriComplete?: string; userCode: string; interval: number; device: unknown };
        assert.match(begun.verificationUri, new RegExp(`^${base}/device`), "verification URL points at the mock");
        assert.equal(begun.userCode, "WDJB-MJHT", "the user code to display");
        assert.ok(begun.interval > 0, "carries a poll interval");
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(begun.device)), "device is a JSON blob the client round-trips");

        // 2. auth.authorize.poll — the client drives the loop with the opaque device blob: first the
        // authorization is still pending, then it's authorized and the bearer is injected.
        const pending = await handler("auth.authorize.poll")({ target: "testauth", device: begun.device }, ctx) as { status: string };
        assert.equal(pending.status, "pending", "first poll: authorization still pending — status passes back verbatim");
        const done = await handler("auth.authorize.poll")({ target: "testauth", device: begun.device }, ctx) as { status: string };
        assert.equal(done.status, "authorized", "second poll: authorized");

        // 3. The bearer is now on the server's resolved config — the next EXEC[testauth] carries it.
        assert.equal(serverConfig("testauth")?.headers?.Authorization, "Bearer tok-abc123", "install overlaid the bearer on authorization");
    } finally {
        delete process.env.PLURNK_EXECS_MCP_TESTAUTH;
        server.close();
    }
});
