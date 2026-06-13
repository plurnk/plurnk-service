import test from "node:test";
import assert from "node:assert/strict";
import MethodRegistry from "../../src/server/MethodRegistry.ts";

test("[§method-registration-register] MethodRegistry: registerMethod accepts a new method", () => {
    const r = new MethodRegistry();
    r.registerMethod("ping", { handler: async () => ({}), description: "liveness" });
    assert.equal(r.hasMethod("ping"), true);
});

test("MethodRegistry: registerMethod on duplicate name throws", () => {
    const r = new MethodRegistry();
    r.registerMethod("ping", { handler: async () => ({}), description: "liveness" });
    assert.throws(
        () => r.registerMethod("ping", { handler: async () => ({}), description: "duplicate" }),
        /method 'ping' is already registered/,
    );
});

test("MethodRegistry: getMethod returns the registration", () => {
    const r = new MethodRegistry();
    r.registerMethod("foo", { handler: async () => ({ ok: true }), description: "test", requiresInit: true });
    const reg = r.getMethod("foo");
    assert.ok(reg !== undefined);
    assert.equal(reg.description, "test");
    assert.equal(reg.requiresInit, true);
});

test("MethodRegistry: getMethod returns undefined for unknown name", () => {
    const r = new MethodRegistry();
    assert.equal(r.getMethod("nonexistent"), undefined);
});

test("MethodRegistry: registerNotification accepts and prevents duplicates", () => {
    const r = new MethodRegistry();
    r.registerNotification("log/entry", { description: "an entry was written" });
    assert.equal(r.hasNotification("log/entry"), true);
    assert.throws(
        () => r.registerNotification("log/entry", { description: "duplicate" }),
        /notification 'log\/entry' is already registered/,
    );
});

test("MethodRegistry: listMethods returns sorted names", () => {
    const r = new MethodRegistry();
    r.registerMethod("zebra", { handler: async () => ({}), description: "z" });
    r.registerMethod("apple", { handler: async () => ({}), description: "a" });
    r.registerMethod("mango", { handler: async () => ({}), description: "m" });
    assert.deepEqual(r.listMethods(), ["apple", "mango", "zebra"]);
});

test("MethodRegistry: catalog surfaces methods + notifications + protocol version", () => {
    const r = new MethodRegistry();
    r.registerMethod("ping", { handler: async () => ({}), description: "liveness" });
    r.registerMethod("loop.run", {
        handler: async () => ({}),
        description: "run a model loop",
        params: { prompt: "string" },
        requiresInit: true,
        longRunning: true,
    });
    r.registerNotification("log/entry", { description: "an entry was written", params: { entry: "object" } });

    const cat = r.catalog();
    assert.equal(cat.protocolVersion, "0.1.0");
    assert.equal(cat.methods.ping.description, "liveness");
    assert.equal(cat.methods.ping.requiresInit, false);
    assert.equal(cat.methods.ping.longRunning, false);
    assert.deepEqual(cat.methods.ping.params, {});
    assert.equal(cat.methods["loop.run"].requiresInit, true);
    assert.equal(cat.methods["loop.run"].longRunning, true);
    assert.deepEqual(cat.methods["loop.run"].params, { prompt: "string" });
    assert.equal(cat.notifications["log/entry"].description, "an entry was written");
});
