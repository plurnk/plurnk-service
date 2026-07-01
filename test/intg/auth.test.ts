// #306 — the auth.authorize / auth.authorize.complete OAuth relay (general URL-auth, MCP-routed today).
// execs-mcp owns the mechanics (discovery/PKCE/exchange, tested there against a mock auth server) and
// the client owns the browser leg; the service is a stateless passthrough keyed by the target EXEC tag.
// The live end-to-end needs a mock auth server; here we pin the service's own surface — the param
// guards that must fire BEFORE any OAuth call.

import test from "node:test";
import assert from "node:assert/strict";
import MethodRegistry from "../../src/server/MethodRegistry.ts";
import type { HandlerContext } from "../../src/server/MethodRegistry.ts";
import AuthMethod from "../../src/server/methods/auth.ts";

const ctx = {} as HandlerContext; // the guards reject before any ctx/OAuth use
const handler = (name: string) => {
    const reg = new MethodRegistry();
    AuthMethod.register(reg);
    const h = reg.getMethod(name)?.handler;
    assert.ok(h, `${name} is registered`);
    return h;
};

test("auth.authorize: guards target + redirectUri before touching the OAuth mechanics", async () => {
    const h = handler("auth.authorize");
    await assert.rejects(() => h({ redirectUri: "http://127.0.0.1:9/cb" }, ctx), /target must be a non-empty string/, "missing target rejected");
    await assert.rejects(() => h({ target: "notion" }, ctx), /redirectUri must be a non-empty string/, "missing redirectUri rejected");
});

test("auth.authorize.complete: guards target + code + pkce + redirectUri before exchange/inject", async () => {
    const h = handler("auth.authorize.complete");
    await assert.rejects(() => h({ code: "c", pkce: {}, redirectUri: "r" }, ctx), /target must be/, "missing target rejected");
    await assert.rejects(() => h({ target: "notion", pkce: {}, redirectUri: "r" }, ctx), /code must be/, "missing code rejected");
    await assert.rejects(() => h({ target: "notion", code: "c", redirectUri: "r" }, ctx), /pkce must be the blob/, "missing pkce rejected");
    await assert.rejects(() => h({ target: "notion", code: "c", pkce: {} }, ctx), /redirectUri must match/, "missing redirectUri rejected");
});
