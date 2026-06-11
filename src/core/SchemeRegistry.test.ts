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
