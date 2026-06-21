import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "./SchemeRegistry.ts";

// discoverExternal scans cwd/node_modules/@plurnk for plurnk.kind:"scheme"
// siblings. @plurnk/plurnk-schemes-http is installed, so it's found, registered
// by its declared name ("http"), and flagged external (gets the DB-free
// SchemeCtx). Agnostic by kind — the package name is never hardcoded (#195).
test("SchemeRegistry.discoverExternal registers the http sibling, marked external (#195)", async () => {
    const registry = new SchemeRegistry();
    assert.equal(registry.has("http"), false, "not registered until discovery runs");

    await registry.discoverExternal();

    assert.equal(registry.has("http"), true, "the external http sibling is discovered + registered");
    assert.equal(registry.isExternal("http"), true, "marked external → the engine wraps its ctx in SchemeCtxImpl");
    assert.equal(registry.isExternal("file"), false, "in-tree schemes are never external");
});

// #240 — the built-in scheme names are reserved namespace-wide; a discovered executor
// claiming one fails the boot HARD rather than being silently shadowed (in-tree precedence
// hid a collision that, for a security-relevant name like file/run, must surface loudly).
type RegistryArg = Parameters<SchemeRegistry["registerRuntimeSchemes"]>[0];

test("registerRuntimeSchemes: an executor tag shadowing a reserved built-in fails hard (#240)", () => {
    const registry = new SchemeRegistry();
    const shadows = { availableRuntimes: () => ["file"] } as unknown as RegistryArg;
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
        entry: () => ({ executor: { manifest: { name: "sh", channels: {}, defaultChannel: "stdout" } } }),
    } as unknown as RegistryArg;
    registry.registerRuntimeSchemes(real);
    assert.ok(registry.has("sh"), "the sh per-tag face is registered under its tag");
});
