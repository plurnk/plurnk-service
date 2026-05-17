import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import Plurnk from "../../src/schemes/Plurnk.ts";

test("SchemeRegistry: constructor registers all seven bundled schemes", () => {
    const r = new SchemeRegistry();
    assert.deepEqual(r.list(), ["exec", "file", "known", "log", "plurnk", "skill", "unknown"]);
});

test("SchemeRegistry: get(name) returns the registered handler instance", () => {
    const r = new SchemeRegistry();
    assert.ok(r.get("known") instanceof Known);
    assert.ok(r.get("plurnk") instanceof Plurnk);
});

test("SchemeRegistry: get(name) returns undefined for unknown scheme", () => {
    const r = new SchemeRegistry();
    assert.equal(r.get("nonexistent"), undefined);
    assert.equal(r.get("https"), undefined);
});

test("SchemeRegistry: has(name) reflects registration state", () => {
    const r = new SchemeRegistry();
    assert.equal(r.has("known"), true);
    assert.equal(r.has("nonexistent"), false);
});

test("SchemeRegistry: register(name, handler) accepts new scheme", () => {
    const r = new SchemeRegistry();
    class FakeHttp {}
    r.register("https", new FakeHttp());
    assert.equal(r.has("https"), true);
    assert.ok(r.get("https") instanceof FakeHttp);
});

test("SchemeRegistry: register(name) on already-registered name fails hard", () => {
    const r = new SchemeRegistry();
    assert.throws(
        () => r.register("known", new Known()),
        /scheme 'known' is already registered/,
    );
});

test("SchemeRegistry: list() is sorted and exhaustive", () => {
    const r = new SchemeRegistry();
    class FakeWs {}
    class FakeHttps {}
    r.register("wss", new FakeWs());
    r.register("https", new FakeHttps());
    assert.deepEqual(r.list(), ["exec", "file", "https", "known", "log", "plurnk", "skill", "unknown", "wss"]);
});

test("SchemeRegistry: two independent registries don't share state", () => {
    const r1 = new SchemeRegistry();
    const r2 = new SchemeRegistry();
    class Local {}
    r1.register("local", new Local());
    assert.equal(r1.has("local"), true);
    assert.equal(r2.has("local"), false);
});
