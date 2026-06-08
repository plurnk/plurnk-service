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

import { DEFAULT_LOOP_FLAGS } from "../../src/core/scheme-types.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";

test("SchemeRegistry.resolveForLoop: default flags include all bundled schemes", () => {
    const r = new SchemeRegistry();
    const active = r.resolveForLoop(DEFAULT_LOOP_FLAGS);
    assert.deepEqual([...active].toSorted(), ["exec", "file", "known", "log", "plurnk", "skill", "unknown"]);
});

test("[§3.1-manifest] SchemeRegistry.resolveForLoop: mode=ask excludes exec (excludedInAsk)", () => {
    const r = new SchemeRegistry();
    const active = r.resolveForLoop({ ...DEFAULT_LOOP_FLAGS, mode: "ask" });
    assert.equal(active.has("exec"), false);
    assert.equal(active.has("known"), true);
});

test("SchemeRegistry.resolveForLoop: noProposals is not a gate — exec stays active", () => {
    const r = new SchemeRegistry();
    const active = r.resolveForLoop({ ...DEFAULT_LOOP_FLAGS, noProposals: true });
    assert.equal(active.has("exec"), true);
    assert.equal(active.has("known"), true);
});

test("SchemeRegistry.resolveForLoop: handler without manifest is always active", () => {
    const r = new SchemeRegistry();
    class Bare {}
    r.register("bare", new Bare());
    const active = r.resolveForLoop({ ...DEFAULT_LOOP_FLAGS, mode: "ask", noWeb: true, noInteraction: true, noProposals: true });
    assert.equal(active.has("bare"), true);
});

test("SchemeRegistry.resolveForLoop: noWeb gates requiresWeb affinity", () => {
    const r = new SchemeRegistry();
    class Http {
        static manifest: SchemeManifest = {
            name: "http",
            channels: {},
            defaultChannel: "body",
            category: "data",
            scope: "session",
            writableBy: ["model"],
            volatile: true,
            modelVisible: true,
            flags: { requiresWeb: true },
        };
    }
    r.register("http", new Http());
    assert.equal(r.resolveForLoop(DEFAULT_LOOP_FLAGS).has("http"), true);
    assert.equal(r.resolveForLoop({ ...DEFAULT_LOOP_FLAGS, noWeb: true }).has("http"), false);
});

test("SchemeRegistry.resolveForLoop: noInteraction gates requiresInteraction affinity", () => {
    const r = new SchemeRegistry();
    class Ask {
        static manifest: SchemeManifest = {
            name: "ask",
            channels: {},
            defaultChannel: "body",
            category: "data",
            scope: "session",
            writableBy: ["model"],
            volatile: true,
            modelVisible: true,
            flags: { requiresInteraction: true },
        };
    }
    r.register("ask", new Ask());
    assert.equal(r.resolveForLoop(DEFAULT_LOOP_FLAGS).has("ask"), true);
    assert.equal(r.resolveForLoop({ ...DEFAULT_LOOP_FLAGS, noInteraction: true }).has("ask"), false);
});
