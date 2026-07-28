import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "./SchemeRegistry.ts";
import type { SchemeManifest } from "./scheme-types.ts";

const manifest = (name: string): SchemeManifest => ({
    name,
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    scope: "workspace",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

const handler = (name: string, behavior: object = {}): object => ({ manifest: manifest(name), ...behavior });

// discoverExternal scans cwd/node_modules/@plurnk for plurnk.kind:"scheme"
// siblings. @plurnk/plurnk-schemes-http is installed, so it's found, registered
// by its declared name ("http"). Agnostic by kind — the package name is never
// hardcoded (#195).
test("SchemeRegistry.discoverExternal registers the http sibling (#195)", async () => {
    const registry = new SchemeRegistry();
    assert.equal(registry.has("http"), false, "not registered until discovery runs");

    await registry.discoverExternal();

    assert.equal(registry.has("http"), true, "the external http sibling is discovered + registered");
});

// #240 — the built-in scheme names are reserved namespace-wide; a discovered executor
// claiming one fails the boot HARD rather than being silently shadowed (in-tree precedence
// hid a collision that, for a security-relevant name like file/run, must surface loudly).
type RegistryArg = Parameters<SchemeRegistry["registerRuntimeSchemes"]>[0];

test("registerRuntimeSchemes: an executor tag shadowing a reserved built-in fails hard (#240)", () => {
    const registry = new SchemeRegistry();
    const shadows = { availableRuntimes: () => ["file"], entry: () => ({ executor: { manifest: { name: "file", channels: {}, defaultChannel: "body" } } }) } as unknown as RegistryArg;
    assert.throws(
        () => registry.registerRuntimeSchemes(shadows),
        /collides with a reserved built-in/,
        "a runtime tag claiming 'file' must fail-hard, never silently shadow the built-in",
    );
});

test("registerRuntimeSchemes: a non-reserved executor tag registers its own per-tag face (#240)", () => {
    const registry = new SchemeRegistry();
    const real = {
        availableRuntimes: () => ["sh"],
        entry: () => ({ executor: { manifest: manifest("sh") } }),
    } as unknown as RegistryArg;
    registry.registerRuntimeSchemes(real);
    assert.ok(registry.has("sh"), "the sh per-tag face is registered under its tag");
});

test("registerRuntimeSchemes: a tag colliding with an already-claimed (non-reserved) scheme fails hard — one name, one owner (#240)", () => {
    const registry = new SchemeRegistry();
    registry.register("figma", handler("figma")); // an external scheme sibling claims the name first
    const collides = { availableRuntimes: () => ["figma"], entry: () => ({ executor: { manifest: { name: "figma", channels: {}, defaultChannel: "results" } } }) } as unknown as RegistryArg;
    assert.throws(
        () => registry.registerRuntimeSchemes(collides),
        /one name, one owner/,
        "a runtime tag colliding with an external scheme must fail-hard, not silently first-wins-skip (cross-family namespace)",
    );
});

test("registerRuntimeSchemes: re-scanning the same runtime tag is idempotent, not a collision (#240)", () => {
    const registry = new SchemeRegistry();
    const real = {
        availableRuntimes: () => ["sh"],
        entry: () => ({ executor: { manifest: manifest("sh") } }),
    } as unknown as RegistryArg;
    registry.registerRuntimeSchemes(real);
    assert.doesNotThrow(() => registry.registerRuntimeSchemes(real), "a second scan of an already-registered runtime tag skips (idempotent re-scan), never throws");
    assert.ok(registry.has("sh"));
});

test("close: closes each unique resource-owning handler exactly once", async () => {
    const registry = new SchemeRegistry();
    let closes = 0;
    registry.register("resource-a", handler("resource-a", { async close() { closes++; } }));
    registry.register("stateless", handler("stateless"));

    await registry.close();

    assert.equal(closes, 1, "each resource-owning handler closes once");
});

test("ready: verifies each unique resource-owning handler exactly once", async () => {
    const registry = new SchemeRegistry();
    let probes = 0;
    registry.register("resource-a", handler("resource-a", { async ready() { probes++; } }));
    registry.register("stateless", handler("stateless"));

    await registry.ready();

    assert.equal(probes, 1, "each resource-owning handler is probed once");
});

test("register requires one identity-matched static or instance manifest", () => {
    const registry = new SchemeRegistry();
    assert.throws(() => registry.register("missing", {}), /must declare a static or instance manifest/);
    assert.throws(() => registry.register("expected", handler("other")), /identity mismatch/);
    assert.doesNotThrow(() => registry.register("dynamic", handler("dynamic")));
});

// #240 — PLURNK_SERVICE_DOCS_EXCLUDE drops a name from BOTH the teaching oneliner and the materialized
// pull-doc, on load. A non-listed name is untouched; a stray name is inert (a filter, not a contract).
test("teach()/docs(): PLURNK_SERVICE_DOCS_EXCLUDE drops the oneliner + the doc; stray names inert (#240)", () => {
    const registry = new SchemeRegistry();
    const prior = process.env.PLURNK_SERVICE_DOCS_EXCLUDE;
    try {
        process.env.PLURNK_SERVICE_DOCS_EXCLUDE = "log,nonsuch";
        const teaching = registry.teach();
        assert.doesNotMatch(teaching, /log:\/\/\//, "an excluded scheme contributes no oneliner");
        assert.match(teaching, /worker:\/\/\/notes\.md/, "a non-excluded scheme still teaches (stray 'nonsuch' is inert)");
        assert.equal(registry.docs().find((d) => d.name === "log"), undefined, "an excluded scheme materializes no doc");
        assert.ok(registry.docs().find((d) => d.name === "worker"), "a non-excluded scheme still materializes its doc");

        process.env.PLURNK_SERVICE_DOCS_EXCLUDE = "";
        assert.match(registry.teach(), /log:\/\/\//, "cleared exclude → log teaches again");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_DOCS_EXCLUDE;
        else process.env.PLURNK_SERVICE_DOCS_EXCLUDE = prior;
    }
});
