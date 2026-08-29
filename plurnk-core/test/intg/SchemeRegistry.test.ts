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
    entryOwner: "commons",
    inherit: "none",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

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
        /scheme name 'worker' is reserved by core package '@plurnk\/plurnk-service'; programmatic scheme 'worker' cannot claim it/,
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

test("SchemeRegistry exposes scheme traits without owning capability admission", () => {
    const r = new SchemeRegistry();
    class Http {
        static manifest: SchemeManifest = {
            name: "https",
            channels: {},
            defaultChannel: "body",
            category: "data",
            entryOwner: "worker",
            inherit: "none",
            writableBy: ["model"],
            volatile: true,
            modelVisible: true,
            traits: ["web"],
        };
    }
    r.register("https", new Http());
    assert.deepEqual(r.manifestFor("https")?.traits, ["web"]);
    assert.equal(r.has("https"), true, "registration is topology; CapabilityResolver owns admission");
});
