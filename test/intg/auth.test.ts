// #353 — the auth.authorize / auth.authorize.poll device-grant relay (general URL-auth, MCP-routed
// today). execs-mcp owns the mechanics (discovery / DCR / device-authorization / token poll, tested
// there against a mock auth server) and the client drives the poll loop; the service is a stateless
// passthrough keyed by the target EXEC tag. The live end-to-end needs a mock auth server; here we pin
// the service's own surface — the param guards that must fire BEFORE any OAuth call.

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

test("auth.authorize: guards target before touching the OAuth mechanics", async () => {
    const h = handler("auth.authorize");
    await assert.rejects(() => h({}, ctx), /target must be a non-empty string/, "missing target rejected");
});

test("auth.authorize.poll: guards target + device before polling/injecting", async () => {
    const h = handler("auth.authorize.poll");
    await assert.rejects(() => h({ device: {} }, ctx), /target must be/, "missing target rejected");
    await assert.rejects(() => h({ target: "notion" }, ctx), /device must be the opaque blob/, "missing device rejected");
});
