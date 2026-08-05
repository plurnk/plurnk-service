import test from "node:test";
import Prompt from "../../src/schemes/Prompt.ts";
import assert from "node:assert/strict";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";

const manifest = (name: string): SchemeManifest => ({
    name,
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

const handler = (name: string): object => ({ manifest: manifest(name) });

test("SchemeRegistry: constructor registers the complete bundled scheme roster", () => {
    const r = new SchemeRegistry();
    assert.deepEqual(r.list().toSorted(), ["exec", "file", "log", "prompt", "skill", "worker"], "the bundled roster is exact");
});

test("SchemeRegistry: get(name) returns the registered handler instance", () => {
    const r = new SchemeRegistry();
    assert.ok(r.get("worker") instanceof Worker);
    assert.ok(r.get("prompt") instanceof Prompt);
    assert.equal(r.get("plurnk"), undefined, "plurnk:// is retired");
    assert.equal(r.get("known"), undefined, "known:// is retired");
    assert.equal(r.get("unknown"), undefined, "unknown:// is retired");
});

test("SchemeRegistry: get(name) returns undefined for unknown scheme", () => {
    const r = new SchemeRegistry();
    assert.equal(r.get("nonexistent"), undefined);
    assert.equal(r.get("https"), undefined);
});

test("SchemeRegistry: has(name) reflects registration state", () => {
    const r = new SchemeRegistry();
    assert.equal(r.has("worker"), true);
    assert.equal(r.has("nonexistent"), false);
});

test("SchemeRegistry: register(name, handler) accepts new scheme", () => {
    const r = new SchemeRegistry();
    class FakeHttp { static manifest = manifest("https"); }
    r.register("https", new FakeHttp());
    assert.equal(r.has("https"), true);
    assert.ok(r.get("https") instanceof FakeHttp);
});

test("SchemeRegistry: register(name) on already-registered name fails hard", () => {
    const r = new SchemeRegistry();
    assert.throws(
        () => r.register("worker", new Worker()),
        /scheme 'worker' is already registered/,
    );
});

test("SchemeRegistry: list() is sorted and exhaustive", () => {
    const r = new SchemeRegistry();
    class FakeWs { static manifest = manifest("wss"); }
    class FakeHttps { static manifest = manifest("https"); }
    r.register("wss", new FakeWs());
    r.register("https", new FakeHttps());
    assert.deepEqual(r.list().toSorted(), ["exec", "file", "https", "log", "prompt", "skill", "worker", "wss"], "the core roster plus two registered externals");
});

test("SchemeRegistry: two independent registries don't share state", () => {
    const r1 = new SchemeRegistry();
    const r2 = new SchemeRegistry();
    class Local { static manifest = manifest("local"); }
    r1.register("local", new Local());
    assert.equal(r1.has("local"), true);
    assert.equal(r2.has("local"), false);
});

import { DEFAULT_LOOP_FLAGS } from "../../src/core/scheme-types.ts";
test("SchemeRegistry.resolveForLoop: default flags include all bundled schemes", () => {
    const r = new SchemeRegistry();
    const active = r.resolveForLoop(DEFAULT_LOOP_FLAGS);
    assert.deepEqual([...active].toSorted(), ["exec", "file", "log", "prompt", "skill", "worker"]);
});

test("SchemeRegistry.resolveForLoop: mode=ask excludes exec (excludedInAsk)", () => {
    const r = new SchemeRegistry();
    const active = r.resolveForLoop({ ...DEFAULT_LOOP_FLAGS, mode: "ask" });
    assert.equal(active.has("exec"), false);
    assert.equal(active.has("worker"), true);
});

test("SchemeRegistry.resolveForLoop: noProposals is not a gate — exec stays active", () => {
    const r = new SchemeRegistry();
    const active = r.resolveForLoop({ ...DEFAULT_LOOP_FLAGS, noProposals: true });
    assert.equal(active.has("exec"), true);
    assert.equal(active.has("worker"), true);
});

test("SchemeRegistry.resolveForLoop: a manifest without flags is always active", () => {
    const r = new SchemeRegistry();
    r.register("bare", handler("bare"));
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
